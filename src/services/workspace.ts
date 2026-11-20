import type { DeploymentIdentity } from '../types';
export type SpotKind = 'garage' | 'driveway' | 'covered';
/** Fields of a saved listing draft or template; the dates are wall-clock text in the space's time zone. */
export interface DraftFields {
  title: string;
  address: string;
  neighborhood: string;
  description: string;
  image: string;
  spotKind: SpotKind;
  latitude: number;
  longitude: number;
  minBidEth: string;
  spaceId: string;
  cutoff: string;
  start: string;
  end: string;
  amenities?: string[];
  /** Id of the auction this draft would replace; the new auction links back to it. */
  replaces?: string;
}
export type DraftKind = 'draft' | 'template';
export interface SavedDraft extends Partial<DraftFields> {
  id: number;
  kind: DraftKind;
  name: string;
  updatedAt: number;
}

async function call<T>(route: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(route, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : `Request failed (${res.status})`);
  return data as T;
}

export const listDrafts = async () => (await call<{ drafts: SavedDraft[] }>('/api/drafts', 'GET')).drafts;
export const saveDraft = async (id: number | null, kind: DraftKind, name: string, fields: Partial<DraftFields>) =>
  (await call<{ id: number }>('/api/drafts', 'POST', { ...fields, ...(id === null ? {} : { id }), kind, name })).id;
export const deleteDraft = (id: number) => call<{ deleted: true }>(`/api/drafts/${id}`, 'DELETE');
export const reportSpace = (spaceId: string, reason: string, note: string) =>
  call<{ reported: true }>(`/api/spaces/${spaceId}/report`, 'POST', { reason, note });

export interface ArrivalCheckIn { winner: string; checkedInAt: number; blockNumber: number }
interface StoredInstructions { instructions: string; updatedAt: number }
export type ArrivalView =
  | { role: 'host'; spaceId: string; checkIn: ArrivalCheckIn | null; auction: StoredInstructions | null; space: StoredInstructions | null }
  | { role: 'winner'; checkIn: ArrivalCheckIn | null; instructions: string | null };

export const getArrival = (auctionId: string) => call<ArrivalView>(`/api/auctions/${auctionId}/arrival`, 'GET');
export const saveArrival = (scope: 'auctions' | 'spaces', id: string, instructions: string) =>
  call<{ saved: boolean }>(`/api/${scope}/${id}/arrival`, 'POST', { instructions });
export const checkInArrival = async (auctionId: string) =>
  (await call<{ checkIn: ArrivalCheckIn }>(`/api/auctions/${auctionId}/check-in`, 'POST', {})).checkIn;

export const linkReplacement = (originalId: string, replacementId: string) =>
  call<{ linked: true }>(`/api/auctions/${originalId}/replacement`, 'POST', { replacementId });
