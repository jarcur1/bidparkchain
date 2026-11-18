import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, Listing } from '../src/types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Account address by derivation index, and a controllable RPC balance read.
const rpc = vi.hoisted(() => ({
  getBalance: vi.fn<(address: string) => Promise<bigint>>(),
}));

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>();
  class FakeProvider {
    async getNetwork() {
      return { chainId: 31337n };
    }
    getBalance(address: string) {
      return rpc.getBalance(address);
    }
    destroy() {}
  }
  return {
    ...actual,
    JsonRpcProvider: FakeProvider,
    HDNodeWallet: {
      fromPhrase: (_phrase: string, _password: unknown, path: string) => ({
        connect: () => ({ address: `0xAccount${path.split('/').pop()}` }),
      }),
    },
  };
});

vi.mock('../src/services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/api')>()),
  fetchConfig: vi.fn(),
  fetchListings: vi.fn(),
}));

vi.mock('../src/services/blockchain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/blockchain')>()),
  getContractInstance: vi.fn(() => ({})),
  fetchPendingReturns: vi.fn(),
}));

vi.mock('../src/components/ParkingMap', () => ({ ParkingMap: () => null }));

import { App, AppContent } from '../src/App';
import { BidModal } from '../src/components/BidModal';
import { useWallet, WalletProvider, type WalletContextValue } from '../src/context/WalletContext';
import { fetchConfig, fetchListings } from '../src/services/api';
import { fetchPendingReturns } from '../src/services/blockchain';
import { READ_OK, readSucceeded } from '../src/utils/readState';

const ETH = 10n ** 18n;
const mockConfig = vi.mocked(fetchConfig);
const mockListings = vi.mocked(fetchListings);
const mockRefund = vi.mocked(fetchPendingReturns);

const configFor = (contractAddress: string, deploymentBlockHash = '0xhash1'): Config => ({
  chainId: 31337,
  contractAddress,
  abi: [],
  currency: 'ETH',
  networkName: 'Hardhat Local',
  demoMnemonic: 'test test test test test test test test test test test junk',
  demoAccountIndex: 1,
  deploymentBlock: 0,
  deploymentBlockHash,
});
const CONFIG_A = configFor('0xContractA');
const CONFIG_B = configFor('0xContractB');
// Same chain and contract address as A, but a reset chain produced a different deployment block.
const CONFIG_A_RESET = configFor('0xContractA', '0xhash2');

const listing = (id: string, title: string): Listing => ({
  id,
  title,
  owner: '0xOwner',
  minBid: '0.1',
  highestBid: '0',
  highestBidder: '0x0000000000000000000000000000000000000000',
  bidEnd: Math.floor(Date.now() / 1000) + 86_400,
  parkingStart: Math.floor(Date.now() / 1000) + 90_000,
  parkingEnd: Math.floor(Date.now() / 1000) + 100_000,
  settled: false,
  cancelled: false,
  payoutClaimed: false,
  metadataHash: '0x00',
  address: '1 Test St',
  neighborhood: 'Downtown',
  latitude: 30.26,
  longitude: -97.74,
  description: 'Test spot',
  image: '',
  kind: 'garage',
  amenities: [],
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}
function deferred<T>(): Deferred<T> {
  return Promise.withResolvers<T>();
}

let container: HTMLDivElement;
let root: Root | undefined;

// This Node/Vitest environment exposes no usable localStorage, so back it with a real jsdom Storage
// from a fresh, isolated window on a localhost origin.
const storage = new JSDOM('', { url: 'http://localhost/' }).window.localStorage;
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });

const text = () => container.textContent ?? '';
async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
async function mount(element: React.ReactElement) {
  await act(async () => {
    root!.render(element);
  });
  await settle();
}
function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
  if (!found) throw new Error(`No button containing "${label}". Page: ${text()}`);
  return found as HTMLButtonElement;
}
async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}
const refreshAll = () => click(container.querySelector('[aria-label="Refresh data"]')!);
const balanceText = () => container.querySelector('.wallet-btn-balance')?.textContent;

function connectLocalWalletOnLoad() {
  storage.setItem('bidpark_wallet_type', 'local');
  storage.setItem('bidpark_account_index', '1');
}

