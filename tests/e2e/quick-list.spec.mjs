import { ethers } from 'ethers';
import { test, expect } from './fixtures.mjs';
import { localTime, selectWallet } from './helpers.mjs';

const HOST = 3;
test.use({ scenario: 'campus-baseline', isolatedStack: 'quick-list' });

test('the quick listing form autosaves a draft, restores it after a reload, and lists with explicit dates', async ({ page, stack }) => {
  const { chain, descriptor } = stack;
  const escrow = new ethers.Contract(descriptor.contractAddress, descriptor.abi, chain.provider);
  const before = await escrow.nextAuctionId();
  await page.goto(stack.webUrl);
  await selectWallet(page, HOST);
  const create = page.getByRole('dialog').filter({ has: page.getByLabel('Listing Title') });
  await page.getByRole('button', { name: 'List a Spot' }).click();
  // Without a session nothing is saved, and the form says so.
  await expect(create.getByTestId('autosave-status')).toContainText('Sign in to save');
  await create.getByRole('button', { name: 'Close dialog' }).click();

  const wallets = page.getByRole('dialog', { name: 'Connect & Switch Wallet' });
  await page.getByRole('banner').getByTitle('Switch local test account or connect browser wallet').click();
  await wallets.getByRole('button', { name: 'Sign in with this wallet' }).click();
  await expect(wallets.getByRole('group', { name: 'App sign-in' }).getByRole('status')).toContainText('Signed in as');
  await wallets.getByRole('button', { name: 'Close dialog' }).click();

  await page.getByRole('button', { name: 'List a Spot' }).click();
  const title = 'Autosaved quick driveway';
  await create.getByLabel('Listing Title').fill(title);
  await create.getByLabel('Street Address').fill('9 Draft St, Austin, TX 78701');
  await create.getByLabel('Public space description').fill('Driveway used to check the autosave.');
  await expect(create.getByTestId('autosave-status')).toContainText('Unsaved changes');
  await expect(create.getByTestId('autosave-status')).toContainText('Draft saved.', { timeout: 10_000 });

  // The draft is on the server, so a full reload brings it back.
  await page.reload();
  await page.getByRole('button', { name: 'List a Spot' }).click();
  await expect(create.getByLabel('Listing Title')).toHaveValue(title);
  await expect(create.getByLabel('Street Address')).toHaveValue('9 Draft St, Austin, TX 78701');

  // A cutoff in the past is refused with the reason; a bad window is never sent to the wallet.
  await create.getByLabel('Bidding Cutoff', { exact: true }).fill(localTime(-60));
  await expect(create.getByTestId('schedule-error')).toContainText('must be in the future');
  await create.getByRole('button', { name: 'Review public listing', exact: true }).click();
  await expect(create.getByRole('alert').first()).toContainText('must be in the future');
  expect(await escrow.nextAuctionId()).toBe(before);

  await create.getByLabel('Bidding Cutoff', { exact: true }).fill(localTime(30));
  await create.getByLabel('Parking Starts', { exact: true }).fill(localTime(30));
  await create.getByLabel('Parking Ends', { exact: true }).fill(localTime(150));
  await create.getByRole('button', { name: 'Review public listing', exact: true }).click();
  await create.getByRole('button', { name: 'Confirm and Deploy Auction', exact: true }).click();
  await expect(create).toBeHidden();
  expect(await escrow.nextAuctionId()).toBe(before + 1n);
  const auction = await escrow.auctions(before);
  expect(Number(auction.parkingEnd) - Number(auction.parkingStart)).toBe(7200);

  // Listing it removes the autosaved draft: the next form starts empty.
  await page.reload();
  await page.getByRole('button', { name: 'List a Spot' }).click();
  await expect(create.getByLabel('Listing Title')).toHaveValue('');
});
