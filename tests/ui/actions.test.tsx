import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEther, ZeroAddress } from 'ethers';
import { App } from '../../src/App';
import type { Config, Listing } from '../../src/types';
import { createRequire } from 'node:module';
import { bridgeCrypto } from './crypto';
// Node 24 require(ESM) keeps the process harness outside Vite's browser URL rewriting.
const { createScope, deployEscrow } = createRequire(`${process.cwd()}/package.json`)(`${process.cwd()}/tests/support/owned-env.mjs`) as typeof import('../support/owned-env.mjs');

const metadata = { title: 'Private downtown driveway', address: '70 Rainey St, Austin, TX 78701', neighborhood: 'Downtown Austin', latitude: 30.2676, longitude: -97.7397, description: 'Enter the private driveway from the street and park beside the gate.', image: 'https://example.test/parking.jpg', kind: 'driveway' as const, amenities: [] };
let scope: Awaited<ReturnType<typeof createScope>>, chain: Awaited<ReturnType<Awaited<ReturnType<typeof createScope>>['startChain']>>, deployment: Awaited<ReturnType<typeof deployEscrow>>;
let host: HTMLDivElement, root: Root, config: Config, records: Listing[], postFails: boolean;
let account: string, sends: string[], release: (() => void) | undefined, hold: boolean;
let fetchBoundary: ReturnType<typeof vi.fn>;
const listeners = new Map<string, Set<(value: unknown) => void>>();
const nativeFetch = globalThis.fetch;
const query = (selector: string) => { const result = host.querySelector(selector); expect(result, selector).not.toBeNull(); return result as HTMLElement; };
async function click(element: Element) { await act(async () => { (element as HTMLElement).click(); }); }
async function until(check: () => void) { await vi.waitFor(async () => { await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); check(); }, { timeout: 8000 }); }
async function change(selector: string, value: string) {
  await act(async () => {
    const input = query(selector) as HTMLInputElement;
    const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function connect() {
  await act(async () => root.render(<App/>));
  await until(() => expect(fetchBoundary).toHaveBeenCalledWith('/api/config'));
  await click(query('.wallet-btn'));
  await click(query('.avatar-injected').closest('[role="button"]')!);
  await until(() => expect(host.querySelector('.wallet-btn-balance')).not.toBeNull());
  await click(query('.modal-wallet-dialog .modal-close-btn'));
}
function listing(id: string, ended = false): Listing {
  const now = Math.floor(Date.now() / 1000);
  return { ...metadata, id, owner: ZeroAddress, minBid: '0.05', highestBid: '0', highestBidder: ZeroAddress, bidEnd: now + (ended ? -60 : 3600), parkingStart: now + 7200, parkingEnd: now + 10800, settled: false, cancelled: false, payoutClaimed: false, metadataHash: '0x' + '00'.repeat(32) };
}

beforeAll(async () => {
  bridgeCrypto();
  scope = await createScope('ui-actions');
  try { chain = await scope.startChain(); deployment = await deployEscrow(chain); }
  catch (error) { await scope.close(); throw error; }
  account = chain.wallet(1).address;
  config = { chainId: 31337, contractAddress: deployment.address, abi: deployment.abi, currency: 'ETH', networkName: 'Owned test chain', demoMnemonic: 'test test test test test test test test test test test junk', demoAccountIndex: 1, deploymentBlock: deployment.deploymentBlock };
}, 60000);
afterAll(async () => { chain?.provider.destroy(); await scope?.close(); });
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  bridgeCrypto();
  localStorage.clear(); records = []; postFails = false; sends = []; hold = false; release = undefined;
  Object.defineProperty(window, 'ethereum', { configurable: true, value: {
    request: async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account];
      if (method === 'eth_sendTransaction') {
        const transaction = params[0];
        if (!transaction || typeof transaction !== 'object' || !('data' in transaction)) throw new Error('Missing transaction data');
        sends.push(String(transaction.data));
        if (hold) await new Promise<void>((resolve) => { release = resolve; });
      }
      return chain.provider.send(method, params);
    },
    on(event: string, listener: (value: unknown) => void) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(listener); },
    removeListener(event: string, listener: (value: unknown) => void) { listeners.get(event)?.delete(listener); },
  } });
  fetchBoundary = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input === '/api/config') return Response.json(config);
    if (input === '/api/listings' && init?.method === 'POST') {
      if (postFails) return Response.json({ error: 'Registration service unavailable' }, { status: 503 });
      const { auctionId } = JSON.parse(String(init.body)) as { auctionId: string };
      return Response.json({ listing: listing(auctionId) });
    }
    if (input === '/api/listings') return Response.json({ listings: records });
    // Only the owned chain is reachable; accidental shared-service calls fail the test.
    if (String(input).startsWith(chain.rpcUrl + '/')) return nativeFetch(input, init);
    throw new Error(`Unexpected fetch: ${String(input)}`);
  });
  vi.stubGlobal('fetch', fetchBoundary);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  release?.();
  await act(async () => root.unmount()); host.remove(); listeners.clear(); vi.unstubAllGlobals();
});

