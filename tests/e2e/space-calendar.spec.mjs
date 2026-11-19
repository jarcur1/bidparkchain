import { Contract } from 'ethers';
import { test, expect } from './fixtures.mjs';
import { localTime, selectWallet } from './helpers.mjs';

test.use({ scenario: 'campus-baseline', isolatedStack: 'space-calendar' });

test('a host lists a second window on the same space and an overlapping one is stopped before signing', async ({ page, stack }) => {
  const { chain, descriptor } = stack;
  const escrow = new Contract(descriptor.contractAddress, descriptor.abi, chain.provider);
  const title = 'E2E side driveway with a calendar';
  await page.goto(stack.webUrl);
  // Account #3 owns no seeded spaces, so its first listing creates its first space.
  await selectWallet(page, 3);
  const create = page.getByRole('dialog').filter({ has: page.getByLabel('Listing Title') });
  // Times are minutes from now: [cutoff, start, end].
  const list = async ({ space, at, blocked = false }) => {
    await page.getByRole('button', { name: 'List a Spot' }).click();
    await create.getByLabel('Listing Title').fill(title);
    await create.getByLabel('Street Address').fill('12 Side St, Austin, TX 78701');
    await create.getByLabel('Public space description').fill('Side driveway with room for one compact car.');
    if (space) await create.getByLabel('Parking space', { exact: true }).selectOption({ label: space });
    await create.getByLabel('Bidding Cutoff', { exact: true }).fill(localTime(at[0]));
    await create.getByLabel('Parking Starts', { exact: true }).fill(localTime(at[1]));
    await create.getByLabel('Parking Ends', { exact: true }).fill(localTime(at[2]));
    await create.getByRole('button', { name: 'Review public listing', exact: true }).click();
    if (blocked) return;
    await create.getByRole('button', { name: 'Confirm and Deploy Auction', exact: true }).click();
  };

  const first = await escrow.nextAuctionId();
  await list({ at: [15, 15, 135] });
  await expect(create).toBeHidden();
  const spaceId = await escrow.auctionSpace(first);
  expect(await escrow.spaceOwner(spaceId)).toBe(chain.wallet(3).address);

  const space = `Space #${spaceId}: ${title}`;
  await list({ space, at: [15, 15, 135], blocked: true });
  await expect(create.getByTestId('schedule-conflicts')).toContainText('Overlaps a held or blocked window');
  await expect(create.locator('#parking-space-calendar')).toContainText('Reserved:');
  expect(await escrow.nextAuctionId()).toBe(first + 1n);
  await page.keyboard.press('Escape');
  await expect(create).toBeHidden();

  // Starting after the first window ends is accepted on the same space.
  await list({ space, at: [60, 240, 360] });
  await expect(create).toBeHidden();
  expect(await escrow.spaceAuctions(spaceId)).toEqual([first, first + 1n]);
  await expect(page.getByRole('article', { name: `Listing: ${title}`, exact: true })).toHaveCount(2);
});
