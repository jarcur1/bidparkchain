import React, { StrictMode, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Listing } from '../src/types';

const wallet = {
  walletState: {
    type: 'local' as const,
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    balance: '10',
    chainId: 31337,
    isReady: true,
    isConnecting: false,
    error: null,
    localAccountIndex: 1,
  },
  wrongChain: false,
  connectLocal: vi.fn(async () => {}),
  connectInjected: vi.fn(async () => {}),
  switchInjectedChain: vi.fn(async () => {}),
};

vi.mock('../src/context/WalletContext', () => ({ useWallet: () => wallet }));

import { Dialog } from '../src/components/Dialog';
import { Header } from '../src/components/Header';
import { FilterBar } from '../src/components/FilterBar';
import { SpotGrid } from '../src/components/SpotGrid';
import { WalletModal } from '../src/components/WalletModal';
import { CreateListingModal } from '../src/components/CreateListingModal';
import { DetailModal } from '../src/components/DetailModal';
import { BidModal } from '../src/components/BidModal';
import { CURATED_PARKING_PHOTOS } from '../src/utils/constants';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  container.id = 'app-root';
  document.body.appendChild(container);
  root = createRoot(container);
  wallet.connectLocal.mockClear();
  wallet.connectInjected.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

const render = (ui: React.ReactElement) => act(() => root.render(ui));
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const press = (key: string, opts: KeyboardEventInit = {}, target: Element = document.activeElement ?? document.body) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};
const click = (el: Element) => act(() => (el as HTMLElement).click());
const dialogs = () => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
const isInert = (el: Element | null) => Boolean(el?.closest('[inert]'));

function listing(overrides: Partial<Listing> = {}): Listing {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: '1',
    owner: '0x0000000000000000000000000000000000000001',
    minBid: '0.05',
    highestBid: '0',
    highestBidder: '0x0000000000000000000000000000000000000000',
    bidEnd: now + 3600,
    parkingStart: now + 7200,
    parkingEnd: now + 14400,
    settled: false,
    cancelled: false,
    payoutClaimed: false,
    metadataHash: '0xabc',
    title: 'Test Driveway',
    address: '1 Test St, Austin',
    neighborhood: 'Downtown',
    latitude: 30.26,
    longitude: -97.74,
    description: 'A driveway',
    image: 'https://example.com/a.jpg',
    kind: 'driveway',
    amenities: ['Gated Entry'],
    ...overrides,
  };
}

