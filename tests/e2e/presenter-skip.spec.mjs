import { test, expect } from './fixtures.mjs';

test.use({ scenario: 'campus-baseline', isolatedStack: 'presenter-skip' });

const N1 = 'N1 · Quad Edge Commuter Spot [Fictional Class Demo]';

test('the local presenter clock closes bidding on the card, then moves past parking', async ({ page, stack }) => {
  await page.goto(stack.webUrl);
  const card = page.getByRole('article', { name: `Listing: ${N1}`, exact: true });
  await expect(card.getByRole('button', { name: 'Bid Now' })).toBeVisible();

  const clock = page.getByRole('region', { name: 'Local demo clock' });
  await clock.getByRole('button', { name: 'Skip to bidding close' }).click();
  await expect(clock.getByRole('status')).toHaveText(/^Chain time moved forward \d+h \d+m\.$/);
  await expect(card.getByRole('button', { name: 'Bid Now' })).toHaveCount(0);
  await expect(card.getByText('Bidding Ended', { exact: true })).toBeVisible();

  await clock.getByRole('button', { name: 'Skip to parking end' }).click();
  await expect(clock.getByRole('status')).toHaveText(/^Chain time moved forward \d+h \d+m\.$/);
});
