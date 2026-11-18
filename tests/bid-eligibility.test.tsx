import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChainSnapshot, Config, Listing } from '../src/types';

// ---------------------------------------------------------------------------
// Mocks: wallet context, HTTP API, wallet transactions, and Leaflet (no layout in jsdom)
// ---------------------------------------------------------------------------

const OWNER = '0x00000000000000000000000000000000000000a1';
const BIDDER = '0x00000000000000000000000000000000000000b2';
const CONTRACT = '0x00000000000000000000000000000000000000c3';

const h = vi.hoisted(() => {
  const wallet = {
    walletState: {
      type: 'local',
      address: null as string | null,
      balance: '10.0',
      chainId: 31337,
      isReady: true,
      isConnecting: false,
      error: null,
      localAccountIndex: 1,
    },
    signer: {},
    provider: null,
    wrongChain: false,
    connectLocal: async () => {},
    connectInjected: async () => {},
    switchInjectedChain: async () => {},
    refreshBalance: async () => {},
  };

  interface FakeMarker {
    content: HTMLElement | null;
  }
  const markers: FakeMarker[] = [];
  const chainable = () => {
    const obj: Record<string, unknown> = {};
    obj.on = () => obj;
    obj.addTo = () => obj;
    obj.addLayer = () => obj;
    obj.removeLayer = () => obj;
    return obj;
  };
  const leaflet = {
    map: () => ({ remove() {}, invalidateSize() {}, setView() {}, panTo() {} }),
    control: { zoom: () => chainable() },
    tileLayer: () => chainable(),
    layerGroup: () => chainable(),
    divIcon: () => ({}),
    marker: () => {
      const marker: FakeMarker & Record<string, unknown> = {
        content: null,
        setLatLng: () => marker,
        getElement: () => null,
        getPopup: () => ({
          setContent: (el: HTMLElement) => {
            marker.content = el;
          },
        }),
        bindPopup: (el: HTMLElement) => {
          marker.content = el;
          return marker;
        },
        on: () => marker,
      };
      markers.push(marker);
      return marker;
    },
  };
  return { wallet, markers, leaflet };
});

vi.mock('leaflet', () => ({ default: h.leaflet }));
vi.mock('../src/context/WalletContext', () => ({
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
  useWallet: () => h.wallet,
}));
vi.mock('../src/services/api', () => ({
  fetchConfig: vi.fn(),
  fetchListings: vi.fn(),
  createListingRecord: vi.fn(),
}));
vi.mock('../src/services/blockchain', async (importActual) => ({
  ...(await importActual<typeof import('../src/services/blockchain')>()),
  getContractInstance: vi.fn(() => ({})),
  fetchPendingReturns: vi.fn(async () => 0n),
  placeBid: vi.fn(),
}));

import { AppContent } from '../src/App';
import { fetchListings } from '../src/services/api';
import { placeBid } from '../src/services/blockchain';
import { resetChainClock } from '../src/utils/eligibility';

// ---------------------------------------------------------------------------
// Fixtures and harness
// ---------------------------------------------------------------------------

const config = {
  chainId: 31337,
  contractAddress: CONTRACT,
  abi: [],
  currency: 'ETH',
  networkName: 'Hardhat Local',
  demoMnemonic: '',
  demoAccountIndex: 1,
  deploymentBlock: 1,
} as Config;

const baseChain: ChainSnapshot = {
  chainId: 31337,
  contractAddress: CONTRACT,
  deploymentBlock: 1,
  deploymentBlockHash: '0xdeploy-a',
  blockNumber: 10,
  blockTimestamp: 1000,
  chainTime: 1000,
};

function makeListing(id: string, overrides: Partial<Listing> = {}): Listing {
  return {
    id,
    owner: OWNER,
    minBid: '0.1',
    highestBid: '0',
    highestBidder: '0x0000000000000000000000000000000000000000',
    bidEnd: 5000,
    parkingStart: 6000,
    parkingEnd: 9000,
    settled: false,
    cancelled: false,
    payoutClaimed: false,
    metadataHash: `0xhash-${id}`,
    title: `Spot ${id}`,
    address: `${id} Main St`,
    neighborhood: 'Downtown',
    latitude: 30.26 + Number(id) / 1000,
    longitude: -97.74,
    description: 'Public description',
    image: '',
    kind: 'garage',
    amenities: [],
    ...overrides,
  };
}

const server: { listings: Listing[]; chain: ChainSnapshot } = {
  listings: [],
  chain: baseChain,
};

let container: HTMLDivElement;
let root: Root;

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mountApp() {
  await act(async () => {
    root.render(<AppContent config={config} configError={null} />);
  });
  await flush();
}

async function rerender() {
  await act(async () => {
    root.render(<AppContent config={config} configError={null} />);
  });
}

