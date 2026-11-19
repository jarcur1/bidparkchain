import { Contract } from 'ethers';
import { test, expect } from './fixtures.mjs';
import { advancePast, bid, selectWallet } from './helpers.mjs';
import { capture, N1, PROJECTOR } from './presenter-capture.mjs';

test.use({ scenario: 'campus-expansion' });

test('presenter steps 2-6: dorm expansion, outbid, refund, settle', async ({ page, stack }) => {
  const { chain, descriptor } = stack;
  const escrow = new Contract(descriptor.contractAddress, descriptor.abi, chain.provider);
  await page.setViewportSize(PROJECTOR);
  await page.clock.install();
  await page.goto(stack.webUrl);
  await page.getByTitle('Cards view only').click();
  await expect(page.getByRole('region', { name: 'Class demo scenario' }))
    .toContainText('Near-campus spots listed: 1 of 4 (3 farther away).');
  await capture(page, '02-expansion');

  await selectWallet(page, 1);
  await bid(page, N1, '0.03');
  await selectWallet(page, 2);
  await bid(page, N1, '0.05');
  await capture(page, '03-competing-bid');

  await selectWallet(page, 1);
  await page.getByRole('button', { name: /My Activity/ }).click();
  const row = page.getByRole('row').filter({ hasText: N1 });
  await expect(row.getByText('Outbid — bidding still open', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Withdraw 0.030 ETH', exact: true })).toBeVisible();
  await capture(page, '04-outbid-refund');
  await page.getByRole('button', { name: 'Withdraw 0.030 ETH', exact: true }).click();
  await expect(page.getByText('No pending refunds', { exact: true })).toBeVisible();

  const auction = await escrow.auctions(1n);
  await advancePast(page, chain, auction.bidEnd);
  await selectWallet(page, 2);
  await expect(page.getByText('Status: You won — pending settlement', { exact: true })).toBeVisible();
  await capture(page, '05-pending-settlement');
  await page.getByRole('button', { name: 'Settle Auction & Claim Pass', exact: true }).click();
  await expect(page.getByText('Status: You won — confirmed on-chain', { exact: true })).toBeVisible();
  await expect(page.getByText(/does not grant access to any real space/)).toBeVisible();
  await page.getByText('Status: You won — confirmed on-chain', { exact: true }).scrollIntoViewIfNeeded();
  await capture(page, '06-confirmed-win');
  expect((await escrow.auctions(1n)).settled).toBe(true);
});