beforeEach(() => {
  storage.clear();
  mockConfig.mockReset();
  mockListings.mockReset();
  mockRefund.mockReset();
  rpc.getBalance.mockReset();
  mockConfig.mockResolvedValue(CONFIG_A);
  mockListings.mockResolvedValue([]);
  mockRefund.mockResolvedValue(0n);
  rpc.getBalance.mockResolvedValue(ETH + ETH / 2n);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
  vi.restoreAllMocks();
});

describe('listings read status', () => {
  it('API down on first load is unavailable, not an empty marketplace, and retry recovers', async () => {
    mockListings.mockRejectedValue(new Error('API offline'));
    await mount(<App />);

    expect(text()).toContain('Parking auctions are unavailable');
    expect(text()).toContain('API offline');
    expect(text()).toContain('Listings unavailable');
    expect(text()).not.toContain('No matching parking auctions found');
    expect(text()).not.toContain('No parking auctions are listed yet');
    expect(text()).toContain('Spot availability unavailable');
    expect(text()).not.toContain('0 spots available');

    mockListings.mockResolvedValue([]);
    await click(button('Retry listings'));

    expect(text()).toContain('No parking auctions are listed yet');
    expect(text()).toContain('0 spots available');
    expect(text()).not.toContain('Parking auctions are unavailable');
    expect(text()).not.toContain('Listings unavailable');
  });

  it('distinguishes a successful empty read from populated listings', async () => {
    mockListings.mockResolvedValue([listing('1', 'Sunny Garage')]);
    await mount(<App />);
    expect(text()).toContain('Sunny Garage');
    expect(text()).not.toContain('No parking auctions are listed yet');
  });

  it('keeps last known listings labeled stale when a refresh fails and reports the partial result honestly', async () => {
    mockListings.mockResolvedValue([listing('1', 'Sunny Garage')]);
    await mount(<App />);
    expect(text()).not.toContain('may be out of date');

    mockListings.mockRejectedValue(new Error('API offline'));
    await refreshAll();

    expect(text()).toContain('Sunny Garage');
    expect(text()).toContain('Showing the last known listings');
    expect(text()).toContain('1 spot last known');
    expect(text()).not.toContain('spot available');
    expect(text()).toContain('Listings may be out of date');
    expect(text()).toContain('Refresh partly failed');
    expect(text()).toContain('Updated: Configuration');
    expect(text()).toContain('Still unavailable: Listings (API offline)');
    expect(text()).not.toContain('Refreshed');
    expect(container.querySelector('[data-testid="last-sync"]')?.textContent).not.toContain('Listings never');
  });

  it('reports a total failure when nothing could be read', async () => {
    await mount(<App />);
    mockConfig.mockRejectedValue(new Error('config down'));
    mockListings.mockRejectedValue(new Error('API offline'));
    await refreshAll();
    expect(text()).toContain('Refresh failed');
    expect(text()).toContain('Configuration (config down); Listings (API offline)');
  });
});

