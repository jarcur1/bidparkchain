import { ethers } from 'ethers';
import { test, expect } from './fixtures.mjs';
import { advancePast, selectWallet } from './helpers.mjs';

const HOST = 3, WINNER = 1;

test.use({ scenario: 'campus-baseline', isolatedStack: 'inbox-payout' });

test('the host is told, once and politely, when a payout becomes claimable', async ({ page, stack }) => {
  const { chain, descriptor } = stack;
  const escrow = new ethers.Contract(descriptor.contractAddress, descriptor.abi, chain.provider);
  const as = (index) => escrow.connect(chain.wallet(index));
  const bidEnd = (await chain.latestTimestamp()) + 900;
  const start = bidEnd + 3600;
  const end = start + 3600;
  const id = (await escrow.nextAuctionId()).toString();
  await (await as(HOST).createProtectedAuction(0, ethers.id('payout-e2e'), ethers.parseEther('0.01'), bidEnd, start, end)).wait();
  await (await as(WINNER).bid(id, { value: ethers.parseEther('0.02') })).wait();
  await chain.increaseTime(bidEnd + 1 - (await chain.latestTimestamp()));
  await (await as(HOST).settle(id)).wait();

  await page.goto(stack.webUrl);
  await selectWallet(page, HOST);
  const dialog = page.getByRole('dialog', { name: 'Connect & Switch Wallet' });
  await page.getByRole('banner').getByTitle('Switch local test account or connect browser wallet').click();
  await dialog.getByRole('button', { name: 'Sign in with this wallet' }).click();
  await expect(dialog.getByRole('group', { name: 'App sign-in' }).getByRole('status')).toContainText('Signed in as');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('banner').getByRole('button', { name: /^Inbox, / }).click();
  const inbox = page.getByTestId('inbox');
  await expect(inbox).toContainText('Inbox (0 unread)', { timeout: 30_000 });
  const live = page.getByTestId('inbox-announcer');
  await expect(live).toHaveAttribute('aria-live', 'polite');
  await expect(live).toHaveText('');

  // Parking is over and the report window has closed: the entry arrives and is announced.
  await advancePast(page, chain, end + 24 * 3600 + 60);
  const ready = inbox.locator('[data-inbox-kind="payout-ready"]');
  await expect(ready).toContainText('The 0.02 ETH payout for auction #' + id + ' is ready to claim.', { timeout: 30_000 });
  await expect(live).toHaveText(/^New notification: The 0.02 ETH payout/);

  // Claiming it replaces the entry; the announcement is not repeated for entries already seen.
  await (await as(HOST).claimPayout(id)).wait();
  await expect(ready).toHaveCount(0, { timeout: 30_000 });
  await expect(inbox.locator('[data-inbox-kind="payout"]')).toContainText('You claimed the 0.02 ETH payout');
});
