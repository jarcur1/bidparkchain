import { Contract, ZeroHash, id, keccak256, toUtf8Bytes } from 'ethers';
import { validateSpotMetadata } from '../../shared/validation.js';
import { signInCookie } from '../support/auth.mjs';
import { test, expect } from './fixtures.mjs';

const metadata = {
  title: 'Verified stall A', address: '1 Example Avenue', neighborhood: 'Test district',
  latitude: 30.2672, longitude: -97.7431, description: 'An illustrative covered parking stall.',
  image: '/fixture.jpg', kind: 'covered', amenities: [],
};

test.use({ verifiedInventory: true });

test('a suspended listing stays visible but no longer offers bidding', async ({ page, stack }) => {
  const { chain, descriptor, apiUrl, webUrl } = stack;
  const host = chain.wallet(0);
  const verifier = chain.wallet(3);
  const escrow = new Contract(descriptor.contractAddress, descriptor.abi, host);
  const hash = keccak256(toUtf8Bytes(JSON.stringify(validateSpotMetadata(metadata).normalized)));
  const confirmed = async (tx) => (await tx).wait();
  await confirmed(escrow.registerSpace());
  await confirmed(escrow.setSpaceVerifier(verifier.address, true));
  await confirmed(escrow.connect(verifier).setSpaceVerification(1, host.address, 0, id('fixture-stall'), hash));
  const now = (await chain.provider.getBlock('latest')).timestamp;
  await confirmed(escrow.createSpaceAuction(1, hash, 1, now + 3600, now + 7200, now + 10800));
  const cookie = await signInCookie(apiUrl, host);
  const registered = await fetch(`${apiUrl}/api/listings`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ auctionId: '1', metadata }),
  });
  expect(registered.status).toBe(201);

  await page.goto(webUrl);
  const card = page.getByRole('article', { name: 'Listing: Verified stall A' });
  await expect(card.getByText('Verified space', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Bid Now' })).toBeVisible();

  await confirmed(escrow.connect(verifier).setSpaceVerification(1, host.address, 0, ZeroHash, ZeroHash));
  await page.getByRole('button', { name: 'Refresh data' }).click();
  await expect(card.getByText('Bidding Paused', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Bid Now' })).toHaveCount(0);
  await expect(card.getByText('Verified space', { exact: true })).toHaveCount(0);
});