describe('configuration read status', () => {
  it('shows an initial config failure, retries on demand and recovers the wallet', async () => {
    connectLocalWalletOnLoad();
    mockConfig.mockRejectedValue(new Error('Smart contract not yet deployed'));
    await mount(<App />);

    expect(text()).toContain('Configuration unavailable');
    expect(text()).toContain('Smart contract not yet deployed');
    expect(text()).toContain('Wallet connection and contract actions are unavailable');
    expect(text()).toContain('Connect Wallet');

    mockConfig.mockResolvedValue(CONFIG_A);
    const callsBefore = mockConfig.mock.calls.length;
    await click(button('Retry configuration'));

    expect(mockConfig.mock.calls.length).toBe(callsBefore + 1);
    expect(text()).not.toContain('Configuration unavailable');
    expect(text()).toContain('Account #1');
    expect(balanceText()).toBe('1.500 ETH');
  });

  it('manual refresh re-reads configuration and keeps the last config, labeled stale, when it fails', async () => {
    await mount(<App />);
    const callsBefore = mockConfig.mock.calls.length;

    mockConfig.mockRejectedValue(new Error('config down'));
    await refreshAll();

    expect(mockConfig.mock.calls.length).toBe(callsBefore + 1);
    expect(text()).toContain('Configuration may be out of date');
    expect(text()).not.toContain('Configuration unavailable');
  });

  it('hides foreign listings on a deployment change and ignores superseded listing responses', async () => {
    const queue: Deferred<Listing[]>[] = [];
    mockListings.mockImplementation(() => {
      const d = deferred<Listing[]>();
      queue.push(d);
      return d.promise;
    });
    await mount(<App />);
    // The initial read restarts once the configuration identifies the deployment; only the newest publishes.
    const base = queue.length;
    await act(async () => queue[base - 1].resolve([listing('1', 'Deployment A Spot')]));
    await settle();
    expect(text()).toContain('Deployment A Spot');

    // Refresh discovers a new deployment while the refresh's own listings read (call 2) is still in flight.
    mockConfig.mockResolvedValue(CONFIG_B);
    await refreshAll();
    expect(queue).toHaveLength(base + 2);
    expect(text()).not.toContain('Deployment A Spot');

    // Late response for the old deployment must be dropped; the new deployment's read wins.
    await act(async () => queue[base].resolve([listing('9', 'Late Deployment A Spot')]));
    await settle();
    expect(text()).not.toContain('Late Deployment A Spot');
    await act(async () => queue[base + 1].resolve([listing('2', 'Deployment B Spot')]));
    await settle();
    expect(text()).toContain('Deployment B Spot');
    expect(text()).not.toContain('Deployment A Spot');
  });

  it('only the newest overlapping listings request may publish', async () => {
    const queue: Deferred<Listing[]>[] = [];
    mockListings.mockImplementation(() => {
      const d = deferred<Listing[]>();
      queue.push(d);
      return d.promise;
    });
    await mount(<App />);
    const base = queue.length;
    await act(async () => queue[base - 1].resolve([listing('1', 'Initial Spot')]));
    await settle();

    // Two overlapping manual refreshes: the older response arrives last.
    await act(async () => {
      (container.querySelector('[aria-label="Refresh data"]') as HTMLElement).click();
      (container.querySelector('[aria-label="Refresh data"]') as HTMLElement).click();
    });
    expect(queue).toHaveLength(base + 2);
    await act(async () => queue[base + 1].resolve([listing('3', 'Newest Spot')]));
    await act(async () => queue[base].resolve([listing('2', 'Older Spot')]));
    await settle();
    expect(text()).toContain('Newest Spot');
    expect(text()).not.toContain('Older Spot');
  });
});

describe('wallet and refund read status (RPC down)', () => {
  beforeEach(connectLocalWalletOnLoad);

  it('never turns an unknown refund into zero, retains the last known amount and gates withdrawal', async () => {
    mockRefund.mockResolvedValue(2n * ETH);
    await mount(<App />);
    expect(container.querySelector('.nav-badge-alert')?.textContent).toBe('Refund');
    await click(button('My Activity'));
    expect(text()).toContain('Withdraw 2.000 ETH');

    mockRefund.mockRejectedValue(new Error('RPC offline'));
    rpc.getBalance.mockRejectedValue(new Error('RPC offline'));
    await refreshAll();

    expect(text()).toContain('Refund balance unavailable');
    expect(text()).toContain('Last known amount (stale): 2.000 ETH');
    expect(text()).not.toContain('Withdraw 2.000 ETH');
    expect(text()).not.toContain('No pending refunds');
    expect(container.querySelector('.nav-badge-alert')?.textContent).toBe('Refund?');
    expect(balanceText()).toBe('1.500 ETH (stale)');
    expect(text()).toContain('Refresh partly failed');
    expect(text()).toContain('Still unavailable: Refund balance (RPC offline); Wallet balance (RPC offline)');

    mockRefund.mockResolvedValue(0n);
    rpc.getBalance.mockResolvedValue(3n * ETH);
    await click(button('Retry refund balance'));
    expect(text()).toContain('No pending refunds');
    expect(text()).not.toContain('Refund balance unavailable');
    expect(balanceText()).toBe('1.500 ETH (stale)'); // wallet balance has its own retry
    await click(button('Retry wallet balance'));
    expect(balanceText()).toBe('3.000 ETH');
  });

  it('first refund read failure is unavailable rather than "No pending refunds"', async () => {
    mockRefund.mockRejectedValue(new Error('RPC offline'));
    await mount(<App />);
    await click(button('My Activity'));
    expect(text()).toContain('Refund balance unavailable');
    expect(text()).not.toContain('No pending refunds');
    expect(container.querySelector('.btn-withdraw-refund')).toBeNull();
  });

  it('a zero refund from a successful read still shows no pending refunds', async () => {
    await mount(<App />);
    await click(button('My Activity'));
    expect(text()).toContain('No pending refunds');
  });

  it('does not let a stale or unavailable balance decide bid affordability', async () => {
    const onSubmitBid = vi.fn(async () => {});
    function Harness() {
      return (
        <WalletProvider config={CONFIG_A}>
          <BidModal listing={listing('1', 'Sunny Garage')} onClose={() => {}} onSubmitBid={onSubmitBid} isSubmitting={false} />
          <Refresher />
        </WalletProvider>
      );
    }
    let refresh!: () => Promise<unknown>;
    function Refresher() {
      refresh = useWallet().refreshBalance;
      return null;
    }
    await mount(<Harness />);
    expect(text()).toContain('1.500 ETH');

    rpc.getBalance.mockRejectedValue(new Error('RPC offline'));
    await act(async () => {
      await refresh();
    });
    expect(text()).toContain('1.500 ETH (stale)');

    await act(async () => {
      container.querySelector('form')!.requestSubmit();
    });
    await settle();
    expect(text()).toContain('wallet balance is unavailable or may be out of date');
    expect(onSubmitBid).not.toHaveBeenCalled();
  });
});

