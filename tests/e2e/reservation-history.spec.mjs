import { ethers } from 'ethers';
import { test, expect } from './fixtures.mjs';
import { advancePast, selectWallet } from './helpers.mjs';

// Its own stack: this spec bids on and settles several campus spots.
test.use({ scenario: 'campus-baseline', isolatedStack: 'reservation-history' });

test('history shows lifecycle states, block times, search, paging and network-scoped links', async ({ page, stack }) => {
  const { chain, descriptor } = stack;
  const escrow = (index) => new ethers.Contract(descriptor.contractAddress, descriptor.abi, chain.wallet(index));
  const { listings } = await (await fetch(`${stack.apiUrl}/api/listings`)).json();
  const spots = listings.filter((l) => !l.settled && !l.cancelled && Number(l.highestBid) === 0).slice(0, 7);
  expect(spots.length).toBe(7);
  const [lost, won, ...rest] = spots;
  const value = (l) => ({ value: ethers.parseEther((Number(l.minBid) + 0.01).toFixed(3)) });

  await (await escrow(2).bid(lost.id, value(lost))).wait();
  await (await escrow(3).bid(lost.id, { value: ethers.parseEther((Number(lost.minBid) + 0.05).toFixed(3)) })).wait();
  await (await escrow(2).bid(won.id, value(won))).wait();
  for (const spot of rest) await (await escrow(2).bid(spot.id, value(spot))).wait();

  // Two more auctions whose metadata the API does not know: they still appear, without a state.
  const now = await chain.latestTimestamp();
  const lastCutoff = Math.max(...spots.map((s) => s.bidEnd), now + 3600);
  for (const n of [1, 2]) {
    const id = await escrow(0).nextAuctionId();
    await (await escrow(0).createAuction(ethers.id(`history-extra-${n}`), ethers.parseEther('0.01'), now + 3600, now + 7200, now + 10800)).wait();
    await (await escrow(2).bid(id, { value: ethers.parseEther('0.02') })).wait();
  }

  await page.goto(stack.webUrl);
  await selectWallet(page, 2);
  await page.getByRole('button', { name: /My Activity/ }).click();
  const history = page.getByTestId('reservation-history');
  const rowFor = (spot) => history.getByRole('listitem').filter({ hasText: `Auction #${spot.id} ` }).first();

  // Nine auctions, eight per page.
  await expect(history.getByRole('heading')).toContainText('(9)', { timeout: 30_000 });
  await expect(history.getByText('Page 1 of 2')).toBeVisible();
  await history.getByRole('button', { name: 'Next' }).click();
  await expect(history.getByText('Page 2 of 2')).toBeVisible();
  await history.getByRole('button', { name: 'Previous' }).click();

  // Search narrows across pages and matches by title.
  await history.getByRole('searchbox').fill(lost.title);
  await expect(rowFor(lost)).toContainText('Outbid, bidding open');
  await expect(history.getByRole('listitem').filter({ hasText: 'Auction #' })).toHaveCount(1);
  await expect(rowFor(lost)).toContainText(/Times in the parking location's time zone \(\S+\)\.|your time zone \(\S+\)/);
  await rowFor(lost).getByText(/\d events?/).click();
  await expect(rowFor(lost).locator('.bid-history-block').first()).toHaveText(/^\w{3}, \w{3} \d{1,2}, \d{1,2}:\d{2} [AP]M \S+$/);

  // After the cutoffs: the lost auction is lost, the won one awaits settlement, then is upcoming.
  await advancePast(page, chain, lastCutoff);
  await expect(rowFor(lost)).toContainText('Outbid, another bidder won', { timeout: 30_000 });
  await history.getByRole('searchbox').fill(won.title);
  await expect(rowFor(won)).toContainText('Awaiting settlement');
  await (await escrow(0).settle(won.id)).wait();
  await page.getByRole('button', { name: 'Refresh data' }).click();
  await expect(rowFor(won)).toContainText('Upcoming', { timeout: 30_000 });
  await expect(page.getByTestId('lifecycle-label')).toHaveText('Upcoming');

  // A link names the network and contract; another contract is refused, never silently opened.
  const base = `${stack.webUrl}/?tab=activity&chain=${descriptor.chainId}&auction=${won.id}`;
  await page.goto(`${base}&contract=${descriptor.contractAddress.toLowerCase()}`);
  await selectWallet(page, 2);
  await expect(history.getByRole('searchbox')).toHaveValue(`#${won.id}`);
  await expect(history.getByRole('listitem').filter({ hasText: 'Auction #' })).toHaveCount(1);
  await page.goto(`${base}&contract=0x0000000000000000000000000000000000000001`);
  await selectWallet(page, 2);
  await expect(history.getByRole('alert')).toContainText('different network or contract');
  await expect(history.getByRole('searchbox')).toHaveValue('');
});
