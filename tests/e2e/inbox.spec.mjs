import { ethers } from 'ethers';
import { test, expect } from './fixtures.mjs';
import { selectWallet } from './helpers.mjs';

test.use({ scenario: 'campus-baseline', isolatedStack: 'inbox' });

test('shows an outbid from another wallet in the inbox and keeps read state across a reload', async ({ page, stack }) => {
  const { chain, descriptor } = stack;
  const escrow = (index) => new ethers.Contract(descriptor.contractAddress, descriptor.abi, chain.wallet(index));
  const now = await chain.latestTimestamp();
  const id = await escrow(0).nextAuctionId();
  await (await escrow(0).createAuction(ethers.id('inbox-spot'), ethers.parseEther('0.01'), now + 3600, now + 7200, now + 10800)).wait();
  await (await escrow(3).bid(id, { value: ethers.parseEther('0.02') })).wait();
  await (await escrow(4).bid(id, { value: ethers.parseEther('0.05') })).wait();

  await page.goto(stack.webUrl);
  await selectWallet(page, 3);
  const header = page.getByRole('banner');
  const openWallet = () => header.getByTitle('Switch local test account or connect browser wallet').click();
  const dialog = page.getByRole('dialog', { name: 'Connect & Switch Wallet' });
  await openWallet();
  await dialog.getByRole('button', { name: 'Sign in with this wallet' }).click();
  await expect(dialog.getByRole('group', { name: 'App sign-in' }).getByRole('status')).toContainText('Signed in as');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();

  // The API indexes in the background; the inbox polls until the outbid arrives.
  const bell = header.getByRole('button', { name: /^Inbox, / });
  await expect(bell).toHaveAccessibleName('Inbox, 1 unread', { timeout: 30_000 });
  await bell.click();
  const inbox = page.getByTestId('inbox');
  const entry = inbox.getByRole('listitem').filter({ hasText: `You were outbid on auction #${id}` });
  await expect(entry).toContainText('Your 0.02 ETH bid was credited to your refund balance.');
  await expect(inbox.getByRole('heading')).toHaveText('Inbox (1 unread)');

  await entry.getByRole('button', { name: 'Mark read' }).click();
  await expect(bell).toHaveAccessibleName('Inbox, 0 unread');
  await expect(inbox.getByRole('heading')).toHaveText('Inbox (0 unread)');

  await page.reload();
  await expect(bell).toHaveAccessibleName('Inbox, 0 unread');
  await bell.click();
  await expect(entry).toBeVisible();
  await expect(entry.getByRole('button', { name: 'Mark read' })).toHaveCount(0);
});