describe('identity changes', () => {
  beforeEach(connectLocalWalletOnLoad);

  it('hides the previous account\'s refund immediately and ignores its late response', async () => {
    let wallet!: WalletContextValue;
    const Probe = () => {
      wallet = useWallet();
      return null;
    };
    const reads: { address: string; d: Deferred<bigint> }[] = [];
    mockRefund.mockImplementation((_contract, address) => {
      const d = deferred<bigint>();
      reads.push({ address, d });
      return d.promise;
    });
    await mount(
      <WalletProvider config={CONFIG_A}>
        <Probe />
        <AppContent config={CONFIG_A} configRead={readSucceeded()} onRefreshConfig={async () => READ_OK} />
      </WalletProvider>
    );
    await click(button('My Activity'));
    expect(reads.map((r) => r.address)).toEqual(['0xAccount1']);
    await act(async () => reads[0].d.resolve(5n * ETH));
    await settle();
    expect(text()).toContain('Withdraw 5.000 ETH');

    // Account 1 has another read in flight when the user switches to account 2.
    await refreshAll();
    const accountOneRead = reads[reads.length - 1];
    expect(accountOneRead.address).toBe('0xAccount1');
    await act(async () => {
      void wallet.connectLocal(2);
    });
    await settle();

    expect(text()).not.toContain('5.000');
    expect(text()).toContain('Checking for refunds');
    const accountTwoRead = reads[reads.length - 1];
    expect(accountTwoRead.address).toBe('0xAccount2');

    await act(async () => accountOneRead.d.resolve(9n * ETH));
    await settle();
    expect(text()).not.toContain('9.000');
    expect(text()).toContain('Checking for refunds');

    await act(async () => accountTwoRead.d.resolve(1n * ETH));
    await settle();
    expect(text()).toContain('Withdraw 1.000 ETH');
  });

  it.each([
    ['a different contract', CONFIG_B],
    ['the same chain and contract with a new deployment fingerprint', CONFIG_A_RESET],
  ])('hides the previous deployment\'s refund immediately for %s', async (_name, nextConfig) => {
    mockRefund.mockResolvedValue(4n * ETH);
    const ui = (config: Config) => (
      <WalletProvider config={config}>
        <AppContent config={config} configRead={readSucceeded()} onRefreshConfig={async () => READ_OK} />
      </WalletProvider>
    );
    await mount(ui(CONFIG_A));
    await click(button('My Activity'));
    expect(text()).toContain('Withdraw 4.000 ETH');

    const next = deferred<bigint>();
    mockRefund.mockImplementation(() => next.promise);
    await act(async () => {
      root!.render(ui(nextConfig));
    });
    // Synchronously after the render, before any new read completes.
    expect(text()).not.toContain('4.000');
    expect(text()).toContain('Checking for refunds');
    await act(async () => next.resolve(0n));
    await settle();
    expect(text()).toContain('No pending refunds');
  });
});