describe('shared Dialog', () => {
  function Stack({ busy = false }: { busy?: boolean }) {
    const [a, setA] = useState(false);
    const [b, setB] = useState(false);
    return (
      <>
        <main>
          <button id="open-a" onClick={() => setA(true)}>open a</button>
        </main>
        {a && (
          <Dialog className="d" labelledBy="ta" onClose={() => setA(false)} canClose={!busy}>
            <h2 id="ta">A</h2>
            <button id="a-first">a first</button>
            <button id="open-b" onClick={() => setB(true)}>open b</button>
          </Dialog>
        )}
        {b && (
          <Dialog className="d" labelledBy="tb" onClose={() => setB(false)} canClose={!busy}>
            <h2 id="tb">B</h2>
            <button id="b-first">b first</button>
            <button id="b-last">b last</button>
          </Dialog>
        )}
      </>
    );
  }

  it('focuses the dialog, restores the opener and cleans up inert on close', () => {
    render(<Stack />);
    const opener = q('#open-a')!;
    opener.focus();
    click(opener);

    expect(dialogs()).toHaveLength(1);
    expect(document.activeElement).toBe(dialogs()[0]);
    expect(isInert(q('#app-root'))).toBe(true);
    expect(isInert(dialogs()[0])).toBe(false);

    press('Escape');
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(opener);
    expect(document.querySelector('[inert]')).toBeNull();
  });

  it('keeps lower dialogs inert and closes only the topmost dialog on Escape', () => {
    render(<Stack />);
    const opener = q('#open-a')!;
    opener.focus();
    click(opener);
    const openB = q('#open-b')!;
    openB.focus();
    click(openB);

    const [a, b] = dialogs();
    expect(isInert(a)).toBe(true);
    expect(isInert(b)).toBe(false);
    expect(isInert(q('#app-root'))).toBe(true);
    expect(document.activeElement).toBe(b);

    press('Escape');
    expect(dialogs()).toHaveLength(1);
    expect(dialogs()[0]).toBe(a);
    expect(isInert(a)).toBe(false);
    expect(document.activeElement).toBe(openB);
    expect(isInert(q('#app-root'))).toBe(true);

    press('Escape');
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(opener);
    expect(document.querySelector('[inert]')).toBeNull();
  });

  it('traps Tab and Shift+Tab inside the topmost dialog', () => {
    render(<Stack />);
    q('#open-a')!.focus();
    click(q('#open-a')!);
    click(q('#open-b')!);

    const first = q('#b-first')!;
    const last = q('#b-last')!;
    last.focus();
    expect(press('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    expect(press('Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    // Middle of the cycle is left to the browser.
    first.focus();
    expect(press('Tab').defaultPrevented).toBe(false);

    // Focus that escaped (or the dialog surface) re-enters at the correct end.
    (document.activeElement as HTMLElement).blur();
    press('Tab', {}, document.body);
    expect(document.activeElement).toBe(first);
  });

  it('ignores Escape while closing is blocked', () => {
    render(<Stack busy />);
    q('#open-a')!.focus();
    click(q('#open-a')!);
    press('Escape');
    expect(dialogs()).toHaveLength(1);
  });

  it('closes on backdrop click only when allowed', () => {
    render(<Stack />);
    click(q('#open-a')!);
    click(dialogs()[0]);
    expect(dialogs()).toHaveLength(1);
    click(dialogs()[0].parentElement!);
    expect(dialogs()).toHaveLength(0);
  });

  it('restores focus under StrictMode and when the opener has been removed', () => {
    function Removable() {
      const [open, setOpen] = useState(false);
      const [showOpener, setShowOpener] = useState(true);
      return (
        <>
          {showOpener && <button id="gone" onClick={() => { setOpen(true); }}>open</button>}
          <button id="stay">stay</button>
          {open && (
            <Dialog className="d" labelledBy="t" onClose={() => setOpen(false)}>
              <h2 id="t">T</h2>
              <button id="remove-opener" onClick={() => setShowOpener(false)}>remove</button>
            </Dialog>
          )}
        </>
      );
    }
    render(
      <StrictMode>
        <Removable />
      </StrictMode>
    );
    const opener = q('#gone')!;
    opener.focus();
    click(opener);
    expect(document.activeElement).toBe(dialogs()[0]);
    expect(isInert(q('#app-root'))).toBe(true);

    press('Escape');
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(opener);
    expect(document.querySelector('[inert]')).toBeNull();

    click(opener);
    click(q('#remove-opener')!);
    expect(() => press('Escape')).not.toThrow();
    expect(dialogs()).toHaveLength(0);
    expect(document.querySelector('[inert]')).toBeNull();
    expect(document.contains(document.activeElement) || document.activeElement === document.body).toBe(true);
  });
});

describe('native controls', () => {
  it('Header brand is a native button that activates the marketplace tab', () => {
    const onTabChange = vi.fn();
    render(
      <Header
        currentTab="activity"
        onTabChange={onTabChange}
        onOpenCreate={() => {}}
        onOpenWalletModal={() => {}}
        onRefresh={() => {}}
        isRefreshing={false}
        activeBidsCount={0}
      />
    );
    const brand = q<HTMLButtonElement>('.header-brand')!;
    expect(brand.tagName).toBe('BUTTON');
    expect(brand.querySelector('button, a, [role="button"], [tabindex]')).toBeNull();
    click(brand);
    expect(onTabChange).toHaveBeenCalledWith('marketplace');
  });

  it('search input has an accessible name', () => {
    render(
      <FilterBar
        filters={{ search: '', kind: 'all', status: 'all', minPrice: '', maxPrice: '', sortBy: 'ending-soon' }}
        onFilterChange={() => {}}
        totalSpots={1}
        filteredCount={1}
        viewMode="cards"
        onViewModeChange={() => {}}
      />
    );
    expect(q('.search-input')!.getAttribute('aria-label')).toBe('Search parking spots');
  });

  it('wallet accounts are single native buttons without nested controls', () => {
    render(<WalletModal isOpen onClose={() => {}} />);
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.demo-account-item'));
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.tagName).toBe('BUTTON');
      expect(row.querySelector('button, a, input, [role="button"], [tabindex]')).toBeNull();
    }
    expect(rows[rows.length - 1].textContent).toContain('Injected Web3 Provider');
    click(rows[rows.length - 1]);
    expect(wallet.connectInjected).toHaveBeenCalledTimes(1);
    const inactive = rows.find((r) => !r.classList.contains('is-active-account') && r !== rows[rows.length - 1])!;
    click(inactive);
    expect(wallet.connectLocal).toHaveBeenCalledTimes(1);
  });

  it('listing cards expose native buttons incl. a keyboard-operable select control, with no focusable region wrapper', () => {
    const onOpenDetail = vi.fn();
    const onOpenBid = vi.fn();
    const onSelectListing = vi.fn();
    render(
      <SpotGrid
        listings={[listing()]}
        isLoading={false}
        currentAddress={wallet.walletState.address}
        selectedListingId={null}
        onSelectListing={onSelectListing}
        onOpenBid={onOpenBid}
        onOpenDetail={onOpenDetail}
        onSettle={() => {}}
        onResetFilters={() => {}}
      />
    );
    const card = q('article.spot-card')!;
    expect(card.hasAttribute('tabindex')).toBe(false);
    expect(card.getAttribute('role')).toBeNull();
    expect(card.querySelectorAll('button button, [role="button"]').length).toBe(0);
    const buttons = Array.from(card.querySelectorAll('button'));
    const select = card.querySelector<HTMLButtonElement>('button.card-select-btn')!;
    expect(select.getAttribute('aria-pressed')).toBe('false');
    click(select);
    expect(onSelectListing).toHaveBeenCalledTimes(1);
    expect(onSelectListing.mock.calls[0][0].id).toBe(listing().id);
    const bid = buttons.find((b) => b.textContent?.includes('Bid Now'))!;
    click(bid);
    expect(onOpenBid).toHaveBeenCalledTimes(1);
    click(buttons.find((b) => b.textContent?.includes('Details'))!);
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(onSelectListing).toHaveBeenCalledTimes(1);
  });
});

