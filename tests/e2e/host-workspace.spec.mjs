import { ethers } from 'ethers';
import { test, expect } from './fixtures.mjs';
import { selectWallet } from './helpers.mjs';

const HOST = 3, LISTER = 2, NEW_OWNER = 5;

test.use({ scenario: 'campus-baseline', isolatedStack: 'host-workspace' });

async function signIn(page, index) {
  await selectWallet(page, index);
  const dialog = page.getByRole('dialog', { name: 'Connect & Switch Wallet' });
  await page.getByRole('banner').getByTitle('Switch local test account or connect browser wallet').click();
  await dialog.getByRole('button', { name: 'Sign in with this wallet' }).click();
  await expect(dialog.getByRole('group', { name: 'App sign-in' }).getByRole('status')).toContainText('Signed in as');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
}

test('a host manages a space, saves a draft, schedules in the space time zone, and reports a listing', async ({ page, stack }) => {
  const { chain, descriptor, apiUrl } = stack;
  const escrow = new ethers.Contract(descriptor.contractAddress, descriptor.abi, chain.wallet(HOST));
  const spaceId = (await escrow.nextSpaceId()).toString();
  await (await escrow.registerSpace()).wait();

  await page.goto(stack.webUrl);
  await signIn(page, HOST);
  await page.getByRole('button', { name: 'My Activity' }).click();
  const workspace = page.getByTestId('host-workspace');
  const space = workspace.getByRole('listitem').filter({ hasText: `Space #${spaceId}` }).first();
  await expect(space).toContainText('you own it');
  await expect(space).toContainText('Not verified');
  await space.getByText(`Manage space #${spaceId}`).click();

  // Time zone, then a blocked window entered in that zone.
  await space.getByLabel(`Time zone for space ${spaceId}`).fill('America/Chicago');
  await space.getByRole('button', { name: 'Set time zone' }).click();
  await expect(space).toContainText('time zone: America/Chicago');
  await space.getByLabel(`Block start for space ${spaceId}`).fill('2031-06-10T08:00');
  await space.getByLabel(`Block end for space ${spaceId}`).fill('2031-06-10T18:00');
  await space.getByRole('button', { name: 'Block window' }).click();
  await expect(space.getByRole('list', { name: `Calendar for space ${spaceId}` })).toContainText('Blocked:');
  const [blockId] = await escrow.spaceBlockedWindows(spaceId);
  const blocked = await escrow.blockedWindows(blockId);
  expect(Number(blocked.start)).toBe(Date.UTC(2031, 5, 10, 13, 0) / 1000); // 08:00 CDT

  // Approve and revoke a lister.
  const listerAddress = chain.wallet(LISTER).address;
  await space.getByLabel(`Lister address for space ${spaceId}`).fill(listerAddress);
  await space.getByRole('button', { name: 'Approve lister' }).click();
  await expect.poll(() => escrow.isSpaceLister(spaceId, listerAddress)).toBe(true);
  await space.getByRole('button', { name: 'Revoke lister' }).click();
  await expect.poll(() => escrow.isSpaceLister(spaceId, listerAddress)).toBe(false);
  await space.getByRole('button', { name: 'Approve lister' }).click();
  await expect.poll(() => escrow.isSpaceLister(spaceId, listerAddress)).toBe(true);

  // Schedule across midnight and see the conflict with the blocked window before signing.
  const form = workspace.locator('form.workspace-form');
  await form.getByLabel('Draft name').fill('Overnight Friday');
  await form.getByLabel('Parking space').selectOption(spaceId);
  await form.getByLabel('Title').fill('Overnight workspace driveway');
  await form.getByLabel('Public description').fill('Driveway with room for one compact car.');
  await form.getByLabel('Photo URL (https) or local path').fill('javascript:alert(1)');
  await expect(form.getByTestId('photo-preview')).toContainText('not allowed');
  await form.getByLabel('Photo URL (https) or local path').fill('/images/driveway.jpg');
  await expect(form.getByTestId('schedule-zone')).toContainText('America/Chicago');
  await form.getByLabel('Bidding cutoff').fill('2031-06-09T12:00');
  await form.getByLabel('Parking starts').fill('2031-06-09T22:00');
  await form.getByLabel('Parking ends').fill('2031-06-10T09:00');
  await expect(form.getByTestId('schedule-conflicts')).toContainText('Blocked');
  await expect(form.getByRole('button', { name: 'Sign and create auction' })).toBeDisabled();
  await form.getByRole('button', { name: 'Save draft' }).click();
  await expect(workspace.getByTestId('draft-list')).toContainText('Overnight Friday');

  // The draft survives a reload; a fixed end time clears the conflict.
  await page.reload();
  await page.getByRole('button', { name: 'My Activity' }).click();
  const saved = page.getByTestId('draft-list').getByRole('listitem').filter({ hasText: 'Overnight Friday' });
  await saved.getByRole('button', { name: 'Open' }).click();
  const reloaded = page.getByTestId('host-workspace').locator('form.workspace-form');
  await expect(reloaded.getByLabel('Title')).toHaveValue('Overnight workspace driveway');
  await expect(reloaded.getByLabel('Parking ends')).toHaveValue('2031-06-10T09:00');
  await reloaded.getByLabel('Parking ends').fill('2031-06-10T08:00');
  await expect(reloaded.getByTestId('schedule-clear')).toBeVisible();
  await expect(reloaded.getByTestId('snapshot-preview')).toContainText('Overnight workspace driveway');
  await reloaded.getByRole('button', { name: 'Sign and create auction' }).click();
  await expect.poll(async () => (await escrow.spaceAuctions(spaceId)).length).toBe(1);
  const [auctionId] = await escrow.spaceAuctions(spaceId);
  const auction = await escrow.auctions(auctionId);
  expect(Number(auction.parkingStart)).toBe(Date.UTC(2031, 5, 10, 3, 0) / 1000); // 22:00 CDT the evening before
  expect(Number(auction.parkingEnd)).toBe(Date.UTC(2031, 5, 10, 13, 0) / 1000);
  expect(Number(auction.bidEnd)).toBe(Date.UTC(2031, 5, 9, 17, 0) / 1000);

  // Another wallet reports the new listing.
  await signIn(page, 1);
  await page.getByRole('button', { name: 'Discover Spots', exact: true }).click();
  await page.getByRole('article', { name: 'Listing: Overnight workspace driveway', exact: true }).getByRole('button', { name: 'Details' }).click();
  const detail = page.getByRole('dialog').filter({ hasText: 'Overnight workspace driveway' });
  await detail.getByRole('button', { name: 'Report listing' }).click();
  await detail.getByRole('button', { name: 'Send report' }).click();
  await expect(detail.getByTestId('report-space')).toContainText('Report sent');
  expect((await fetch(`${apiUrl}/api/drafts`)).status).toBe(401);
  await detail.getByRole('button', { name: 'Close dialog' }).click();

  // The approved lister sees the space in its workspace and in the listing picker, without owner controls.
  await signIn(page, LISTER);
  await page.getByRole('button', { name: 'My Activity' }).click();
  const shared = page.getByTestId('host-workspace').getByRole('listitem').filter({ hasText: `Space #${spaceId}` }).first();
  await expect(shared).toContainText('approved lister');
  await expect(shared.getByText(`Manage space #${spaceId}`)).toHaveCount(0);
  await expect(shared.getByRole('list', { name: `Calendar for space ${spaceId}` })).toContainText('Held:');
  await page.getByRole('button', { name: 'List a Spot' }).click();
  await expect(page.getByRole('dialog').getByLabel('Parking space', { exact: true }).locator('option', { hasText: `Space #${spaceId}` })).toContainText('approved lister');
  await page.keyboard.press('Escape');

  // Transfer ownership to another wallet.
  await signIn(page, HOST);
  await page.getByRole('button', { name: 'My Activity' }).click();
  const mine = page.getByTestId('host-workspace').getByRole('listitem').filter({ hasText: `Space #${spaceId}` }).first();
  await mine.getByText(`Manage space #${spaceId}`).click();
  await mine.getByLabel(`New owner for space ${spaceId}`).fill(chain.wallet(NEW_OWNER).address);
  await mine.getByLabel(/I understand this removes my control/).check();
  await mine.getByRole('button', { name: 'Transfer space' }).click();
  await expect.poll(() => escrow.spaceOwner(spaceId)).toBe(chain.wallet(NEW_OWNER).address);
});

