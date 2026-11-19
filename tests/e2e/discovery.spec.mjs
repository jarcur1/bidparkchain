import { test, expect } from './fixtures.mjs';

// Read-only, but on its own stack so bids from other specs cannot change prices or windows.
test.use({ isolatedStack: 'discovery' });

const RAINEY = 'Rainey Street Historic District Parking Pad [Local Demo]';
const MUELLER = 'Mueller Town Center Gated Residential Bay [Local Demo]';

test('discovery filters work by keyboard on a narrow screen and survive a reload', async ({ page, stack }) => {
  const { listings } = await (await fetch(`${stack.apiUrl}/api/listings`)).json();
  const mueller = listings.find((l) => l.title === MUELLER);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(stack.webUrl);

  const cardsView = page.getByTitle('Cards view only');
  await cardsView.focus();
  await page.keyboard.press('Enter');
  const cards = page.getByRole('article', { name: /^Listing: / });
  await expect(cards).toHaveCount(7);

  // Destination: a preset landmark, filtered and labelled by straight-line distance.
  await page.getByLabel('Destination').fill('Rainey Street District');
  await page.getByLabel('Maximum distance').selectOption('0.5');
  await expect(cards).toHaveCount(1);
  const rainey = page.getByRole('article', { name: `Listing: ${RAINEY}`, exact: true });
  await expect(rainey).toContainText(/\d+ m straight-line from Rainey Street District/);
  await expect(page).toHaveURL(/dest=Rainey\+Street\+District/);

  await page.reload();
  await expect(page.getByLabel('Destination')).toHaveValue('Rainey Street District');
  await expect(cards).toHaveCount(1);
  await page.getByLabel('Destination').fill('Somewhere unknown');
  await expect(page.getByText('No landmark or listing address matches "Somewhere unknown"')).toBeVisible();
  await expect(cards).toHaveCount(7);
  await page.getByLabel('Destination').fill('');

  // Visit: only windows covering the whole stay; a reversed stay is reported, not applied.
  const local = (sec) => page.evaluate((s) => {
    const d = new Date(s * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }, sec);
  const depart = mueller.parkingEnd - 600;
  await page.getByLabel('Arrive').fill(await local(depart - 3600));
  await page.getByLabel('Depart').fill(await local(depart));
  await expect(cards).toHaveCount(1);
  await expect(page.getByRole('article', { name: `Listing: ${MUELLER}`, exact: true })).toBeVisible();
  await page.getByLabel('Arrive').fill(await local(depart + 3600));
  await expect(page.getByText('Departure must be after arrival. The visit filter is not applied.')).toBeVisible();
  await expect(cards).toHaveCount(7);
  await page.getByLabel('Arrive').fill('');
  await page.getByLabel('Depart').fill('');

  // Amenities: the disclosure and checkboxes work from the keyboard.
  await page.getByText('Amenities', { exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('EV Charging Nearby').focus();
  await page.keyboard.press('Space');
  await expect(cards).toHaveCount(1);
  await expect(page).toHaveURL(/amenity=EV\+Charging\+Nearby/);
  await page.keyboard.press('Space');
  await expect(cards).toHaveCount(7);

  // Budget: compared with the current price and labelled as not final; no-results names the filter.
  await expect(page.getByText(/Not a final price/)).toBeVisible();
  await page.getByLabel('Max', { exact: true }).fill('0.001');
  await expect(cards).toHaveCount(0);
  await expect(page.getByText(/None of the loaded listings match: Current price up to 0.001 ETH/)).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'Reset all filters' }).click();
  await expect(cards).toHaveCount(7);
  await expect(page).toHaveURL(stack.webUrl.endsWith('/') ? stack.webUrl : `${stack.webUrl}/`);
});
