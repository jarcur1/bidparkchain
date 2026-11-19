import { ApiError } from './api';

export interface Session {
  address: string;
  chainId: number;
  expiresAt: number;
}

async function post<T>(route: string, body?: unknown): Promise<T> {
  const res = await fetch(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(typeof data?.error === 'string' ? data.error : `Request failed (${res.status})`, res.status);
  return data as T;
}

export const requestSignIn = (address: string) =>
  post<{ nonce: string; message: string; expiresAt: number }>('/api/auth/nonce', { address });

export const verifySignIn = (nonce: string, signature: string) =>
  post<Session>('/api/auth/verify', { nonce, signature });

export const signOutSession = () => post<{ signedOut: true }>('/api/auth/logout');

/** The current session, or null when not signed in. Other failures throw. */
export async function fetchSession(): Promise<Session | null> {
  const res = await fetch('/api/auth/session');
  if (res.status === 401) return null;
  if (!res.ok) throw new ApiError(`Session check failed (${res.status})`, res.status);
  return (await res.json()) as Session;
}

export type ProfileRole = 'driver' | 'host' | 'both';
export interface Profile {
  role: ProfileRole;
  displayName: string;
}

/** The signed-in wallet's profile, or null if it has not saved one. */
export async function fetchProfile(): Promise<Profile | null> {
  const res = await fetch('/api/profile');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(typeof data?.error === 'string' ? data.error : `Profile read failed (${res.status})`, res.status);
  return (data as { profile: Profile | null }).profile;
}

export const saveProfile = (profile: Profile) => post<{ profile: Profile }>('/api/profile', profile);
