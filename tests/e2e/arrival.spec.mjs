import { ethers } from 'ethers';
import { test, expect } from './fixtures.mjs';
import { advancePast, selectWallet } from './helpers.mjs';
import { signInCookie } from '../support/auth.mjs';
import { validateSpotMetadata } from '../../shared/validation.js';

const HOST = 3, WINNER = 1, OUTBID = 2;
const SECRET = 'Gate code 4471. Second door on the left.';
const metadata = {
  title: 'Arrival test driveway', address: '40 Arrival Lane', neighborhood: 'Hyde Park',
  latitude: 30.3, longitude: -97.73, description: 'Driveway space next to the house.',
  image: '/images/driveway.jpg', kind: 'driveway', amenities: [],
};

test.use({ scenario: 'campus-baseline', isolatedStack: 'arrival' });

async function signIn(page, index) {
  await selectWallet(page, index);
  const dialog = page.getByRole('dialog', { name: 'Connect & Switch Wallet' });
  await page.getByRole('banner').getByTitle('Switch local test account or connect browser wallet').click();
  await dialog.getByRole('button', { name: 'Sign in with this wallet' }).click();
  await expect(dialog.getByRole('group', { name: 'App sign-in' }).getByRole('status')).toContainText('Signed in as');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
}

async function openHostedListing(page) {
  await page.getByRole('button', { name: /My Activity/ }).click();
  await page.locator('.hosted-spot-card').filter({ hasText: metadata.title }).getByRole('button', { name: 'View', exact: true }).click();
  return page.getByTestId('arrival-panel');
}

test('the host stores private arrival instructions and the winner reads them and checks in', async ({ page, stack }) => {
  const { chain, descriptor, apiUrl } = stack;
  const escrow = new ethers.Contract(descriptor.contractAddress, descriptor.abi, chain.provider);
  const as = (index) => escrow.connect(chain.wallet(index));
  const hash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(validateSpotMetadata(metadata).normalized)));
  const bidEnd = (await chain.latestTimestamp()) + 900;
  const start = bidEnd + 3600;
  const id = (await escrow.nextAuctionId()).toString();
  await (await as(HOST).createProtectedAuction(0, hash, ethers.parseEther('0.01'), bidEnd, start, start + 7200)).wait();
  const cookie = await signInCookie(apiUrl, chain.wallet(HOST));
  const registered = await fetch(`${apiUrl}/api/listings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ auctionId: id, metadata }),
  });
  expect(registered.status).toBe(201);
  await (await as(OUTBID).bid(id, { value: ethers.parseEther('0.01') })).wait();
  await (await as(WINNER).bid(id, { value: ethers.parseEther('0.02') })).wait();

  // The host saves instructions for this auction.
  await page.goto(stack.webUrl);
  await signIn(page, HOST);
  let panel = await openHostedListing(page);
  await expect(panel.getByTestId('arrival-checkin')).toHaveText('No check-in recorded.');
  await panel.getByLabel('Arrival instructions for this auction').fill(SECRET);
  await panel.getByRole('button', { name: 'Save for this auction' }).click();
  await expect(panel.getByTestId('arrival-status')).toHaveText('Arrival instructions saved.');
  await page.getByRole('button', { name: 'Close dialog' }).first().click();

  // Settled, and ten minutes before parking starts: inside both the instructions and check-in windows.
  await chain.increaseTime(bidEnd + 1 - (await chain.latestTimestamp()));
  await (await as(OUTBID).settle(id)).wait();
  await advancePast(page, chain, start - 600);

  await signIn(page, WINNER);
  await page.getByRole('button', { name: /My Activity/ }).click();
  const pass = page.locator('.reservation-pass-card').filter({ hasText: metadata.title });
  await pass.getByRole('button', { name: 'View Full Details' }).click();
  panel = page.getByTestId('arrival-panel');
  await expect(panel).toContainText('It is not proof of access, and the contract does not read it.');
  await panel.getByRole('button', { name: 'Show arrival instructions' }).click();
  await expect(panel.getByTestId('arrival-instructions')).toHaveText(SECRET);
  await panel.getByRole('button', { name: 'Check in' }).click();
  await expect(panel.getByTestId('arrival-checkin')).toContainText('Checked in at');
  await expect(panel.getByRole('button', { name: 'Check in' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close dialog' }).first().click();

  // The host sees the check-in.
  await signIn(page, HOST);
  panel = await openHostedListing(page);
  await expect(panel.getByTestId('arrival-checkin')).toContainText(/Winner 0x.* checked in at/);
  await expect(panel.getByLabel('Arrival instructions for this auction')).toHaveValue(SECRET);
});
