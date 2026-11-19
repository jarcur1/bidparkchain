import { ethers } from 'ethers';
import { test, expect } from './fixtures.mjs';
import { advancePast, selectWallet } from './helpers.mjs';
import { signInCookie } from '../support/auth.mjs';
import { validateSpotMetadata } from '../../shared/validation.js';

const HOST = 3, WINNER = 1;
const metadata = {
  title: 'Inbox booking driveway', address: '41 Arrival Lane', neighborhood: 'Hyde Park',
  latitude: 30.3, longitude: -97.73, description: 'Driveway space next to the house.',
  image: '/images/driveway.jpg', kind: 'driveway', amenities: [],
};

test.use({ scenario: 'campus-baseline', isolatedStack: 'inbox-bookings' });

async function signIn(page, index) {
  await selectWallet(page, index);
  const dialog = page.getByRole('dialog', { name: 'Connect & Switch Wallet' });
  await page.getByRole('banner').getByTitle('Switch local test account or connect browser wallet').click();
  await dialog.getByRole('button', { name: 'Sign in with this wallet' }).click();
  await expect(dialog.getByRole('group', { name: 'App sign-in' }).getByRole('status')).toContainText('Signed in as');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
}

test('reservation, check-in and booking entries reach the right wallet, with dismiss and preferences kept across reloads', async ({ page, stack }) => {
  const { chain, descriptor, apiUrl } = stack;
  const escrow = new ethers.Contract(descriptor.contractAddress, descriptor.abi, chain.provider);
  const as = (index) => escrow.connect(chain.wallet(index));
  const hash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(validateSpotMetadata(metadata).normalized)));
  const bidEnd = (await chain.latestTimestamp()) + 900;
  const start = bidEnd + 3600;
  const id = (await escrow.nextAuctionId()).toString();
  await (await as(HOST).createProtectedAuction(0, hash, ethers.parseEther('0.01'), bidEnd, start, start + 7200)).wait();
  const hostCookie = await signInCookie(apiUrl, chain.wallet(HOST));
  const post = (route, body) => fetch(`${apiUrl}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie: hostCookie }, body: JSON.stringify(body),
  });
  expect((await post('/api/listings', { auctionId: id, metadata })).status).toBe(201);
  expect((await post(`/api/auctions/${id}/arrival`, { instructions: 'Gate code 5512' })).status).toBe(200);
  await (await as(WINNER).bid(id, { value: ethers.parseEther('0.02') })).wait();
  await chain.increaseTime(bidEnd + 1 - (await chain.latestTimestamp()));
  await (await as(HOST).settle(id)).wait();

  // Ten minutes before parking starts the winner has upcoming and arrival entries, without the text.
  await page.goto(stack.webUrl);
  await advancePast(page, chain, start - 600);
  await signIn(page, WINNER);
  const bell = page.getByRole('banner').getByRole('button', { name: /^Inbox, / });
  await bell.click();
  const inbox = page.getByTestId('inbox');
  const arrival = inbox.locator('[data-inbox-kind="arrival"]');
  await expect(arrival).toContainText(`Arrival instructions for "${metadata.title}" are available.`, { timeout: 30_000 });
  await expect(inbox.locator('[data-inbox-kind="upcoming"]')).toContainText(`Your reservation at "${metadata.title}" starts`);
  await expect(inbox).not.toContainText('5512');
  await arrival.getByRole('button', { name: 'Arrival details' }).click();
  const panel = page.getByTestId('arrival-panel');
  await panel.getByRole('button', { name: 'Show arrival instructions' }).click();
  await panel.getByRole('button', { name: 'Check in' }).click();
  await expect(panel.getByTestId('arrival-checkin')).toContainText('Checked in at');
  await page.getByRole('button', { name: 'Close dialog' }).first().click();

  // Hiding a category is saved for this wallet.
  await inbox.getByText('Notification preferences').click();
  await inbox.getByLabel('Upcoming reservations and check-ins').click(); // saved, then shown from the response
  await expect(inbox.getByLabel('Upcoming reservations and check-ins')).not.toBeChecked();
  await expect(inbox.locator('[data-inbox-kind="arrival"]')).toHaveCount(0);
  await page.reload();
  await bell.click();
  await expect(inbox.locator('[data-inbox-kind="won"]')).toBeVisible();
  await expect(inbox.locator('[data-inbox-kind="arrival"]')).toHaveCount(0);

  // The host hears about the check-in, and a dismissed entry stays dismissed.
  await signIn(page, HOST);
  await bell.click();
  const checkIn = inbox.locator('[data-inbox-kind="checked-in"]');
  await expect(checkIn).toContainText(`The winner checked in for "${metadata.title}"`, { timeout: 30_000 });
  await expect(inbox.locator('[data-inbox-kind="arrival"]')).toHaveCount(0);
  await checkIn.getByRole('button', { name: 'Dismiss' }).click();
  await expect(checkIn).toHaveCount(0);

  // A no-show the host records shows up as a booking change with a link to the auction's history.
  await advancePast(page, chain, start + 1800);
  await (await as(HOST).recordNoShow(id)).wait();
  const noShow = inbox.locator('[data-inbox-kind="booking"]');
  await expect(noShow).toContainText(`You recorded a no-show for "${metadata.title}".`, { timeout: 30_000 });
  await expect(noShow.getByRole('link', { name: 'History' })).toHaveAttribute('href', new RegExp(`auction=${id}$`));
  await page.reload();
  await bell.click();
  await expect(noShow).toBeVisible();
  await expect(checkIn).toHaveCount(0);
});
