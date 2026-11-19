import { ethers } from 'ethers';
import { test, expect } from './fixtures.mjs';
import { advancePast, bid, selectWallet } from './helpers.mjs';
import { signInCookie } from '../support/auth.mjs';
import { validateSpotMetadata } from '../../shared/validation.js';

const HOST = 0, WINNER = 1, RESOLVER = 2;
const metadata = {
  title: 'Protected garage bay', address: '12 Guadalupe St', neighborhood: 'West Campus',
  latitude: 30.29, longitude: -97.74, description: 'Covered bay behind the garage.',
  image: '/images/driveway.jpg', kind: 'garage', amenities: [],
};
const EVIDENCE = 'The gate was chained shut and nobody answered. Photo: https://example.com/gate.jpg';
const REASON = 'The photo shows the gate chained during the booked window.';

test.use({ scenario: 'campus-baseline', isolatedStack: 'protected-booking' });

async function signIn(page, index) {
  await selectWallet(page, index);
  const dialog = page.getByRole('dialog', { name: 'Connect & Switch Wallet' });
  await page.getByRole('banner').getByTitle('Switch local test account or connect browser wallet').click();
  await dialog.getByRole('button', { name: 'Sign in with this wallet' }).click();
  await expect(dialog.getByRole('group', { name: 'App sign-in' }).getByRole('status')).toContainText('Signed in as');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
}

test('a driver wins a protected booking, reports the host, and a resolver refunds them', async ({ page, stack }) => {
  const { chain, descriptor, apiUrl } = stack;
  const escrow = (index) => new ethers.Contract(descriptor.contractAddress, descriptor.abi, chain.wallet(index));

  // The host lists a protected auction (the app does not create these yet) and registers its metadata.
  await (await escrow(0).setResolver(chain.wallet(RESOLVER).address, true)).wait();
  const id = (await escrow(0).nextAuctionId()).toString();
  const now = await chain.latestTimestamp();
  const bidEnd = now + 3600, parkingStart = bidEnd + 3600, parkingEnd = parkingStart + 3600;
  const hash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(validateSpotMetadata(metadata).normalized)));
  await (await escrow(HOST).createProtectedAuction(0, hash, ethers.parseEther('0.01'), bidEnd, parkingStart, parkingEnd)).wait();
  const registered = await fetch(`${apiUrl}/api/listings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: await signInCookie(apiUrl, chain.wallet(HOST)) },
    body: JSON.stringify({ auctionId: id, metadata }),
  });
  expect(registered.status).toBe(201);

  // The driver wins it in the app, and it is settled before parking starts.
  await page.goto(stack.webUrl);
  await selectWallet(page, WINNER);
  await bid(page, metadata.title, '0.05');
  await advancePast(page, chain, bidEnd);
  await (await escrow(0).settle(id)).wait();
  await advancePast(page, chain, parkingEnd);

  // The driver reports a seller failure with evidence that stays off-chain.
  await signIn(page, WINNER);
  const card = page.getByRole('article', { name: `Listing: ${metadata.title}`, exact: true });
  await card.getByRole('button', { name: 'Details', exact: true }).click();
  const protection = page.getByTestId('booking-protection');
  const report = protection.getByRole('button', { name: 'Report seller failure' });
  await expect(report).toBeDisabled();
  await protection.getByLabel('Review text').fill(EVIDENCE);
  await report.click();
  await expect(protection).toContainText('A seller-failure report is open');
  await expect(protection.getByTestId('dispute-record')).toContainText(EVIDENCE);
  expect((await escrow(0).bookings(id)).disputeReporter).toBe(chain.wallet(WINNER).address);
  const onChain = await chain.provider.getLogs({ address: descriptor.contractAddress });
  expect(JSON.stringify(onChain)).not.toContain(Buffer.from('chained').toString('hex'));
  await page.keyboard.press('Escape');

  // Someone outside the booking cannot read the record.
  const outsider = await signInCookie(apiUrl, chain.wallet(6));
  expect((await fetch(`${apiUrl}/api/auctions/${id}/dispute`, { headers: { cookie: outsider } })).status).toBe(403);

  // The resolver sees it in the queue with its deadline, reads it, and upholds it.
  await signIn(page, RESOLVER);
  await page.getByRole('button', { name: 'My Activity' }).click();
  const item = page.getByTestId('resolver-queue').getByRole('listitem').filter({ hasText: `Auction #${id}` });
  await expect(item).toContainText('Decide by');
  await item.getByRole('button', { name: 'Read record' }).click();
  await expect(item.getByTestId('dispute-record')).toContainText(EVIDENCE);
  const uphold = item.getByRole('button', { name: /Uphold report/ });
  await expect(uphold).toBeDisabled();
  await item.getByLabel(`Decision reason for auction ${id}`).fill(REASON);
  await uphold.click();
  await expect(page.getByTestId('resolver-queue')).toContainText('No open seller-failure reports.');

  const booking = await escrow(0).bookings(id);
  expect(booking.outcome).toBe(4n); // DisputeUpheld
  expect(await escrow(0).pendingReturns(chain.wallet(WINNER).address)).toBe(ethers.parseEther('0.05'));
  const record = await (await fetch(`${apiUrl}/api/auctions/${id}/dispute`, { headers: { cookie: await signInCookie(apiUrl, chain.wallet(WINNER)) } })).json();
  expect(record.records.map((r) => r.kind)).toEqual(['report', 'decision']);
  expect(record.records[1].body).toBe(REASON);
});
