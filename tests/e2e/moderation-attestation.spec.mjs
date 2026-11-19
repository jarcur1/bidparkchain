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

test.use({ verifiedInventory: true, isolatedStack: 'moderation-attestation', apiEnv: { BIDPARK_MODERATORS: moderatorAddress } });

async function signIn(page, index) {
  await selectWallet(page, index);
  const dialog = page.getByRole('dialog', { name: 'Connect & Switch Wallet' });
  await page.getByRole('banner').getByTitle('Switch local test account or connect browser wallet').click();
  await dialog.getByRole('button', { name: 'Sign in with this wallet' }).click();
  await expect(dialog.getByRole('group', { name: 'App sign-in' }).getByRole('status')).toContainText('Signed in as');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
}

test.describe('verified inventory chain attestation', () => {
  test('off-chain moderation never attests on chain; a separately authorized verifier signs approval and suspension', async ({ page, stack }) => {
    const { chain, descriptor, apiUrl } = stack;
    const admin = chain.wallet(0);
    const adminEscrow = new ethers.Contract(descriptor.contractAddress, descriptor.abi, admin);
    const hostEscrow = new ethers.Contract(descriptor.contractAddress, descriptor.abi, chain.wallet(HOST));
    const confirmed = async (tx) => (await tx).wait();
    const spaceId = '1';
    const hash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(validateSpotMetadata(metadata).normalized)));
    const stallKey = ethers.id('verification-spec-stall');
    const approvedHash = () => adminEscrow.spaceVerifiedMetadata(spaceId);

    // Host registers an owned space and submits proof through the API.
    await confirmed(hostEscrow.registerSpace());
    const hostCookie = await signInCookie(apiUrl, chain.wallet(HOST));
    const proof = await fetch(`${apiUrl}/api/spaces/${spaceId}/verification`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: hostCookie },
      body: JSON.stringify({ evidence: EVIDENCE }),
    });
    expect(proof.status).toBeLessThan(300);
    // The moderation allowlist is not a chain permission.
    expect(await adminEscrow.spaceVerifiers(moderatorAddress)).toBe(false);
    const chainStatus = page.getByTestId(`onchain-${spaceId}`);

    await page.goto(stack.webUrl);
    await signIn(page, MODERATOR);
    await page.getByRole('button', { name: 'My Activity' }).click();
    const request = page.getByTestId('moderation').getByRole('listitem').filter({ hasText: `Space #${spaceId}:` });
    await expect(request).toContainText(EVIDENCE);
    await request.getByLabel(`approve note for space ${spaceId}`).fill('Lease matches the address');
    await request.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(request).toContainText('approve (control-verified) - Lease matches the address');

    // Off-chain approval alone leaves the chain unapproved.
    await request.getByRole('button', { name: 'Check on-chain verification' }).click();
    expect(await approvedHash()).toBe(ethers.ZeroHash);
    await expect(chainStatus.getByText('Not verified on-chain', { exact: true })).toBeVisible();
    await expect(chainStatus.getByRole('button', { name: 'Sign on-chain approval' })).toBeDisabled();

    // Separate authorization: the deployment admin grants the verifier role.
    await confirmed(adminEscrow.setSpaceVerifier(moderatorAddress, true));
    expect(await adminEscrow.spaceVerifiers(moderatorAddress)).toBe(true);
    await request.getByRole('button', { name: 'Check on-chain verification' }).click();
    await request.getByLabel('Opaque stall key').fill(stallKey);
    await request.getByLabel('Reviewed listing metadata hash').fill(hash);
    await request.getByRole('button', { name: 'Sign on-chain approval' }).click();
    await expect.poll(approvedHash).toBe(hash);
    await expect(chainStatus.getByText('Verified on-chain', { exact: true })).toBeVisible();

    // A listing on the approved hash is registered and offers Bid Now to a non-owner.
    const now = (await chain.provider.getBlock('latest')).timestamp;
    await confirmed(hostEscrow.createSpaceAuction(spaceId, hash, ethers.parseEther('0.01'), now + 3600, now + 7200, now + 10800));
    const registered = await fetch(`${apiUrl}/api/listings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: hostCookie },
      body: JSON.stringify({ auctionId: '1', metadata }),
    });
    expect(registered.status).toBe(201);
    await page.getByRole('button', { name: 'Discover Spots', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh data' }).click();
    const card = page.getByRole('article', { name: `Listing: ${metadata.title}`, exact: true });
    await expect(card.getByText('Verified space', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Bid Now' })).toBeVisible();

    // Off-chain revoke does not suspend by itself; the verifier then signs suspension.
    await page.getByRole('button', { name: 'My Activity' }).click();
    await request.getByLabel(`revoke note for space ${spaceId}`).fill('Confirmed report');
    await request.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(request.getByText('Suspended', { exact: true })).toBeVisible();
    expect(await approvedHash()).toBe(hash);
    await request.getByRole('button', { name: 'Check on-chain verification' }).click();
    await request.getByRole('button', { name: 'Sign on-chain suspension' }).click();
    await expect.poll(approvedHash).toBe(ethers.ZeroHash);
    await expect(chainStatus.getByText('Not verified on-chain', { exact: true })).toBeVisible();
    expect(await adminEscrow.spaceIdentity(spaceId)).toBe(stallKey);
    await page.getByRole('button', { name: 'Discover Spots', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh data' }).click();
    await expect(card.getByText('Bidding Paused', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Bid Now' })).toHaveCount(0);
    await expect(card.getByText('Verified space', { exact: true })).toHaveCount(0);
  });
});
