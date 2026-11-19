import { test, expect } from './fixtures.mjs';

test.use({ scenario: 'campus-expansion' });

const N1 = 'N1 · Quad Edge Commuter Spot [Fictional Class Demo]';

for (const viewport of [{ width: 1280, height: 720 }, { width: 375, height: 800 }]) {
  test(`campus parody list works by keyboard at ${viewport.width}px without map tiles`, async ({ page, stack }) => {
    // The fixture answers every off-origin request (map tiles, photos) with an empty body.
    await page.setViewportSize(viewport);
    await page.goto(stack.webUrl);

    const banner = page.getByRole('region', { name: 'Class demo scenario' });
    await expect(banner).toContainText('Unofficial campus-parking parody');
    await expect(banner).toContainText('Scenario: After the dorm expansion.');
    await expect(banner).toContainText('Near-campus spots listed: 1 of 4 (3 farther away).');
    await expect(banner).toContainText('simulated test ETH');

    const cardsView = page.getByTitle('Cards view only');
    await cardsView.focus();
    await page.keyboard.press('Enter');
    await expect(cardsView).toHaveAttribute('aria-pressed', 'true');

    const cards = page.getByRole('article', { name: /^Listing: / });
    await expect(cards).toHaveCount(4);
    await expect(cards.filter({ hasText: 'Near campus · 3-5 min walk' })).toHaveCount(1);
    await expect(cards.filter({ hasText: 'Farther away · 15-20 min walk' })).toHaveCount(3);

    const n1 = page.getByRole('article', { name: `Listing: ${N1}`, exact: true });
    await expect(n1.getByText('Demo Listing', { exact: true })).toBeVisible();
    const details = n1.getByRole('button', { name: 'Details', exact: true });
    await details.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Fictional class-demo spot');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(details).toBeFocused();
  });
}

test('a demo account can still bid on the remaining near spot', async ({ page, stack }) => {
  await page.goto(stack.webUrl);
  const header = page.getByRole('banner');
  await header.getByRole('button', { name: /Connect Wallet/ }).click();
  const wallets = page.getByRole('dialog', { name: 'Connect & Switch Wallet' });
  await wallets.getByRole('button', { name: /Account #1 \(/ }).click();
  await wallets.getByRole('button', { name: 'Close dialog' }).click();

  const n1 = page.getByRole('article', { name: `Listing: ${N1}`, exact: true });
  await n1.getByRole('button', { name: 'Bid Now' }).click();
  const bid = page.getByRole('dialog').filter({ has: page.getByLabel('Your New Bid Amount (ETH)') });
  await bid.getByLabel('Your New Bid Amount (ETH)').fill('0.03');
  await bid.getByRole('button', { name: 'Deposit 0.03 ETH', exact: true }).click();
  await expect(bid).toBeHidden();
  await expect(n1.locator('.bid-amount')).toHaveText('0.030');
});