describe('CreateListingModal', () => {
  const renderCreate = (extra: Partial<React.ComponentProps<typeof CreateListingModal>> = {}) =>
    render(
      <CreateListingModal
        isOpen
        onClose={() => {}}
        onSubmitCreate={async () => {}}
        pendingRegistration={null}
        isSubmitting={false}
        {...extra}
      />
    );

  it('uses native photo buttons, labelled custom URL and pressed amenity toggles', () => {
    renderCreate();
    const thumbs = Array.from(document.querySelectorAll<HTMLButtonElement>('.photo-thumb-option'));
    expect(thumbs.length).toBeGreaterThan(1);
    expect(thumbs.every((t) => t.tagName === 'BUTTON' && t.getAttribute('aria-label'))).toBe(true);
    expect(thumbs[0].getAttribute('aria-pressed')).toBe('true');
    click(thumbs[1]);
    expect(thumbs[0].getAttribute('aria-pressed')).toBe('false');
    expect(thumbs[1].getAttribute('aria-pressed')).toBe('true');

    const url = q<HTMLInputElement>('#spot-image-url')!;
    expect(document.querySelector('label[for="spot-image-url"]')?.textContent).toContain('custom image URL');
    expect(url.value).toBe(CURATED_PARKING_PHOTOS[1].url);

    const amenity = q<HTMLButtonElement>('.amenity-chip-toggle')!;
    const before = amenity.getAttribute('aria-pressed');
    expect(['true', 'false']).toContain(before);
    click(amenity);
    expect(amenity.getAttribute('aria-pressed')).toBe(before === 'true' ? 'false' : 'true');
  });

  it('focuses the title, blocks Escape while submitting and announces progress', () => {
    const onClose = vi.fn();
    renderCreate({ onClose });
    expect(document.activeElement).toBe(q('#spot-title'));
    press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);

    renderCreate({ onClose, isSubmitting: true });
    press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(q('[role="status"].sr-only')!.textContent).toMatch(/Deploying auction/);
  });
});

