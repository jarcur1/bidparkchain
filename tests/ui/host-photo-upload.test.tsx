import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as Workspace from '../../src/services/workspace';
import { HostWorkspace } from '../../src/components/HostWorkspace';
import { listDrafts } from '../../src/services/workspace';
import { PHOTO_MAX_BYTES } from '../../shared/validation.js';

vi.mock('../../src/services/workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof Workspace>()),
  listDrafts: vi.fn(async () => []),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const HASH = 'a'.repeat(64);
const OLD = 'https://images.example.com/old.jpg';
const props = {
  signedIn: true, spaces: [], spacesError: null, listings: [], verifications: [], isActionBusy: false,
  account: null, changeTarget: null, onSpaceAction: vi.fn(async () => true), onPublish: vi.fn(async () => {}),
  onSignIn: vi.fn(), onChangeDone: vi.fn(), onBookingAction: vi.fn(async () => {}), onCancelListing: vi.fn(async () => {}),
};

/** Stands in for XMLHttpRequest so each test decides how the upload answers. */
class FakeXhr {
  static requests: FakeXhr[] = [];
  method = '';
  url = '';
  body: unknown = null;
  headers: Record<string, string> = {};
  aborted = false;
  status = 0;
  responseText = '';
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.requests.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
  fail() {
    this.onerror?.();
  }
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  FakeXhr.requests = [];
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

/** Lets pending upload promises settle and React apply the state they change. */
const settle = () => act(() => sleep(0));
async function mount(overrides: Partial<typeof props> = {}) {
  act(() => root.render(<HostWorkspace {...props} {...overrides} />));
  await settle();
}
/** The input inside the form label whose text starts with `text`. */
function field(text: string) {
  const label = [...host.querySelectorAll('label')].find((el) => el.textContent?.startsWith(text));
  return label!.querySelector('input')!;
}
/** Types into a controlled input the way a user does, so React sees the change. */
function typeInto(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
/** Picks a file in the upload control, as the browser does once the user confirms one. */
async function choose(file: File) {
  const input = field('Upload a photo');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}
const jpeg = () => new File([JPEG], 'driveway.jpg', { type: 'image/jpeg' });
const alerts = () => [...host.querySelectorAll('[role="alert"]')].map((el) => el.textContent);

it('is disabled with a sign-in hint when signed out', async () => {
  await mount({ signedIn: false });
  expect(field('Upload a photo').disabled).toBe(true);
  expect(host.textContent).toContain('Sign in with your wallet to upload a photo.');
});

it('sends the photo as raw bytes, shows progress, then fills the photo field with the returned path', async () => {
  await mount();
  expect(field('Upload a photo').accept).toBe('image/jpeg,image/png,image/webp');
  const file = jpeg();
  await choose(file);
  const [request] = FakeXhr.requests;
  expect([request.method, request.url, request.body]).toEqual(['POST', '/api/photos', file]);
  expect(request.headers['Content-Type']).toBe('application/octet-stream');
  expect(field('Upload a photo').disabled).toBe(true);

  act(() => request.progress(50, 100));
  await settle();
  expect(host.querySelector('progress')?.getAttribute('value')).toBe('0.5');
  expect(host.textContent).toContain('50%');
  expect(field('Photo URL').value).toBe('');

  act(() => request.respond(201, { path: `/api/photos/${HASH}.jpg` }));
  await settle();
  expect(field('Photo URL').value).toBe(`/api/photos/${HASH}.jpg`);
  expect(host.querySelector('progress')).toBeNull();
  expect(field('Upload a photo').disabled).toBe(false);
});

it('keeps the previous photo and shows the server message when the upload is refused', async () => {
  await mount();
  typeInto(field('Photo URL'), OLD);
  await choose(jpeg());
  act(() => FakeXhr.requests[0].respond(415, { error: 'Photo must be a JPEG, PNG or WebP image' }));
  await settle();
  expect(alerts()).toContain('Photo must be a JPEG, PNG or WebP image');
  expect(field('Photo URL').value).toBe(OLD);
  expect(host.querySelector('progress')).toBeNull();
});

it('explains a dropped connection and keeps the previous photo', async () => {
  await mount();
  typeInto(field('Photo URL'), OLD);
  await choose(jpeg());
  act(() => FakeXhr.requests[0].fail());
  await settle();
  expect(alerts()).toContain('Upload failed. Check your connection and try again.');
  expect(field('Photo URL').value).toBe(OLD);
});

it('refuses a file over 2 MB without sending it', async () => {
  await mount();
  await choose(new File([new Uint8Array(PHOTO_MAX_BYTES + 1)], 'huge.jpg', { type: 'image/jpeg' }));
  expect(FakeXhr.requests).toHaveLength(0);
  expect(alerts()).toContain('Photo must be 2 MB or smaller.');
});

it('cancels an upload in flight and keeps the previous photo', async () => {
  await mount();
  typeInto(field('Photo URL'), OLD);
  await choose(jpeg());
  const cancelButton = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancel upload')!;
  act(() => cancelButton.click());
  await settle();
  expect(FakeXhr.requests[0].aborted).toBe(true);
  expect(host.querySelector('progress')).toBeNull();
  expect(alerts().join(' ')).not.toContain('Upload');
  expect(field('Photo URL').value).toBe(OLD);
});

it('abandons an upload when the workspace unmounts', async () => {
  await mount();
  await choose(jpeg());
  act(() => root.unmount());
  expect(FakeXhr.requests[0].aborted).toBe(true);
});

it('drops an upload started in one draft when another draft is opened', async () => {
  const saved = (id: number, name: string) => ({ id, kind: 'draft' as const, name, updatedAt: 1, image: OLD });
  vi.mocked(listDrafts).mockResolvedValueOnce([saved(1, 'Draft A'), saved(2, 'Draft B')]);
  await mount();
  const open = (name: string) => [...host.querySelectorAll('li, .inbox-item, div')]
    .filter((el) => el.textContent?.includes(name) && el.querySelector(':scope > .verification-form'))
    .map((el) => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Open')!)[0];
  act(() => open('Draft A').click());
  await settle();
  await choose(jpeg());
  act(() => open('Draft B').click());
  await settle();
  expect(FakeXhr.requests[0].aborted).toBe(true);
  act(() => FakeXhr.requests[0].respond(201, { path: `/api/photos/${HASH}.jpg` }));
  await settle();
  expect(field('Photo URL').value).toBe(OLD);
  expect(host.querySelector('progress')).toBeNull();
});
