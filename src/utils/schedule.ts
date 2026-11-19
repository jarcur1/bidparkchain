/**
 * Explicit-date scheduling in a space's own time zone. Inputs are `YYYY-MM-DDTHH:mm` values (what a
 * datetime-local field holds) read as wall-clock time in an IANA zone, never the browser's zone.
 */
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function isValidZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone.length > 0;
  } catch {
    return false;
  }
}

/** Offset of `timeZone` from UTC at an instant, in ms. */
function offsetAt(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(ms / 1000) * 1000;
}

/**
 * Unix seconds for a wall-clock time in `timeZone`. Null when the text is malformed, the zone is
 * unknown, or the time does not exist there (skipped by a daylight-saving jump). An ambiguous time
 * (repeated when clocks go back) resolves to its first occurrence.
 */
export function zonedToEpoch(local: string, timeZone: string): number | null {
  const m = LOCAL.exec(local);
  if (!m || !isValidZone(timeZone)) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  if (new Date(wall).getUTCMonth() !== mo - 1 || h > 23 || mi > 59) return null;
  // Try both offsets around the instant; keep those whose wall clock matches the input.
  const candidates = new Set<number>();
  for (const probe of [wall - 86_400_000, wall + 86_400_000]) {
    const guess = wall - offsetAt(probe, timeZone);
    if (wall === guess + offsetAt(guess, timeZone)) candidates.add(guess);
  }
  if (candidates.size === 0) return null;
  return Math.min(...candidates) / 1000;
}

/** The wall-clock text for an instant in `timeZone`, in the same form zonedToEpoch reads. */
export function epochToZoned(sec: number, timeZone: string): string {
  const wall = new Date(sec * 1000 + offsetAt(sec * 1000, timeZone));
  return wall.toISOString().slice(0, 16);
}

export interface Span { start: number; end: number }
export interface Conflict extends Span { kind: 'held' | 'blocked' }

/** Windows that overlap [start, end). Windows that merely touch do not conflict, as on-chain. */
export function findConflicts(span: Span, held: Span[], blocked: Span[]): Conflict[] {
  const hit = (w: Span) => span.start < w.end && w.start < span.end;
  return [
    ...held.filter(hit).map((w) => ({ ...w, kind: 'held' as const })),
    ...blocked.filter(hit).map((w) => ({ ...w, kind: 'blocked' as const })),
  ];
}

export interface Schedule { bidEnd: number; start: number; end: number }

/** Reads and checks the three explicit times. Returns the instants, or the first problem. */
export function parseSchedule(
  input: { cutoff: string; start: string; end: string },
  timeZone: string,
  nowSec: number,
): { schedule: Schedule; error?: undefined } | { schedule?: undefined; error: string } {
  if (!isValidZone(timeZone)) return { error: `"${timeZone}" is not a known time zone.` };
  const read = (label: string, value: string) => {
    if (!value) return `Choose the ${label}.`;
    const sec = zonedToEpoch(value, timeZone);
    return sec === null ? `The ${label} does not exist in ${timeZone} (check daylight-saving changes).` : sec;
  };
  const bidEnd = read('bidding cutoff', input.cutoff);
  const start = read('parking start', input.start);
  const end = read('parking end', input.end);
  for (const v of [bidEnd, start, end]) if (typeof v === 'string') return { error: v };
  const [c, s, e] = [bidEnd, start, end] as number[];
  if (c <= nowSec) return { error: 'The bidding cutoff must be in the future.' };
  if (s < c) return { error: 'Parking cannot start before bidding closes.' };
  if (e <= s) return { error: 'Parking must end after it starts.' };
  return { schedule: { bidEnd: c, start: s, end: e } };
}
