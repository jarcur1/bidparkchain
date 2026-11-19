import { ethers } from 'ethers';
import { test, expect } from './fixtures.mjs';
import { selectWallet } from './helpers.mjs';
import { signInCookie } from '../support/auth.mjs';
import { validateSpotMetadata } from '../../shared/validation.js';

const HOST = 3, MODERATOR = 2;
const mnemonic = ethers.Mnemonic.fromPhrase('test test test test test test test test test test test junk');
const moderatorAddress = ethers.HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${MODERATOR}`).address;
const APPEAL = 'The lease names me as the tenant of this stall';
const metadata = {
  title: 'Appeal test driveway', address: '77 Appeal Lane', neighborhood: 'West Campus',
  latitude: 30.28, longitude: -97.75, description: 'Driveway space for the appeal test.',
  image: '/images/driveway.jpg', kind: 'driveway', amenities: [],
};

test.use({ scenario: 'campus-baseline', isolatedStack: 'verification-appeal', apiEnv: { BIDPARK_MODERATORS: moderatorAddress } });

async function signIn(page, index) {
  await selectWallet(page, index);
  const dialog = page.getByRole('dialog', { name: 'Connect & Switch Wallet' });
  await page.getByRole('banner').getByTitle('Switch local test account or connect browser wallet').click();
  await dialog.getByRole('button', { name: 'Sign in with this wallet' }).click();
  await expect(dialog.getByRole('group', { name: 'App sign-in' }).getByRole('status')).toContainText('Signed in as');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
}

test('a host appeals a rejected verification and the moderator sees the note', async ({ page, stack }) => {
  const { chain, descriptor, apiUrl } = stack;
  const escrow = new ethers.Contract(descriptor.contractAddress, descriptor.abi, chain.wallet(HOST));
  const id = (await escrow.nextAuctionId()).toString();
  const spaceId = (await escrow.nextSpaceId()).toString();
  const hash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(validateSpotMetadata(metadata).normalized)));
  const now = await chain.latestTimestamp();
  await (await escrow.createAuction(hash, ethers.parseEther('0.01'), now + 3600, now + 7200, now + 10800)).wait();
  const hostCookie = await signInCookie(apiUrl, chain.wallet(HOST));
  const registered = await fetch(`${apiUrl}/api/listings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie: hostCookie },
    body: JSON.stringify({ auctionId: id, metadata }),
  });
  expect(registered.status).toBe(201);
  expect((await registered.json()).duplicateSpaces).toEqual([]);
  await fetch(`${apiUrl}/api/spaces/${spaceId}/verification`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie: hostCookie },
    body: JSON.stringify({ evidence: 'Utility bill for the address' }),
  });
  const modCookie = await signInCookie(apiUrl, chain.wallet(MODERATOR));
  const decided = await fetch(`${apiUrl}/api/moderation/verifications/${spaceId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie: modCookie },
    body: JSON.stringify({ action: 'reject', reason: 'insufficient-evidence', note: 'Bill has no name' }),
  });
  expect(decided.status).toBe(200);

  await page.goto(stack.webUrl);
  await signIn(page, HOST);
  await page.getByRole('button', { name: 'My Activity' }).click();
  const space = page.getByTestId('host-verification').getByRole('listitem').filter({ hasText: `Space #${spaceId} (` });
  await expect(space.getByTestId('verification-status')).toHaveText('Rejected');
  await space.getByLabel('Appeal note for the moderators').fill(APPEAL);
  await space.getByRole('button', { name: 'Send appeal' }).click();
  await expect(space).toContainText(`appeal (host-appeal) - ${APPEAL}`);
  await expect(space.getByRole('button', { name: 'Send appeal' })).toHaveCount(0);

  await signIn(page, MODERATOR);
  await page.getByRole('button', { name: 'My Activity' }).click();
  const request = page.getByTestId('moderation').getByRole('listitem').filter({ hasText: `Space #${spaceId}:` });
  await expect(request).toContainText(`appeal (host-appeal) - ${APPEAL}`);
});
