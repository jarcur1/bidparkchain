import { ethers } from 'ethers';
import { test, expect } from './fixtures.mjs';
import { selectWallet } from './helpers.mjs';

const HOST = 3, BIDDER = 1;

test.use({ scenario: 'campus-baseline', isolatedStack: 'replace-after-bids' });

async function signIn(page, index) {
  await selectWallet(page, index);
  const dialog = page.getByRole('dialog', { name: 'Connect & Switch Wallet' });
  await page.getByRole('banner').getByTitle('Switch local test account or connect browser wallet').click();
  await dialog.getByRole('button', { name: 'Sign in with this wallet' }).click();
  await expect(dialog.getByRole('group', { name: 'App sign-in' }).getByRole('status')).toContainText('Signed in as');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
}

async function fillSchedule(form, title, cutoff, start, end) {
  await form.getByLabel('Title', { exact: true }).fill(title);
  await form.getByLabel('Public description').fill('Driveway with room for one compact car.');
  await form.getByLabel('Bidding cutoff').fill(cutoff);
  await form.getByLabel('Parking starts').fill(start);
  await form.getByLabel('Parking ends').fill(end);
}

test('a host replaces a listing that has a bid, and the bidder is pointed to the replacement', async ({ page, stack }) => {
  const { chain, descriptor, apiUrl } = stack;
  const escrow = (index) => new ethers.Contract(descriptor.contractAddress, descriptor.abi, chain.wallet(index));
  const originalId = (await escrow(HOST).nextAuctionId()).toString();

  await page.goto(stack.webUrl);
  await signIn(page, HOST);
  await page.getByRole('button', { name: 'My Activity' }).click();
  const workspace = page.getByTestId('host-workspace');
  const form = workspace.locator('form.workspace-form');
  await fillSchedule(form, 'Original swap driveway', '2031-07-01T12:00', '2031-07-02T09:00', '2031-07-02T17:00');
  await form.getByRole('button', { name: 'Sign and create auction' }).click();
  await expect.poll(async () => (await escrow(HOST).auctions(originalId)).owner).toBe(chain.wallet(HOST).address);
  await (await escrow(BIDDER).bid(originalId, { value: ethers.parseEther('0.06') })).wait();

  // The host starts a change: the page says it is material, that the bid stands, and prefills a linked draft.
  await page.reload();
  await page.getByRole('button', { name: 'My Activity' }).click();
  const card = page.locator('.hosted-spot-card').filter({ hasText: 'Original swap driveway' });
  await card.getByRole('button', { name: 'Edit or replace' }).click();
  const panel = page.getByTestId('change-after-bids');
  await expect(panel).toContainText('already has a bid');
  await expect(panel.getByTestId('change-consequence')).toContainText('bid stands');
  await expect(panel.getByRole('button', { name: /Cancel auction|Withdraw booking/ })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Prefill replacement draft' }).click();
  const draft = page.getByTestId('host-workspace').locator('form.workspace-form');
  await expect(draft.getByTestId('replaces-note')).toContainText(`auction #${originalId}`);
  await expect(draft.getByLabel('Title', { exact: true })).toHaveValue('Original swap driveway');
  await expect(draft.getByLabel('Parking starts')).toHaveValue('');

  await fillSchedule(draft, 'Replacement swap driveway', '2031-07-02T12:00', '2031-07-03T09:00', '2031-07-03T17:00');
  await draft.getByRole('button', { name: 'Sign and create auction' }).click();
  await expect.poll(async () => (await (await fetch(`${apiUrl}/api/auctions/${originalId}/replacement`)).json()).replacementId, { timeout: 30_000 })
    .toBe(String(Number(originalId) + 1));

  // The bidder's inbox points at the replacement.
  await signIn(page, BIDDER);
  const bell = page.getByRole('banner').getByRole('button', { name: /^Inbox, / });
  await expect(bell).toHaveAccessibleName(/Inbox, [1-9]\d* unread/, { timeout: 30_000 });
  await bell.click();
  const entry = page.getByTestId('inbox').locator('[data-inbox-kind="replaced"]');
  await expect(entry).toContainText(`auction #${Number(originalId) + 1}`);
  await expect(entry.getByRole('button', { name: 'View replacement' })).toBeVisible();
});
