import { Contract, parseEther } from 'ethers';
import { test, expect } from './fixtures.mjs';

async function selectWallet(page, index) {
  const header = page.getByRole('banner');
  const connect = header.getByRole('button', { name: /Connect Wallet/ });
  if (await connect.count()) await connect.click();
  else await header.getByTitle('Switch local test account or connect browser wallet').click();
  const dialog = page.getByRole('dialog', { name: 'Connect & Switch Wallet' });
  const account = dialog.getByRole('button', { name: new RegExp(`Account #${index} \\(`) });
  await account.click();
  await expect(account.getByText('Active', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(header.getByRole('button', { name: new RegExp(`Account #${index} \\(`) })).toBeVisible();
}

async function bid(page, title, amount) {
  await page.getByRole('button', { name: 'Discover Spots', exact: true }).click();
  const card = page.getByRole('article', { name: `Listing: ${title}`, exact: true });
  await card.getByRole('button', { name: 'Bid Now' }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByLabel('Your New Bid Amount (ETH)') });
  await dialog.getByLabel('Your New Bid Amount (ETH)').fill(amount);
  await dialog.getByRole('button', { name: `Deposit ${amount} ETH`, exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(card.getByText('Highest Bid', { exact: true })).toBeVisible();
  await expect(card.locator('.bid-amount')).toHaveText(Number(amount).toFixed(3));
}

async function advancePast(page, chain, timestamp) {
  const latest = await chain.provider.send('eth_getBlockByNumber', ['latest', false]);
  const seconds = Number(timestamp) + 1 - Number(BigInt(latest.timestamp));
  if (seconds > 0) await chain.increaseTime(seconds);
  const block = await chain.provider.send('eth_getBlockByNumber', ['latest', false]);
  // The UI gates settlement/payout using Date.now(), so keep its clock aligned
  // with our explicitly advanced chain without waiting for real deadlines.
  await page.clock.setFixedTime(new Date(Number(BigInt(block.timestamp)) * 1000));
  await page.getByRole('button', { name: 'Refresh data' }).click();
}

test('host lists, drivers bid and refund, winner reserves, host receives payout', async ({ page, stack }) => {
  const { chain, descriptor } = stack;
  const escrow = new Contract(descriptor.contractAddress, descriptor.abi, chain.provider);
  const auctionId = await escrow.nextAuctionId();
  const title = 'E2E covered driveway near downtown';
  const address = '70 Rainey St, Austin, TX 78701';
  await page.clock.install();
  await page.goto(stack.webUrl);
  await selectWallet(page, 0);
  await page.getByRole('button', { name: 'List a Spot' }).click();
  const create = page.getByRole('dialog').filter({ has: page.getByLabel('Listing Title') });
  await create.getByLabel('Listing Title').fill(title);
  await create.getByLabel('Parking Space Kind').selectOption('covered');
  await create.getByLabel('Street Address').fill(address);
  await create.getByLabel('Public space description').fill('Covered concrete driveway with good lighting and 2.1 m clearance.');
  await create.getByLabel('Opening Min Bid (ETH)').fill('0.05');
  await create.getByLabel('Bidding Cutoff').selectOption('15');
  await create.getByLabel('Parking Window').selectOption('immediate-2h');
  await create.getByRole('button', { name: 'Review public listing', exact: true }).click();
  await expect(create.getByRole('heading', { name: 'Review public listing before signing' })).toBeFocused();
  expect(await escrow.nextAuctionId()).toBe(auctionId);
  await create.getByRole('button', { name: 'Confirm and Deploy Auction', exact: true }).click();
  await expect(create).toBeHidden();
  await expect(page.getByRole('article', { name: `Listing: ${title}`, exact: true })).toBeVisible();
  let auction = await escrow.auctions(auctionId);
  expect(auction.owner).toBe(chain.wallet(0).address);
  expect(auction.minBid).toBe(parseEther('0.05'));

  await selectWallet(page, 2);
  await bid(page, title, '0.06');
  expect((await escrow.auctions(auctionId)).highestBidder).toBe(chain.wallet(2).address);
  await selectWallet(page, 1);
  await bid(page, title, '0.08');
  expect((await escrow.auctions(auctionId)).highestBid).toBe(parseEther('0.08'));

  await selectWallet(page, 2);
  await page.getByRole('button', { name: /My Activity/ }).click();
  await expect(page.getByText('Available to Withdraw:', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Withdraw 0.060 ETH', exact: true })).toBeVisible();
  expect(await escrow.pendingReturns(chain.wallet(2).address)).toBe(parseEther('0.06'));
  await page.getByRole('button', { name: 'Withdraw 0.060 ETH', exact: true }).click();
  await expect(page.getByText('No pending refunds', { exact: true })).toBeVisible();
  expect(await escrow.pendingReturns(chain.wallet(2).address)).toBe(0n);

  await selectWallet(page, 1);
  await advancePast(page, chain, auction.bidEnd);
  await expect(page.getByRole('heading', { name: /Won Auctions — Settle to Confirm Reservation/ })).toBeVisible();
  await page.getByRole('button', { name: 'Settle Auction & Claim Pass', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Confirmed Reservations (1)', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByText('BidPark Escrow Pass', { exact: true })).toBeVisible();
  auction = await escrow.auctions(auctionId);
  expect(auction.settled).toBe(true);
  expect(auction.highestBidder).toBe(chain.wallet(1).address);
  expect(auction.payoutClaimed).toBe(false);

  await advancePast(page, chain, auction.parkingEnd);
  await selectWallet(page, 0);
  const hosted = page.locator('.hosted-spot-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await hosted.getByRole('button', { name: 'Claim Payout', exact: true }).click();
  await expect(hosted.getByText('Payout Claimed', { exact: true })).toBeVisible();
  expect((await escrow.auctions(auctionId)).payoutClaimed).toBe(true);
});