test('sign-out and wallet changes clear the private editor without deleting saved drafts', async ({ page, stack }) => {
  await page.goto(stack.webUrl);
  await signIn(page, HOST);
  await page.getByRole('button', { name: 'My Activity' }).click();
  const workspace = page.getByTestId('host-workspace');
  const draftName = 'Private overnight plan';
  const draftTitle = 'Private driveway draft';
  const saved = workspace.getByTestId('draft-list').getByRole('listitem').filter({ hasText: draftName });
  const name = workspace.getByLabel('Draft name');
  const title = workspace.getByLabel('Title', { exact: true });
  await name.fill(draftName);
  await title.fill(draftTitle);
  await workspace.getByRole('button', { name: 'Save draft', exact: true }).click();
  await saved.getByRole('button', { name: 'Open', exact: true }).click();
  await title.fill('Unsaved private edit');

  const wallet = page.getByRole('dialog', { name: 'Connect & Switch Wallet' });
  await page.getByRole('banner').getByTitle('Switch local test account or connect browser wallet').click();
  await wallet.getByRole('button', { name: 'Sign out', exact: true }).click();
  await wallet.getByRole('button', { name: 'Close dialog' }).click();
  await expect(name).toHaveValue('');
  await expect(title).toHaveValue('');
  await expect(saved).toHaveCount(0);

  await signIn(page, LISTER);
  await expect(name).toHaveValue('');
  await expect(title).toHaveValue('');
  await expect(saved).toHaveCount(0);

  await signIn(page, HOST);
  await expect(title).toHaveValue('');
  await saved.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(title).toHaveValue(draftTitle);
});
