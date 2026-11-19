import { test, expect } from './fixtures.mjs';

// No transactions: these only open dialogs, so sharing the Austin stack with other specs is harmless.
test('returns users to the bid or listing they started after connecting a wallet', async ({ page, stack }) => {
  await page.goto(stack.webUrl);
  const wallets = page.getByRole('dialog', { name: 'Connect & Switch Wallet' });

  const card = page.getByRole('article', { name: /^Listing: / }).filter({ has: page.getByRole('button', { name: 'Bid Now' }) }).first();
  const title = (await card.getAttribute('aria-label')).replace(/^Listing: /, '');
  await card.getByRole('button', { name: 'Bid Now' }).click();
  await expect(wallets.getByText(`Connect a wallet to bid on ${title}.`)).toBeVisible();
  await wallets.getByRole('button', { name: /Account #3 \(/ }).click();
  await expect(wallets).toBeHidden();
  const bid = page.getByRole('dialog').filter({ has: page.getByLabel('Your New Bid Amount (ETH)') });
  await expect(bid).toBeVisible();
  await expect(bid).toContainText(title);
  await page.keyboard.press('Escape');

  // Disconnect, then start a listing: it resumes in the create form.
  await page.getByRole('banner').getByTitle('Switch local test account or connect browser wallet').click();
  await wallets.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await wallets.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'List a Spot' }).click();
  await expect(wallets.getByText('Connect a wallet to list a spot.')).toBeVisible();
  await wallets.getByRole('button', { name: /Account #0 \(/ }).click();
  await expect(wallets).toBeHidden();
  await expect(page.getByLabel('Listing Title')).toBeVisible();
});

test('closing the wallet dialog without connecting drops the pending action', async ({ page, stack }) => {
  await page.goto(stack.webUrl);
  await page.getByRole('button', { name: 'List a Spot' }).click();
  const wallets = page.getByRole('dialog', { name: 'Connect & Switch Wallet' });
  await wallets.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('banner').getByRole('button', { name: /Connect Wallet/ }).click();
  await expect(wallets.getByText(/Connect a wallet to/)).toHaveCount(0);
  await wallets.getByRole('button', { name: /Account #1 \(/ }).click();
  await expect(wallets.getByText('Connected and ready')).toBeVisible();
  await expect(page.getByLabel('Listing Title')).toHaveCount(0);
});
