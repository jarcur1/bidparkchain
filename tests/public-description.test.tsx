import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Listing, SpotMetadata } from '../src/types';

vi.mock('../src/context/WalletContext', () => ({
  useWallet: () => ({
    walletState: { address: '0x0000000000000000000000000000000000000001' },
    wrongChain: false,
  }),
}));

import { CreateListingModal } from '../src/components/CreateListingModal';
import { DetailModal } from '../src/components/DetailModal';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const q = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

const button = (text: string): HTMLButtonElement => {
  const el = Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(text)
  );
  if (!el) throw new Error(`missing button ${text}`);
  return el as HTMLButtonElement;
};

const typeInto = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const submitForm = () =>
  act(() => {
    q<HTMLFormElement>('form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
  });

const click = (el: HTMLElement) => act(() => el.click());

const DESCRIPTION = '  Level concrete driveway, good lighting, 2.1m clearance.  ';

const renderCreate = (props: Partial<React.ComponentProps<typeof CreateListingModal>> = {}) => {
  const onSubmitCreate = vi.fn().mockResolvedValue(undefined);
  const onRetryRegistration = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  act(() =>
    root.render(
      <CreateListingModal
        isOpen
        onClose={onClose}
        onSubmitCreate={onSubmitCreate}
        onRetryRegistration={onRetryRegistration}
        pendingRegistration={null}
        isSubmitting={false}
        {...props}
      />
    )
  );
  return { onSubmitCreate, onRetryRegistration, onClose };
};

const fillForm = () => {
  typeInto(q<HTMLInputElement>('#spot-title'), '  Test Driveway  ');
  typeInto(q<HTMLInputElement>('#spot-address'), '1 Test St, Austin, TX');
  typeInto(q<HTMLTextAreaElement>('#spot-desc'), DESCRIPTION);
};

describe('public description field', () => {
  it('labels the description public, warns beside it, and has no private-access prompts', () => {
    renderCreate();
    const textarea = q<HTMLTextAreaElement>('#spot-desc');
    const label = q<HTMLLabelElement>('label[for="spot-desc"]');
    expect(label.textContent).toBe('Public space description');

    const warning = document.getElementById(textarea.getAttribute('aria-describedby')!)!;
    expect(warning.textContent).toMatch(/public/i);
    expect(warning.textContent).toMatch(/not supported/i);
    expect(warning.parentElement).toBe(textarea.parentElement);

    const copy = `${label.textContent} ${textarea.placeholder} ${warning.textContent}`;
    expect(copy).not.toMatch(/gate|pin\b|passcode|access route|arrival/i);
    expect(q('[role="dialog"]').textContent).not.toMatch(/arrival guidelines/i);
  });
});

describe('submission preview', () => {
  it('shows exact normalized public metadata and warning, and does not submit before confirmation', async () => {
    const { onSubmitCreate } = renderCreate();
    fillForm();
    submitForm();

    expect(onSubmitCreate).not.toHaveBeenCalled();
    const preview = q('[data-testid="submission-preview"]');
    expect(preview.textContent).toMatch(/public/i);
    expect(preview.querySelector('#preview-public-warning')!.textContent).toMatch(
      /not supported/i
    );
    expect(preview.querySelector('[data-field="title"]')!.textContent).toBe('Test Driveway');
    expect(preview.querySelector('[data-field="address"]')!.textContent).toBe(
      '1 Test St, Austin, TX'
    );
    expect(preview.querySelector('[data-field="description"]')!.textContent).toBe(
      DESCRIPTION.trim()
    );

    await act(async () => button('Confirm and Deploy Auction').click());
    expect(onSubmitCreate).toHaveBeenCalledTimes(1);
    const [metadata, minBid] = onSubmitCreate.mock.calls[0];
    expect(metadata.title).toBe('Test Driveway');
    expect(metadata.description).toBe(DESCRIPTION.trim());
    expect(minBid).toBe('0.05');
    expect(Object.keys(metadata).sort()).toEqual(
      [
        'address',
        'amenities',
        'description',
        'image',
        'kind',
        'latitude',
        'longitude',
        'neighborhood',
        'title',
      ]
    );
  });

  it('Edit returns to the form without submitting and editing invalidates the preview', async () => {
    const { onSubmitCreate } = renderCreate();
    fillForm();
    submitForm();
    expect(document.querySelector('[data-testid="submission-preview"]')).not.toBeNull();

    click(button('Edit listing'));
    expect(document.querySelector('[data-testid="submission-preview"]')).toBeNull();
    expect(document.activeElement).toBe(q('#spot-title'));
    expect(onSubmitCreate).not.toHaveBeenCalled();

    submitForm();
    expect(document.querySelector('[data-testid="submission-preview"]')).not.toBeNull();
    typeInto(q<HTMLTextAreaElement>('#spot-desc'), 'Changed description of the space.');
    expect(document.querySelector('[data-testid="submission-preview"]')).toBeNull();
    expect(() => button('Confirm and Deploy Auction')).toThrow();

    submitForm();
    expect(
      q('[data-testid="submission-preview"] [data-field="description"]').textContent
    ).toBe('Changed description of the space.');
    await act(async () => button('Confirm and Deploy Auction').click());
    expect(onSubmitCreate).toHaveBeenCalledTimes(1);
    expect(onSubmitCreate.mock.calls[0][0].description).toBe('Changed description of the space.');
  });

  it('does not preview invalid metadata', () => {
    const { onSubmitCreate } = renderCreate();
    fillForm();
    typeInto(q<HTMLTextAreaElement>('#spot-desc'), 'short');
    submitForm();
    expect(document.querySelector('[data-testid="submission-preview"]')).toBeNull();
    expect(q('[role="alert"]').textContent).toMatch(/Description length/);
    expect(onSubmitCreate).not.toHaveBeenCalled();
  });

  it('pending registration is immutable, previewed, and only retries metadata registration', async () => {
    const pendingMetadata: SpotMetadata = {
      title: 'Pending Spot',
      address: '5 Pending Ave, Austin, TX',
      neighborhood: 'Downtown Austin',
      latitude: 30.26,
      longitude: -97.74,
      description: 'Covered carport with lighting and wide entry.',
      image: 'https://example.com/photo.jpg',
      kind: 'covered',
      amenities: ['Lighting'],
    };
    const { onSubmitCreate, onRetryRegistration, onClose } = renderCreate({
      pendingRegistration: { auctionId: '7', metadata: pendingMetadata },
    });

    expect(q<HTMLFieldSetElement>('fieldset').disabled).toBe(true);
    expect(q<HTMLTextAreaElement>('#spot-desc').value).toBe(pendingMetadata.description);

    submitForm();
    expect(onRetryRegistration).not.toHaveBeenCalled();
    const preview = q('[data-testid="submission-preview"]');
    expect(preview.querySelector('[data-field="description"]')!.textContent).toBe(
      pendingMetadata.description
    );
    expect(preview.textContent).toMatch(/no new auction is created/i);
    expect(preview.querySelector('[data-field="minBid"]')).toBeNull();

    await act(async () => button('Confirm and Complete Registration (#7)').click());
    expect(onRetryRegistration).toHaveBeenCalledWith('7', pendingMetadata);
    expect(onSubmitCreate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the preview and shows the error when registration retry fails', async () => {
    const pendingMetadata: SpotMetadata = {
      title: 'Pending Spot',
      address: '5 Pending Ave, Austin, TX',
      neighborhood: 'Downtown Austin',
      latitude: 30.26,
      longitude: -97.74,
      description: 'Covered carport with lighting and wide entry.',
      image: 'https://example.com/photo.jpg',
      kind: 'covered',
      amenities: [],
    };
    const failingRetry = vi.fn().mockRejectedValue(new Error('API down'));
    const { onClose } = renderCreate({
      pendingRegistration: { auctionId: '7', metadata: pendingMetadata },
      onRetryRegistration: failingRetry,
    });
    submitForm();
    await act(async () => button('Confirm and Complete Registration (#7)').click());
    expect(failingRetry).toHaveBeenCalledWith('7', pendingMetadata);
    expect(q('[role="alert"]').textContent).toBe('API down');
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="submission-preview"]')).not.toBeNull();
  });
});

describe('detail modal', () => {
  it('headlines the description as public', () => {
    const listing: Listing = {
      id: '1',
      owner: '0x0000000000000000000000000000000000000002',
      minBid: '1',
      highestBid: '0',
      highestBidder: '0x0000000000000000000000000000000000000000',
      bidEnd: Math.floor(Date.now() / 1000) + 3600,
      parkingStart: Math.floor(Date.now() / 1000) + 7200,
      parkingEnd: Math.floor(Date.now() / 1000) + 14400,
      settled: false,
      cancelled: false,
      payoutClaimed: false,
      metadataHash: '0x' + '11'.repeat(32),
      title: 'Test',
      address: '1 Test St',
      neighborhood: 'Downtown',
      latitude: 30,
      longitude: -97,
      description: 'Level driveway with good lighting.',
      image: 'https://example.com/a.jpg',
      kind: 'driveway',
      amenities: [],
    };
    act(() =>
      root.render(
        <DetailModal
          listing={listing}
          currentAddress={null}
          onClose={() => {}}
          onOpenBid={() => {}}
          onSettle={() => {}}
          onCancel={() => {}}
          onClaimPayout={() => {}}
          isActionBusy={false}
        />
      )
    );
    const dialog = q('[role="dialog"]');
    const headings = Array.from(dialog.querySelectorAll('h4')).map((h) => h.textContent);
    expect(headings).toContain('Public Space Description');
    expect(dialog.textContent).not.toMatch(/arrival notes/i);
    expect(dialog.textContent).toContain('Level driveway with good lighting.');
  });
});
