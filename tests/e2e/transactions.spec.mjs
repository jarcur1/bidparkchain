import { Contract } from 'ethers';
import { test, expect } from './fixtures.mjs';
import { selectWallet } from './helpers.mjs';

// Its own campus-baseline stack: these tests add a listing and bids that other specs must not see.
test.use({ scenario: 'campus-baseline', isolatedStack: 'transactions' });

const center = (page) => page.getByRole('region', { name: /Transactions/ });

test('a bid submitted before a reload resumes, confirms once mined, and is scoped to its account', async ({ page, stack }) => {
  const { chain } = stack;
  await page.goto(stack.webUrl);
  await selectWallet(page, 2);
  await chain.provider.send('evm_setAutomine', [false]);
  try {
    const card = page.getByRole('article', { name: /^Listing: N2 · / });
    await card.getByRole('button', { name: 'Bid Now' }).click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByLabel('Your New Bid Amount (ETH)') });
    await dialog.getByLabel('Your New Bid Amount (ETH)').fill('0.04');
    await dialog.getByRole('button', { name: 'Deposit 0.04 ETH', exact: true }).click();
    await expect.poll(async () => (await chain.provider.send('eth_getBlockByNumber', ['pending', false])).transactions.length).toBeGreaterThan(0);

    // Reload while the transaction is still unmined.
    await page.reload();
    await page.getByRole('button', { name: /My Activity/ }).click();
    const row = center(page).getByRole('row').filter({ hasText: 'Bid 0.04 ETH on auction #2' });
    await expect(row).toContainText('Confirming');
    await expect(row.locator('code')).toHaveText(/^0x[0-9a-f]{8}…$/);

    await chain.provider.send('evm_mine', []);
    await page.getByRole('button', { name: 'Refresh data' }).click();
    await expect(row).toContainText('Confirmed');

    await selectWallet(page, 1);
    await expect(center(page)).toContainText('No transactions from this account yet');
    await selectWallet(page, 2);
    await expect(row).toContainText('Confirmed');
  } finally {
    await chain.provider.send('evm_setAutomine', [true]);
  }
});

test('an API outage after a confirmed listing is recovered after reload without a second create', async ({ page, stack }) => {
  const { chain, descriptor } = stack;
  const escrow = new Contract(descriptor.contractAddress, descriptor.abi, chain.provider);
  const before = await escrow.nextAuctionId();
  const title = 'Transaction center driveway';
  await page.route('**/api/listings', (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, json: { error: 'Registration service unavailable' } })
    : route.fallback());
  await page.goto(stack.webUrl);
  await selectWallet(page, 0);
  await page.getByRole('button', { name: 'List a Spot' }).click();
  const create = page.getByRole('dialog').filter({ has: page.getByLabel('Listing Title') });
  await create.getByLabel('Listing Title').fill(title);
  await create.getByLabel('Street Address').fill('12 Example Lane, Austin, TX 78701');
  await create.getByLabel('Public space description').fill('Paved driveway with a light over the entrance.');
  await create.getByLabel('Opening Min Bid (ETH)').fill('0.02');
  await create.getByRole('button', { name: 'Review public listing', exact: true }).click();
  await create.getByRole('button', { name: 'Confirm and Deploy Auction', exact: true }).click();
  await expect(create).toContainText('Retry Registration: Auction #');
  expect(await escrow.nextAuctionId()).toBe(before + 1n);

  // The API comes back; after a reload the listing is registered from metadata staged before signing.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route('**/*', async (route) => (new URL(route.request().url()).origin === new URL(stack.webUrl).origin
    ? route.continue() : route.fulfill({ status: 200, body: '' })));
  await page.reload();
  await expect(page.getByRole('article', { name: `Listing: ${title}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: /My Activity/ }).click();
  const row = center(page).getByRole('row').filter({ hasText: `List "${title}"` });
  await expect(row).toContainText('Confirmed');
  await expect(row).toContainText('Listing registered');
  expect(await escrow.nextAuctionId()).toBe(before + 1n);
});
