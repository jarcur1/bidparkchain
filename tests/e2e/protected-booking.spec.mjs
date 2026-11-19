import { ethers } from 'ethers';
import { test, expect } from './fixtures.mjs';
import { advancePast, bid, selectWallet } from './helpers.mjs';
import { signInCookie } from '../support/auth.mjs';

const HOST = 0, WINNER = 1, RESOLVER = 2;
const TIME_ZONE = 'UTC';
const metadata = {
  title: 'Protected garage bay', description: 'Covered bay behind the garage.',
  image: '/images/driveway.jpg',
};
const EVIDENCE = 'The gate was chained shut and nobody answered. Photo: https://example.com/gate.jpg';
const REASON = 'The photo shows the gate chained during the booked window.';

test.use({ scenario: 'campus-baseline', isolatedStack: 'protected-booking', timezoneId: TIME_ZONE });

const localInput = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 16);

async function signIn(page, index) {
  await selectWallet(page, index);
  const dialog = page.getByRole('dialog', { name: 'Connect & Switch Wallet' });
  await page.getByRole('banner').getByTitle('Switch local test account or connect browser wallet').click();
  await dialog.getByRole('button', { name: 'Sign in with this wallet' }).click();
  await expect(dialog.getByRole('group', { name: 'App sign-in' }).getByRole('status')).toContainText('Signed in as');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
}

test('a host creates a protected booking and a resolver refunds the driver after seller failure', async ({ page, stack }) => {
  const { chain, descriptor, apiUrl } = stack;
  const escrow = (index) => new ethers.Contract(descriptor.contractAddress, descriptor.abi, chain.wallet(index));

  // The host lists a protected auction from the My Activity workspace.
  await (await escrow(0).setResolver(chain.wallet(RESOLVER).address, true)).wait();
  const id = (await escrow(0).nextAuctionId()).toString();
  const now = await chain.latestTimestamp();
  const cutoff = Math.ceil((now + 3600) / 60) * 60; // minute-aligned, an hour from chain time
  const shortStart = cutoff + 29 * 60, start = cutoff + 30 * 60, end = start + 3600;

  await page.goto(stack.webUrl);
  await signIn(page, HOST);
  await page.getByRole('button', { name: 'My Activity' }).click();
  const form = page.getByTestId('host-workspace').locator('form.workspace-form');
  await form.getByLabel('Draft name').fill('Protected garage bay');
  await form.getByLabel('Title', { exact: true }).fill(metadata.title);
  await form.getByLabel('Location preset').selectOption({ index: 1 });
  await form.getByLabel('Public description').fill(metadata.description);
  await form.getByLabel('Photo URL (https) or local path').fill(metadata.image);
  await form.getByLabel('Minimum bid (ETH)').fill('0.01');
  await expect(form.getByTestId('schedule-zone')).toContainText(TIME_ZONE);
  await form.getByLabel('Bidding cutoff').fill(localInput(cutoff));
  await form.getByLabel('Parking starts').fill(localInput(shortStart));
  await form.getByLabel('Parking ends').fill(localInput(end));
  const protectionOption = form.getByRole('checkbox', { name: /Protected booking/i });
  await protectionOption.check();
  const publish = form.getByRole('button', { name: 'Sign and create auction' });
  await expect(form.getByTestId('schedule-problem')).toContainText(/at least 30 minutes/i);
  await expect(publish).toBeDisabled();
  await form.getByLabel('Parking starts').fill(localInput(start)); // exactly MIN_BID_LEAD
  await expect(form.getByTestId('schedule-problem')).toHaveCount(0);
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect(page.getByRole('article', { name: `Listing: ${metadata.title}`, exact: true })).toBeVisible();
  await expect.poll(() => escrow(HOST).nextAuctionId()).toBe(BigInt(id) + 1n);
  const created = await escrow(0).auctions(id);
  expect(Number(created.bidEnd)).toBe(cutoff);
  expect(Number(created.parkingStart)).toBe(start);
  expect((await escrow(0).bookings(id)).isProtected).toBe(true);
  const bidEnd = cutoff, parkingEnd = end;

  // The driver wins it in the app, and it is settled before parking starts.
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
