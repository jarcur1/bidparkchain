import { test, expect } from './fixtures.mjs';
import { selectWallet } from './helpers.mjs';

// Signing in moves no funds, so sharing accounts with the other specs on this stack is harmless.
test('signs in with a local wallet, survives a reload, and signs out on account switch', async ({ page, stack }) => {
  await page.goto(stack.webUrl);
  await selectWallet(page, 3);
  const header = page.getByRole('banner');
  const openWallet = () => header.getByTitle('Switch local test account or connect browser wallet').click();
  const dialog = page.getByRole('dialog', { name: 'Connect & Switch Wallet' });
  const signIn = dialog.getByRole('group', { name: 'App sign-in' });

  await openWallet();
  await expect(signIn).toContainText('Not signed in');
  await signIn.getByRole('button', { name: 'Sign in with this wallet' }).click();
  await expect(signIn.getByRole('status')).toContainText('Signed in as');

  await page.reload();
  await openWallet();
  await expect(signIn.getByRole('status')).toContainText('Signed in as');

  await dialog.getByRole('button', { name: /Account #2 \(/ }).click();
  await expect(signIn.getByRole('alert')).toHaveText('Signed out because the wallet account or network changed.');
  await expect(signIn).toContainText('Not signed in');
  expect((await page.request.get(`${stack.webUrl}/api/auth/session`)).status()).toBe(401);
});
