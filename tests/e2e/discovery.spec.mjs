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

  // Destination: a preset landmark, filtered and labelled by straight-line distance, answered by the server.
  await page.getByLabel('Destination').fill('Rainey Street District');
  const searched = page.waitForResponse((r) => r.url().includes('/api/listings/search') && r.url().includes('radiusKm=0.5'));
  await page.getByLabel('Maximum distance').selectOption('0.5');
  const answer = await (await searched).json();
  expect(answer.listings.map((l) => l.title)).toEqual([RAINEY]);
  expect(answer.chain.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
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

test('discovery keeps filtering the loaded listings when the search service fails', async ({ page, stack }) => {
  await page.route('**/api/listings/search**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"down"}' }));
  await page.goto(stack.webUrl);
  await page.getByTitle('Cards view only').click();
  const cards = page.getByRole('article', { name: /^Listing: / });
  await expect(cards).toHaveCount(7);
  await page.getByLabel('Destination').fill('Rainey Street District');
  await page.getByLabel('Maximum distance').selectOption('0.5');
  await expect(cards).toHaveCount(1);
  await expect(page.getByRole('article', { name: `Listing: ${RAINEY}`, exact: true })).toBeVisible();
});

test('map-area search sends the viewport as a bbox, can be cleared, and keeps the area in the URL', async ({ page, stack }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(stack.webUrl);
  const cards = page.getByRole('article', { name: /^Listing: / });
  await expect(cards).toHaveCount(7);

  // Zoom in so the viewport covers only part of the city. The map reports its viewport when a zoom
  // ends, and ignores clicks while one is animating, so wait for each step before the next.
  const span = async () => {
    const [south, , north] = ((await page.locator('.parking-map-wrapper').getAttribute('data-viewport')) ?? '').split(',').map(Number);
    return north - south;
  };
  for (let i = 0; i < 3; i++) {
    const before = await span();
    await page.locator('.leaflet-control-zoom-in').click();
    await expect.poll(span).toBeLessThan(before * 0.7);
  }
  const searchArea = page.getByRole('button', { name: 'Search this area' });
  await expect(searchArea).toBeEnabled();
  const request = page.waitForRequest((r) => r.url().includes('/api/listings/search') && r.url().includes('bbox='));
  await searchArea.click();
  const bbox = new URL((await request).url()).searchParams.get('bbox');
  expect(bbox).toMatch(/^-?\d+\.\d+(,-?\d+\.\d+){3}$/);
  const [minLat, minLon, maxLat, maxLon] = bbox.split(',').map(Number);
  await expect(page).toHaveURL(/area=/);

  const inside = (await (await fetch(`${stack.apiUrl}/api/listings/search?bbox=${bbox}`)).json()).listings;
  expect(inside.length).toBeGreaterThan(0);
  expect(inside.length).toBeLessThan(7);
  for (const l of inside) {
    expect(l.latitude).toBeGreaterThanOrEqual(minLat);
    expect(l.latitude).toBeLessThanOrEqual(maxLat);
    expect(l.longitude).toBeGreaterThanOrEqual(minLon);
    expect(l.longitude).toBeLessThanOrEqual(maxLon);
  }
  await expect(cards).toHaveCount(inside.length);
  await expect(page.getByRole('button', { name: 'Searching this area' })).toBeDisabled();

  // A reload restores the area; moving the map offers a new search; clearing shows everything again.
  await page.reload();
  await expect(cards).toHaveCount(inside.length);
  await page.getByRole('button', { name: 'Clear area' }).click();
  await expect(cards).toHaveCount(7);
  await expect(page).not.toHaveURL(/area=/);
});

test('location is optional: it is sent only in the query, kept out of the URL, and a refusal is explained', async ({ page, stack, context }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // Nothing asks for location until the button is pressed.
  let asked = false;
  await page.addInitScript(() => {
    const original = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    navigator.geolocation.getCurrentPosition = (...args) => { window.__geoAsked = true; return original(...args); };
  });
  await page.goto(stack.webUrl);
  await page.getByTitle('Cards view only').click();
  const cards = page.getByRole('article', { name: /^Listing: / });
  await expect(cards).toHaveCount(7);
  asked = await page.evaluate(() => Boolean(window.__geoAsked));
  expect(asked).toBe(false);

  // Refused: a plain explanation and the manual destination still works.
  await context.grantPermissions([]);
  await page.getByRole('button', { name: 'Use my location' }).click();
  await expect(page.getByText(/Location not shared/)).toBeVisible();
  await expect(cards).toHaveCount(7);

  // Granted: rounded to 3 decimals, used as near=, not stored in the URL.
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 30.25921234, longitude: -97.73951234 });
  const request = page.waitForRequest((r) => r.url().includes('/api/listings/search') && r.url().includes('near='));
  await page.getByRole('button', { name: 'Use my location' }).click();
  expect(new URL((await request).url()).searchParams.get('near')).toBe('30.259000,-97.740000');
  await expect(page.getByLabel('Destination')).toHaveValue('My location');
  await expect(page).not.toHaveURL(/dest=|30\.259/);
  await page.getByLabel('Maximum distance').selectOption('0.5');
  await expect(cards).toHaveCount(1);
  await expect(page.getByRole('article', { name: `Listing: ${RAINEY}`, exact: true })).toContainText(/straight-line from My location/);
  await expect(page.getByRole('article', { name: `Listing: ${RAINEY}`, exact: true })).toContainText(/Space time zone/);
});
