import { expect, it } from 'vitest';
import { epochToZoned, findConflicts, parseSchedule, zonedToEpoch } from '../src/utils/schedule';

const AUSTIN = 'America/Chicago';

it('reads wall-clock times in the space zone, not the browser zone', () => {
  // 2030-03-01 22:30 CST (UTC-6) is 04:30 UTC next day.
  expect(zonedToEpoch('2030-03-01T22:30', AUSTIN)).toBe(Date.UTC(2030, 2, 2, 4, 30) / 1000);
  expect(zonedToEpoch('2030-07-01T22:30', AUSTIN)).toBe(Date.UTC(2030, 6, 2, 3, 30) / 1000);
  expect(zonedToEpoch('2030-03-01T22:30', 'Asia/Tokyo')).toBe(Date.UTC(2030, 2, 1, 13, 30) / 1000);
});

it('round-trips and handles the date boundary', () => {
  const sec = zonedToEpoch('2030-12-31T23:59', AUSTIN)!;
  expect(epochToZoned(sec, AUSTIN)).toBe('2030-12-31T23:59');
  expect(epochToZoned(sec + 60, AUSTIN)).toBe('2031-01-01T00:00');
});

it('rejects malformed input, unknown zones and times skipped by daylight saving', () => {
  expect(zonedToEpoch('2030-02-30T10:00', AUSTIN)).toBeNull();
  expect(zonedToEpoch('tomorrow', AUSTIN)).toBeNull();
  expect(zonedToEpoch('2030-03-01T10:00', 'Mars/Base')).toBeNull();
  // Clocks jump from 02:00 to 03:00 on 2030-03-10 in Chicago.
  expect(zonedToEpoch('2030-03-10T02:30', AUSTIN)).toBeNull();
  expect(zonedToEpoch('2030-03-10T03:30', AUSTIN)).not.toBeNull();
});

it('takes the first occurrence of a repeated hour when clocks go back', () => {
  // 01:30 happens twice on 2030-11-03; the first is CDT (UTC-5).
  expect(zonedToEpoch('2030-11-03T01:30', AUSTIN)).toBe(Date.UTC(2030, 10, 3, 6, 30) / 1000);
});

it('validates the order of cutoff, start and end', () => {
  const now = Date.UTC(2030, 0, 1) / 1000;
  const ok = parseSchedule({ cutoff: '2030-03-01T22:30', start: '2030-03-02T00:00', end: '2030-03-02T08:00' }, AUSTIN, now);
  expect(ok.schedule).toBeDefined();
  expect(ok.schedule!.end - ok.schedule!.start).toBe(8 * 3600); // an overnight window
  expect(parseSchedule({ cutoff: '2029-03-01T22:30', start: '2030-03-02T00:00', end: '2030-03-02T08:00' }, AUSTIN, now).error).toContain('future');
  expect(parseSchedule({ cutoff: '2030-03-02T01:00', start: '2030-03-02T00:00', end: '2030-03-02T08:00' }, AUSTIN, now).error).toContain('before bidding closes');
  expect(parseSchedule({ cutoff: '2030-03-01T22:30', start: '2030-03-02T08:00', end: '2030-03-02T08:00' }, AUSTIN, now).error).toContain('end after');
  expect(parseSchedule({ cutoff: '', start: '2030-03-02T08:00', end: '2030-03-02T09:00' }, AUSTIN, now).error).toContain('cutoff');
});

it('reports overlaps with held and blocked windows, but not adjacent ones', () => {
  const held = [{ start: 100, end: 200 }];
  const blocked = [{ start: 300, end: 400 }];
  expect(findConflicts({ start: 150, end: 350 }, held, blocked)).toEqual([
    { start: 100, end: 200, kind: 'held' }, { start: 300, end: 400, kind: 'blocked' },
  ]);
  expect(findConflicts({ start: 200, end: 300 }, held, blocked)).toEqual([]);
});
