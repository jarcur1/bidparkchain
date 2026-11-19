import { expect } from './fixtures.mjs';

export async function selectWallet(page, index) {
  const header = page.getByRole('banner');
  const connect = header.getByRole('button', { name: /Connect Wallet/ });
  await connect.or(header.getByTitle('Switch local test account or connect browser wallet')).click();
  const dialog = page.getByRole('dialog', { name: 'Connect & Switch Wallet' });
  const account = dialog.getByRole('button', { name: new RegExp(`Account #${index} \\(`) });
  await account.click();
  await expect(account.getByText('Active', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(header.getByRole('button', { name: new RegExp(`Account #${index} \\(`) })).toBeVisible();
}

export async function bid(page, title, amount) {
  await page.getByRole('button', { name: 'Discover Spots', exact: true }).click();
  const card = page.getByRole('article', { name: `Listing: ${title}`, exact: true });
  await card.getByRole('button', { name: 'Bid Now' }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByLabel('Your New Bid Amount (ETH)') });
  await dialog.getByLabel('Your New Bid Amount (ETH)').fill(amount);
  await dialog.getByRole('button', { name: `Deposit ${amount} ETH`, exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(card.getByText('Highest Bid', { exact: true })).toBeVisible();
  await expect(card.locator('.bid-amount')).toHaveText(Number(amount).toFixed(3));
}

export async function advancePast(page, chain, timestamp) {
  const latest = await chain.provider.send('eth_getBlockByNumber', ['latest', false]);
  const seconds = Number(timestamp) + 1 - Number(BigInt(latest.timestamp));
  if (seconds > 0) await chain.increaseTime(seconds);
  const block = await chain.provider.send('eth_getBlockByNumber', ['latest', false]);
  // The UI gates settlement/payout using Date.now(), so keep its clock aligned
  // with our explicitly advanced chain without waiting for real deadlines.
  await page.clock.setFixedTime(new Date(Number(BigInt(block.timestamp)) * 1000));
  await page.getByRole('button', { name: 'Refresh data' }).click();
}