describe('BidModal', () => {
  it('focuses the amount input and honors the submitting close guard', () => {
    const onClose = vi.fn();
    render(<BidModal listing={listing()} onClose={onClose} onSubmitBid={async () => {}} isSubmitting={false} />);
    expect(document.activeElement).toBe(q('#bid-amount-input'));
    render(<BidModal listing={listing()} onClose={onClose} onSubmitBid={async () => {}} isSubmitting />);
    press('Escape');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('keyboard-only browse, connect, create and bid journey (no map)', () => {
  function Journey() {
    const [wallet_, setWallet] = useState(false);
    const [create, setCreate] = useState(false);
    const [detail, setDetail] = useState<Listing | null>(null);
    const [bid, setBid] = useState<Listing | null>(null);
    const l = listing();
    return (
      <>
        <Header
          currentTab="marketplace"
          onTabChange={() => {}}
          onOpenCreate={() => setCreate(true)}
          onOpenWalletModal={() => setWallet(true)}
          onRefresh={() => {}}
          isRefreshing={false}
          activeBidsCount={0}
        />
        <SpotGrid
          listings={[l]}
          isLoading={false}
          currentAddress={wallet.walletState.address}
          selectedListingId={null}
          onSelectListing={() => {}}
          onOpenBid={setBid}
          onOpenDetail={setDetail}
          onSettle={() => {}}
          onResetFilters={() => {}}
        />
        <WalletModal isOpen={wallet_} onClose={() => setWallet(false)} />
        <CreateListingModal
          isOpen={create}
          onClose={() => setCreate(false)}
          onSubmitCreate={async () => {}}
          pendingRegistration={null}
          isSubmitting={false}
        />
        <DetailModal
          listing={detail}
          currentAddress={wallet.walletState.address}
          onClose={() => setDetail(null)}
          onOpenBid={(x) => {
            setDetail(null);
            setBid(x);
          }}
          onSettle={() => {}}
          onCancel={() => {}}
          onClaimPayout={() => {}}
          isActionBusy={false}
        />
        <BidModal listing={bid} onClose={() => setBid(null)} onSubmitBid={async () => {}} isSubmitting={false} />
      </>
    );
  }

  it('completes with native buttons and returns focus after each dialog', () => {
    render(<Journey />);

    const walletBtn = q<HTMLButtonElement>('.wallet-btn')!;
    walletBtn.focus();
    click(walletBtn);
    expect(dialogs()).toHaveLength(1);
    expect(isInert(q('.site-header'))).toBe(true);
    click(q('.demo-account-item')!);
    expect(wallet.connectLocal).toHaveBeenCalled();
    press('Escape');
    expect(document.activeElement).toBe(walletBtn);

    const createBtn = q<HTMLButtonElement>('.nav-action-create')!;
    createBtn.focus();
    click(createBtn);
    expect(document.activeElement).toBe(q('#spot-title'));
    press('Escape');
    expect(document.activeElement).toBe(createBtn);

    const detailsBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.btn-card-secondary'))[0];
    detailsBtn.focus();
    click(detailsBtn);
    expect(dialogs()).toHaveLength(1);
    const bidFromDetail = Array.from(dialogs()[0].querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      /bid/i.test(b.textContent ?? '')
    )!;
    bidFromDetail.focus();
    click(bidFromDetail);

    expect(dialogs()).toHaveLength(1);
    expect(document.activeElement).toBe(q('#bid-amount-input'));
    press('Escape');
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(detailsBtn);
    expect(document.querySelector('[inert]')).toBeNull();
  });
});