describe('deployment fingerprint and retry honesty', () => {
  it('hides listings and drops late responses when only the deployment fingerprint changes', async () => {
    const queue: Deferred<Listing[]>[] = [];
    mockListings.mockImplementation(() => {
      const d = deferred<Listing[]>();
      queue.push(d);
      return d.promise;
    });
    await mount(<App />);
    const base = queue.length;
    await act(async () => queue[base - 1].resolve([listing('1', 'Before Reset Spot')]));
    await settle();
    expect(text()).toContain('Before Reset Spot');

    mockConfig.mockResolvedValue(CONFIG_A_RESET);
    await refreshAll();
    expect(text()).not.toContain('Before Reset Spot');

    await act(async () => queue[base].resolve([listing('9', 'Late Old Chain Spot')]));
    await settle();
    expect(text()).not.toContain('Late Old Chain Spot');
    await act(async () => queue[base + 1].resolve([listing('2', 'After Reset Spot')]));
    await settle();
    expect(text()).toContain('After Reset Spot');
  });

  it('targeted retry does not claim success when its read was superseded', async () => {
    const queue: Deferred<Listing[]>[] = [];
    mockListings.mockImplementation(() => {
      const d = deferred<Listing[]>();
      queue.push(d);
      return d.promise;
    });
    await mount(<App />);
    const base = queue.length;
    await act(async () => queue[base - 1].reject(new Error('API offline')));
    await settle();

    await act(async () => {
      button('Retry listings').click();
      button('Retry listings').click();
    });
    await act(async () => queue[queue.length - 2].resolve([listing('1', 'Spot')]));
    await settle();
    expect(text()).toContain('read was replaced by a newer request');
    expect(text()).not.toContain('Listings reloaded');
  });
});

describe('balance identity across a same-address deployment reset', () => {
  it('never exposes the previous deployment balance as a current success, even for one render', async () => {
    storage.setItem('bidpark_wallet_type', 'local');
    storage.setItem('bidpark_account_index', '1');
    const onSubmitBid = vi.fn(async () => {});
    const statuses: string[] = [];
    let refresh!: WalletContextValue['refreshBalance'];
    const Probe = () => {
      const wallet = useWallet();
      refresh = wallet.refreshBalance;
      statuses.push(wallet.balanceRead.status);
      return null;
    };
    const ui = (config: Config) => (
      <WalletProvider config={config}>
        <Probe />
        <BidModal listing={listing('1', 'Sunny Garage')} onClose={() => {}} onSubmitBid={onSubmitBid} isSubmitting={false} />
      </WalletProvider>
    );
    await mount(ui(CONFIG_A));
    expect(statuses[statuses.length - 1]).toBe('success');
    expect(text()).toContain('1.500 ETH');

    // An old-deployment balance read is in flight when the same address is redeployed.
    const late = deferred<bigint>();
    rpc.getBalance.mockImplementation(() => late.promise);
    let oldRead!: Promise<unknown>;
    await act(async () => {
      oldRead = refresh();
    });
    const before = statuses.length;
    await act(async () => {
      root!.render(ui(CONFIG_A_RESET));
    });
    // Every render caused by the fingerprint change already reports stale, never success.
    expect(statuses.slice(before)).not.toContain('success');
    expect(statuses[before]).toBe('stale');
    expect(text()).toContain('1.500 ETH (stale)');

    await act(async () => {
      container.querySelector('form')!.requestSubmit();
    });
    await settle();
    expect(text()).toContain('wallet balance is unavailable or may be out of date');
    expect(onSubmitBid).not.toHaveBeenCalled();

    // The late completion from the old deployment is rejected and changes nothing.
    await act(async () => late.resolve(9n * ETH));
    await oldRead;
    await settle();
    expect(statuses[statuses.length - 1]).toBe('stale');
    expect(text()).not.toContain('9.000');
  });
});
