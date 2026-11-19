import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures.mjs';
import { advancePast, selectWallet } from './helpers.mjs';

// Its own stack: this spec bids on and settles a campus spot.
test.use({ scenario: 'campus-baseline', isolatedStack: 'history-calendar' });

test('detail view shows indexed bid history, zoned times, and exports a won reservation', async ({ page, stack }) => {
  const { listings } = await (await fetch(`${stack.apiUrl}/api/listings`)).json();
  const spot = listings.find((l) => l.title.startsWith('N1 · '));
  await page.goto(stack.webUrl);
  await selectWallet(page, 2);

  const card = page.getByRole('article', { name: `Listing: ${spot.title}`, exact: true });
  await expect(card.locator('.countdown-at')).toHaveText(/^\w{3}, \w{3} \d{1,2}, \d{1,2}:\d{2} [AP]M \S+$/);
  await card.getByRole('button', { name: 'Details', exact: true }).click();
  const detail = page.getByRole('dialog', { name: spot.title });
  const history = detail.getByTestId('bid-history');
  await expect(history).toContainText('No bids yet.', { timeout: 20_000 });
  await expect(detail).toContainText(/Cutoff: \w{3}, \w{3} \d{1,2}, \d{1,2}:\d{2} [AP]M \S+ \(/);
  await detail.getByRole('button', { name: 'Place Higher Bid' }).click();

  const bidDialog = page.getByRole('dialog').filter({ has: page.getByLabel('Your New Bid Amount (ETH)') });
  const amount = (Number(spot.minBid) + 0.01).toFixed(2);
  await bidDialog.getByLabel('Your New Bid Amount (ETH)').fill(amount);
  await bidDialog.getByRole('button', { name: `Deposit ${amount} ETH`, exact: true }).click();
  await expect(bidDialog).toBeHidden();

  await card.getByRole('button', { name: 'Details', exact: true }).click();
  const row = history.locator('.bid-history-row').filter({ hasText: 'Bid' });
  await expect(row).toContainText(`${Number(amount).toFixed(3)} ETH`, { timeout: 20_000 });
  await expect(row).toContainText('(you)');
  await expect(history).not.toContainText(/catching up|unavailable|out of date/, { timeout: 20_000 });
  // A leading bid is already exportable, as a tentative event.
  const early = page.waitForEvent('download');
  await detail.getByRole('button', { name: 'Add to calendar (.ics)' }).click();
  const early_ics = await readFile(await (await early).path(), 'utf8');
  expect(early_ics).toContain('STATUS:TENTATIVE\r\n');
  const sequenceOf = (text) => Number(text.match(/SEQUENCE:(\d+)/)[1]);

  await detail.getByRole('button', { name: 'Close dialog' }).click();
  await advancePast(page, stack.chain, spot.bidEnd);
  await card.getByRole('button', { name: 'Details', exact: true }).click();
  await detail.getByRole('button', { name: 'Settle Escrow Now' }).click();
  const exportButton = detail.getByRole('button', { name: 'Add to calendar (.ics)' });
  await expect(exportButton).toBeVisible({ timeout: 20_000 });
  await expect(history).toContainText('Settled', { timeout: 20_000 });

  const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
  expect(download.suggestedFilename()).toBe(`bidpark-reservation-${spot.id}.ics`);
  const ics = await readFile(await download.path(), 'utf8');
  const utc = (sec) => new Date(sec * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  expect(ics).toContain(`DTSTART:${utc(spot.parkingStart)}\r\n`);
  expect(ics).toContain(`DTEND:${utc(spot.parkingEnd)}\r\n`);
  expect(ics).toContain(`UID:${stack.descriptor.chainId}-${stack.descriptor.contractAddress.toLowerCase()}-${spot.id}@bidpark`);
  expect(ics).toContain('STATUS:CONFIRMED\r\n');
  // The revision is the chain snapshot block, so the later export outranks the earlier one.
  expect(sequenceOf(ics)).toBeGreaterThan(sequenceOf(early_ics));
  expect(ics).not.toContain(spot.description);
});
