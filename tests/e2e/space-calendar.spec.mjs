import { Contract } from 'ethers';
import { test, expect } from './fixtures.mjs';
import { selectWallet } from './helpers.mjs';

test.use({ scenario: 'campus-baseline', isolatedStack: 'space-calendar' });

test('a host lists a second window on the same space and the contract rejects an overlapping one', async ({ page, stack }) => {
  const { chain, descriptor } = stack;
  const escrow = new Contract(descriptor.contractAddress, descriptor.abi, chain.provider);
  const title = 'E2E side driveway with a calendar';
  await page.goto(stack.webUrl);
  // Account #3 owns no seeded spaces, so its first listing creates its first space.
  await selectWallet(page, 3);
  const create = page.getByRole('dialog').filter({ has: page.getByLabel('Listing Title') });
  const list = async ({ space, cutoff }) => {
    await page.getByRole('button', { name: 'List a Spot' }).click();
    await create.getByLabel('Listing Title').fill(title);
    await create.getByLabel('Street Address').fill('12 Side St, Austin, TX 78701');
    await create.getByLabel('Public space description').fill('Side driveway with room for one compact car.');
    if (space) await create.getByLabel('Parking space', { exact: true }).selectOption({ label: space });
    await create.getByLabel('Bidding Cutoff').selectOption(cutoff);
    await create.getByLabel('Parking Window').selectOption('immediate-2h');
    await create.getByRole('button', { name: 'Review public listing', exact: true }).click();
    await create.getByRole('button', { name: 'Confirm and Deploy Auction', exact: true }).click();
  };

  const first = await escrow.nextAuctionId();
  await list({ cutoff: '15' });
  await expect(create).toBeHidden();
  const spaceId = await escrow.auctionSpace(first);
  expect(await escrow.spaceOwner(spaceId)).toBe(chain.wallet(3).address);

  const space = `Space #${spaceId}: ${title}`;
  await list({ space, cutoff: '15' });
  await expect(create.getByRole('alert')).toContainText('overlapping parking window');
  await expect(create.locator('#parking-space-calendar')).toContainText('Reserved:');
  expect(await escrow.nextAuctionId()).toBe(first + 1n);
  await page.keyboard.press('Escape');
  await expect(create).toBeHidden();

  // Starting after the first window ends is accepted on the same space.
  await list({ space, cutoff: '240' });
  await expect(create).toBeHidden();
  expect(await escrow.spaceAuctions(spaceId)).toEqual([first, first + 1n]);
  await expect(page.getByRole('article', { name: `Listing: ${title}`, exact: true })).toHaveCount(2);
});