async function poll() {
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Refresh data"]')!.click();
  });
  await flush();
}

async function click(el: Element | null) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

async function typeAmount(value: string) {
  const input = document.querySelector<HTMLInputElement>('#bid-amount-input')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const card = (id: string) => document.getElementById(`spot-card-${id}`);
const cardHasBid = (id: string) => Boolean(card(id)?.textContent?.includes('Bid Now'));
const bidDialog = () => document.querySelector('.modal-bid-dialog');
const amountInput = () => document.querySelector<HTMLInputElement>('#bid-amount-input');
const submitButton = () => document.querySelector<HTMLButtonElement>('.btn-modal-submit-bid');
const dialogAlerts = () =>
  Array.from(bidDialog()?.querySelectorAll('[role="alert"], [role="status"]') ?? [])
    .map((el) => el.textContent)
    .join(' | ');

function popupFor(title: string): HTMLElement | undefined {
  return h.markers
    .map((m) => m.content)
    .find((el) => el?.querySelector('.popup-title')?.textContent === title) ?? undefined;
}
const popupHasBid = (title: string) => Boolean(popupFor(title)?.querySelector('.popup-btn-bid'));

async function openBidDialogFor(id: string) {
  await click(card(id)!.querySelector('.btn-card-primary'));
  expect(bidDialog()).not.toBeNull();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
  resetChainClock();
  h.markers.length = 0;
  h.wallet.walletState.address = BIDDER;
  server.listings = [makeListing('1')];
  server.chain = { ...baseChain };
  vi.mocked(fetchListings).mockImplementation(async () => ({
    listings: server.listings.map((l) => ({ ...l })),
    chain: { ...server.chain },
  }));
  vi.mocked(placeBid).mockReset();
  vi.mocked(placeBid).mockResolvedValue({ hash: '0xtx' } as never);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

// ---------------------------------------------------------------------------

describe('open bid dialog stays synchronized with chain listing state', () => {
  it('updates price while preserving the amount the user typed', async () => {
    await mountApp();
    await openBidDialogFor('1');
    await typeAmount('0.5');

    server.listings = [makeListing('1', { highestBid: '0.3', highestBidder: OWNER })];
    await poll();

    expect(bidDialog()?.textContent).toContain('Current Highest Bid');
    expect(bidDialog()?.textContent).toContain('0.300 ETH');
    expect(amountInput()!.value).toBe('0.5');
  });

  it('follows the live suggestion only while the user has not edited the amount', async () => {
    await mountApp();
    await openBidDialogFor('1');
    expect(amountInput()!.value).toBe('0.1');

    server.listings = [makeListing('1', { highestBid: '0.3', highestBidder: OWNER })];
    await poll();
    expect(amountInput()!.value).toBe('0.31');
  });

  it('submits a valid bid after revalidating against current chain state', async () => {
    await mountApp();
    await openBidDialogFor('1');
    await click(submitButton());

    expect(placeBid).toHaveBeenCalledTimes(1);
    expect(vi.mocked(placeBid).mock.calls[0].slice(1)).toEqual(['1', '0.1']);
    expect(bidDialog()).toBeNull();
  });

  describe('competing bid', () => {
    it('flags a newer highest bid that undercuts the typed amount and offers the new minimum', async () => {
      await mountApp();
      await openBidDialogFor('1');
      await typeAmount('0.5');

      server.listings = [makeListing('1', { highestBid: '0.6', highestBidder: OWNER })];
      await poll();

      expect(amountInput()!.value).toBe('0.5');
      expect(dialogAlerts()).toContain('price changed');
      expect(dialogAlerts()).toContain('below the minimum');

      await click(submitButton());
      expect(placeBid).not.toHaveBeenCalled();
      expect(dialogAlerts()).toContain('strictly higher');
      expect(amountInput()!.value).toBe('0.5');
    });

    it('rejects at submit when a competing bid landed since the last poll, without sending a transaction', async () => {
      await mountApp();
      await openBidDialogFor('1');
      await typeAmount('0.5');

      // Chain moves after the dialog's last poll; the dialog still shows the old price.
      server.listings = [makeListing('1', { highestBid: '0.7', highestBidder: OWNER })];
      await click(submitButton());

      expect(placeBid).not.toHaveBeenCalled();
      expect(dialogAlerts()).toContain('Another bid raised the price to 0.7 ETH');
      // Input retained and dialog refreshed to the competing price.
      expect(amountInput()!.value).toBe('0.5');
      expect(bidDialog()?.textContent).toContain('0.700 ETH');
    });
  });

  describe('closure during edit', () => {
    it('disables bidding at the chain cutoff, keeping the typed amount', async () => {
      await mountApp();
      await openBidDialogFor('1');
      await typeAmount('0.5');
      expect(cardHasBid('1')).toBe(true);

      server.chain = { ...baseChain, blockTimestamp: 4990, chainTime: 5000 };
      await poll();

      expect(dialogAlerts()).toContain('Bidding has closed');
      expect(submitButton()!.disabled).toBe(true);
      expect(amountInput()!.disabled).toBe(true);
      expect(amountInput()!.value).toBe('0.5');
      expect(cardHasBid('1')).toBe(false);
      expect(popupHasBid('Spot 1')).toBe(false);
    });

    it.each([
      ['cancelled', { cancelled: true }, 'cancelled'],
      ['settled', { settled: true }, 'settled'],
    ])('disables bidding when the auction is %s', async (_name, change, message) => {
      await mountApp();
      await openBidDialogFor('1');
      await typeAmount('0.5');

      server.listings = [makeListing('1', change)];
      await poll();

      expect(dialogAlerts()).toContain(message);
      expect(submitButton()!.disabled).toBe(true);
      expect(amountInput()!.value).toBe('0.5');
    });

    it('refuses to send a transaction if the auction closed between the last poll and submit', async () => {
      await mountApp();
      await openBidDialogFor('1');

      server.chain = { ...baseChain, blockTimestamp: 5001, chainTime: 5001 };
      await click(submitButton());

      expect(placeBid).not.toHaveBeenCalled();
      expect(dialogAlerts()).toContain('Bidding has closed');
    });
  });

  describe('changed owner / deployment', () => {
    it('blocks bidding when the connected account is the listing owner', async () => {
      await mountApp();
      await openBidDialogFor('1');

      h.wallet.walletState.address = OWNER;
      await rerender();

      expect(dialogAlerts()).toContain('owners cannot bid');
      expect(submitButton()!.disabled).toBe(true);
    });

    it('re-evaluates against a changed on-chain owner', async () => {
      await mountApp();
      await openBidDialogFor('1');

      server.listings = [makeListing('1', { owner: BIDDER })];
      await poll();

      expect(dialogAlerts()).toContain('owners cannot bid');
      expect(submitButton()!.disabled).toBe(true);
      expect(cardHasBid('1')).toBe(false);
    });

    it('closes the dialog when the deployment identity changes, even if the auction id is reused', async () => {
      await mountApp();
      await openBidDialogFor('1');

      server.chain = { ...baseChain, deploymentBlockHash: '0xdeploy-b' };
      await poll();

      expect(bidDialog()).toBeNull();
      expect(placeBid).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain('Bid dialog closed');
    });

    it('closes the dialog when a reused auction id carries different metadata', async () => {
      await mountApp();
      await openBidDialogFor('1');
      await typeAmount('0.5');

      server.listings = [makeListing('1', { metadataHash: '0xhash-other', title: 'Different spot' })];
      await poll();

      expect(bidDialog()).toBeNull();

      // Re-opening the new listing starts fresh: the old typed amount is not carried over.
      await openBidDialogFor('1');
      expect(amountInput()!.value).toBe('0.1');
    });

    it('closes the dialog when the listing disappears', async () => {
      await mountApp();
      await openBidDialogFor('1');

      server.listings = [];
      await poll();

      expect(bidDialog()).toBeNull();
    });

    it('does not send a transaction when the deployment changed before submit', async () => {
      await mountApp();
      await openBidDialogFor('1');

      server.chain = { ...baseChain, contractAddress: '0x00000000000000000000000000000000000000d4' };
      await click(submitButton());

      expect(placeBid).not.toHaveBeenCalled();
    });
  });
});

describe('one eligibility rule for cards, map popups, and the dialog', () => {
  const scenarios: Array<[string, Partial<Listing>, boolean]> = [
    ['2', {}, true],
    ['3', { bidEnd: 900 }, false], // ended but unsettled
    ['4', { cancelled: true }, false],
    ['5', { settled: true }, false],
    ['6', { owner: BIDDER }, false],
  ];

  beforeEach(() => {
    server.listings = scenarios.map(([id, change]) => makeListing(id, change));
  });

  it.each(scenarios)('listing %s: card and map popup agree (bid offered: %s)', async (id, _change, expected) => {
    await mountApp();
    expect(cardHasBid(id)).toBe(expected);
    expect(popupHasBid(`Spot ${id}`)).toBe(expected);
  });

  it('removes Bid from map popup and card together when the chain clock reaches the cutoff', async () => {
    await mountApp();
    expect(cardHasBid('2')).toBe(true);
    expect(popupHasBid('Spot 2')).toBe(true);

    server.chain = { ...baseChain, blockTimestamp: 5000, chainTime: 5000 };
    await poll();

    expect(cardHasBid('2')).toBe(false);
    expect(popupHasBid('Spot 2')).toBe(false);
  });
});
