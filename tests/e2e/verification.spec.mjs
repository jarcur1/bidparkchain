import { ethers } from 'ethers';
import { test, expect } from './fixtures.mjs';
import { selectWallet } from './helpers.mjs';
import { signInCookie } from '../support/auth.mjs';
import { validateSpotMetadata } from '../../shared/validation.js';

const HOST = 3, MODERATOR = 2;
const mnemonic = ethers.Mnemonic.fromPhrase('test test test test test test test test test test test junk');
const moderatorAddress = ethers.HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${MODERATOR}`).address;
const EVIDENCE = 'Lease for 40 Speedway, unit 2B, signed March 2026';
const metadata = {
  title: 'Speedway driveway for verification', address: '40 Speedway', neighborhood: 'West Campus',
  latitude: 30.29, longitude: -97.74, description: 'Driveway space behind the duplex.',
  image: '/images/driveway.jpg', kind: 'driveway', amenities: [],
};

test.use({ scenario: 'campus-baseline', isolatedStack: 'verification', apiEnv: { BIDPARK_MODERATORS: moderatorAddress } });

async function signIn(page, index) {
  await selectWallet(page, index);
  const dialog = page.getByRole('dialog', { name: 'Connect & Switch Wallet' });
  await page.getByRole('banner').getByTitle('Switch local test account or connect browser wallet').click();
  await dialog.getByRole('button', { name: 'Sign in with this wallet' }).click();
  await expect(dialog.getByRole('group', { name: 'App sign-in' }).getByRole('status')).toContainText('Signed in as');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
}

test('a host requests verification, a moderator approves it, and the listing shows only the badge', async ({ page, stack }) => {
  const { chain, descriptor, apiUrl } = stack;
  const escrow = new ethers.Contract(descriptor.contractAddress, descriptor.abi, chain.wallet(HOST));
  const id = (await escrow.nextAuctionId()).toString();
  const spaceId = (await escrow.nextSpaceId()).toString();
  const hash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(validateSpotMetadata(metadata).normalized)));
  const now = await chain.latestTimestamp();
  await (await escrow.createAuction(hash, ethers.parseEther('0.01'), now + 3600, now + 7200, now + 10800)).wait();
  const registered = await fetch(`${apiUrl}/api/listings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: await signInCookie(apiUrl, chain.wallet(HOST)) },
    body: JSON.stringify({ auctionId: id, metadata }),
  });
  expect(registered.status).toBe(201);

  await page.goto(stack.webUrl);
  await signIn(page, HOST);
  await page.getByRole('button', { name: 'My Activity' }).click();
  const hostPanel = page.getByTestId('host-verification');
  const space = hostPanel.getByRole('listitem').filter({ hasText: `Space #${spaceId} (` });
  await expect(space.getByTestId('verification-status')).toHaveText('Not verified');
  await expect(page.getByTestId('moderation')).toHaveCount(0);
  await space.getByLabel('Proof of control').fill(EVIDENCE);
  await space.getByRole('button', { name: 'Request verification' }).click();
  await expect(space.getByTestId('verification-status')).toHaveText('Pending review');

  await signIn(page, MODERATOR);
  await page.getByRole('button', { name: 'My Activity' }).click();
  const request = page.getByTestId('moderation').getByRole('listitem').filter({ hasText: `Space #${spaceId}:` });
  await expect(request).toContainText(EVIDENCE);
  await request.getByLabel(`approve note for space ${spaceId}`).fill('Lease matches the address');
  await request.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(request).toContainText('Verified');
  await expect(request).toContainText('approve (control-verified) - Lease matches the address');

  await page.reload();
  const card = page.getByRole('article', { name: `Listing: ${metadata.title}`, exact: true });
  await expect(card.getByText('Verified space')).toBeVisible();
  const listings = await (await fetch(`${apiUrl}/api/listings`)).text();
  expect(listings).not.toContain('Lease for 40 Speedway');
  expect(JSON.parse(listings).listings.find((l) => l.id === id).verification).toBe('verified');
});
