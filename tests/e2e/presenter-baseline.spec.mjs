import { test, expect } from './fixtures.mjs';
import { capture, PROJECTOR } from './presenter-capture.mjs';

test.use({ scenario: 'campus-baseline' });

test('presenter step 1: the baseline campus', async ({ page, stack }) => {
  await page.setViewportSize(PROJECTOR);
  await page.goto(stack.webUrl);
  await page.getByTitle('Cards view only').click();
  await expect(page.getByRole('region', { name: 'Class demo scenario' }))
    .toContainText('Near-campus spots listed: 4 of 7 (3 farther away).');
  await expect(page.getByRole('article', { name: /^Listing: / })).toHaveCount(7);
  await capture(page, '01-baseline');
});