describe('real application transaction boundaries', () => {
  it('recovers failed metadata registration with the original auction ID and no second create transaction', async () => {
    postFails = true; await connect(); await click(query('.nav-action-create'));
    await change('#spot-title', metadata.title); await change('#spot-address', metadata.address); await change('#spot-desc', metadata.description);
    await click(query('.btn-modal-submit-create'));
    await until(() => expect(host.textContent).toContain('Retry Registration: Auction #'));
    const posts = () => fetchBoundary.mock.calls.filter(([url, init]) => url === '/api/listings' && init?.method === 'POST');
    expect(posts()).toHaveLength(1); const original = String(posts()[0][1]!.body);
    const { auctionId } = JSON.parse(original) as { auctionId: string };
    expect(await deployment.contract.nextAuctionId()).toBe(BigInt(auctionId) + 1n);
    expect(sends).toHaveLength(1);
    // Close and reopen through the durable in-session recovery banner.
    await click(query('.modal-create-dialog .modal-close-btn'));
    await click(query('.btn-retry-registration'));
    expect((query('#spot-title') as HTMLInputElement).value).toBe(metadata.title);
    for (const field of host.querySelectorAll('.modal-create-dialog fieldset input, .modal-create-dialog fieldset select, .modal-create-dialog fieldset textarea')) expect(field.matches(':disabled')).toBe(true);
    postFails = false; await click(query('.btn-modal-submit-create'));
    await until(() => expect(host.textContent).toContain('Registration Confirmed'));
    expect(posts()).toHaveLength(2); expect(String(posts()[1][1]!.body)).toBe(original); expect(sends).toHaveLength(1);
    expect(host.querySelector('.pending-registration-alert')).toBeNull(); expect(host.querySelector('.modal-create-dialog')).toBeNull();
  }, 20000);

  it.each(['bid', 'settle', 'withdraw'])('submits only one %s transaction on a double click while pending', async (action) => {
    const id = String(await deployment.contract.nextAuctionId());
    const now = await chain.latestTimestamp();
    await (await deployment.contract.createAuction('0x' + '11'.repeat(32), parseEther('0.05'), now + 3600, now + 7200, now + 10800)).wait();
    if (action === 'settle') await chain.increaseTime(3601);
    if (action === 'withdraw') {
      await (await deployment.contract.connect(chain.wallet(1)).bid(BigInt(id), { value: parseEther('0.05') })).wait();
      await (await deployment.contract.connect(chain.wallet(2)).bid(BigInt(id), { value: parseEther('0.06') })).wait();
    }
    records = [listing(id, action === 'settle')];
    await connect();
    let button: HTMLElement;
    if (action === 'bid') { await click(query('.btn-card-primary')); button = query('.btn-modal-submit-bid'); }
    else { await click(Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.includes('My Activity'))!); button = query(action === 'withdraw' ? '.btn-withdraw-refund' : '.btn-trigger-settle'); }
    hold = true;
    // Separate browser clicks permit React's disabled-state commit between events.
    await click(button); await until(() => expect(sends).toHaveLength(1)); await click(button);
    expect(sends).toHaveLength(1); expect((button as HTMLButtonElement).disabled).toBe(true);
    release?.(); hold = false;
    await until(() => expect(host.textContent).toContain(action === 'bid' ? 'Escrow Bid Placed!' : action === 'settle' ? 'Auction Settled!' : 'Refund Withdrawn!'));
    expect(sends).toHaveLength(1);
  }, 20000);
});
