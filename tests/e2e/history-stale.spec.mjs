import { readFile } from 'node:fs/promises';
import { ethers } from 'ethers';
import { test, expect } from './fixtures.mjs';
import { selectWallet } from './helpers.mjs';

// Its own stack: this spec creates and bids on an auction.
test.use({ scenario: 'campus-baseline', isolatedStack: 'history-stale' });

test('history keeps contract-derived states when the index goes stale, and opens an unregistered auction', async ({ page, stack }) => {
  const { chain, descriptor } = stack;
  const escrow = (index) => new ethers.Contract(descriptor.contractAddress, descriptor.abi, chain.wallet(index));
  const now = await chain.latestTimestamp();
  const id = String(await escrow(0).nextAuctionId());
  await (await escrow(0).createAuction(ethers.id('history-stale'), ethers.parseEther('0.01'), now + 3600, now + 7200, now + 10800)).wait();
  await (await escrow(2).bid(id, { value: ethers.parseEther('0.02') })).wait();

  await page.goto(stack.webUrl);
  await selectWallet(page, 2);
  await page.getByRole('button', { name: /My Activity/ }).click();
  const history = page.getByTestId('reservation-history');
  const row = history.getByRole('listitem').filter({ hasText: `Auction #${id} ` }).first();
  await expect(row).toContainText('Leading', { timeout: 30_000 });
  await expect(history).not.toContainText('out of date');

  // The index stops answering: the earlier read is kept and labelled, never shown as current or empty.
  await page.route('**/api/accounts/*/history', (route) => route.fulfill({ status: 503, json: { error: 'index down' } }));
  await expect(history.getByRole('status')).toContainText('History may be out of date', { timeout: 30_000 });
  await expect(row).toContainText('Leading');
  await expect(history.getByText('No bids or reservations yet')).toHaveCount(0);

  // An auction with no registered details still opens its detail view and exports its event.
  await row.getByRole('button', { name: 'View Details' }).click();
  const detail = page.getByRole('dialog', { name: `Auction #${id}` });
  await expect(detail).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), detail.getByRole('button', { name: 'Add to calendar (.ics)' }).click()]);
  const ics = await readFile(await download.path(), 'utf8');
  expect(ics).toContain('STATUS:TENTATIVE\r\n');
  expect(ics).toContain(`UID:${descriptor.chainId}-${descriptor.contractAddress.toLowerCase()}-${id}@bidpark`);
  const sequenceOf = (text) => Number(text.match(/SEQUENCE:(\d+)/)[1]);
  const firstSequence = sequenceOf(ics);
  expect(firstSequence).toBeGreaterThan(0);

  // Re-bidding an unregistered auction resolves it from the fresh unindexed read, and the next export
  // carries a later snapshot block under the same UID.
  await detail.getByRole('button', { name: 'Place Higher Bid' }).click();
  const bidDialog = page.getByRole('dialog').filter({ has: page.getByLabel('Your New Bid Amount (ETH)') });
  await bidDialog.getByLabel('Your New Bid Amount (ETH)').fill('0.03');
  await bidDialog.getByRole('button', { name: 'Deposit 0.03 ETH', exact: true }).click();
  await expect(bidDialog).toBeHidden({ timeout: 30_000 });
  await expect.poll(async () => (await escrow(2).auctions(id)).highestBid).toBe(ethers.parseEther('0.03'));
  await row.getByRole('button', { name: 'View Details' }).click();
  await expect(detail).toContainText('0.03', { timeout: 30_000 });
  await expect.poll(async () => {
    const [again] = await Promise.all([page.waitForEvent('download'), detail.getByRole('button', { name: 'Add to calendar (.ics)' }).click()]);
    return sequenceOf(await readFile(await again.path(), 'utf8'));
  }, { timeout: 30_000 }).toBeGreaterThan(firstSequence);
});
