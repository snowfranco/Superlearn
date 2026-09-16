// The schedule gate that replaced the fragile exact-hour bash guard
// (manifold/src/schedule.ts). These are pure, clock-injected, no Supabase and
// no model, so CI runs them (npm run manifold:evals:ci) with no key.
//
// The bug they lock down: GitHub Actions delayed the edition cron by hours, so
// the old guard (proceed only when it is exactly 07:00 in Toronto) skipped
// nearly every run while reporting success, and the app's edition went weeks
// stale. The gate here is date-based instead: it asks whether the most recent
// Tuesday/Friday slot still owes an edition, which a delayed run answers the
// same as an on-time one. All reference times were cross-checked against
// `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' })`.
import { describe, it, expect } from 'vitest';
import {
  editionDue,
  mostRecentSlotDate,
  torontoParts,
} from '../src/schedule.ts';

const at = (iso: string) => new Date(iso);

describe('torontoParts', () => {
  it('reads weekday, hour, and date in America/Toronto (EDT)', () => {
    // 2026-09-15T22:00Z is Tue 18:00 in Toronto (EDT, UTC-4).
    expect(torontoParts(at('2026-09-15T22:00:00Z'))).toEqual({
      date: '2026-09-15',
      hour: 18,
      weekday: 2,
    });
  });

  it('reads the same instant correctly under EST', () => {
    // 2026-11-03T13:00Z is Tue 08:00 in Toronto (EST, UTC-5).
    expect(torontoParts(at('2026-11-03T13:00:00Z'))).toEqual({
      date: '2026-11-03',
      hour: 8,
      weekday: 2,
    });
  });
});

describe('mostRecentSlotDate', () => {
  const cases: [string, string, string][] = [
    // [now (UTC), expected slot date, note]
    ['2026-09-15T22:00:00Z', '2026-09-15', 'Tue 18:00 EDT: today, past 07:00'],
    ['2026-09-15T15:29:00Z', '2026-09-15', 'Tue 11:29 EDT: the real delayed run #22'],
    ['2026-09-15T09:00:00Z', '2026-09-11', 'Tue 05:00 EDT: before 07:00, falls to prior Fri'],
    ['2026-09-16T10:00:00Z', '2026-09-15', 'Wed 06:00 EDT: catch-up points at Tue slot'],
    ['2026-09-11T15:50:00Z', '2026-09-11', 'Fri 11:50 EDT: the real delayed run #21'],
    ['2026-09-13T18:00:00Z', '2026-09-11', 'Sun afternoon: most recent slot is Fri'],
    ['2026-11-03T13:00:00Z', '2026-11-03', 'Tue 08:00 EST: today, past 07:00'],
    ['2026-11-03T11:30:00Z', '2026-10-30', 'Tue 06:00 EST: before 07:00, falls to prior Fri'],
    ['2026-11-04T11:00:00Z', '2026-11-03', 'Wed 06:00 EST: catch-up points at Tue slot'],
    ['2026-03-10T12:00:00Z', '2026-03-10', 'Tue 08:00 EDT, spring-forward week'],
  ];
  for (const [now, expected, note] of cases) {
    it(`${note} -> ${expected}`, () => {
      expect(mostRecentSlotDate(at(now))).toBe(expected);
    });
  }
});

describe('editionDue', () => {
  it('is due when the newest edition predates the current slot (the live bug)', () => {
    // The exact situation on 2026-09-15: newest edition is #4 dated 2026-09-06,
    // the Tue slot is owed. Every scheduled run since was silently skipped.
    const d = editionDue(at('2026-09-15T22:00:00Z'), '2026-09-06');
    expect(d.due).toBe(true);
    expect(d.slotDate).toBe('2026-09-15');
  });

  it('is due even for a run GitHub delayed to late morning (date-based, not hour-based)', () => {
    // Run #22 fired at 11:29 EDT; the old hour guard skipped it. The gate does not.
    expect(editionDue(at('2026-09-15T15:29:00Z'), '2026-09-06').due).toBe(true);
  });

  it('is not due once an edition dated on the slot exists (idempotent per slot)', () => {
    const d = editionDue(at('2026-09-15T22:00:00Z'), '2026-09-15');
    expect(d.due).toBe(false);
    expect(d.slotDate).toBe('2026-09-15');
  });

  it('is not due for a repeat firing later the same slot day', () => {
    // First firing produced an edition dated 2026-09-15; a 19:00 UTC firing
    // (15:00 Toronto) must not produce a second.
    expect(editionDue(at('2026-09-15T23:00:00Z'), '2026-09-15').due).toBe(false);
  });

  it('is due again on the next slot', () => {
    // Fri 2026-09-18 after a Tue 2026-09-15 edition.
    expect(editionDue(at('2026-09-18T15:00:00Z'), '2026-09-15').due).toBe(true);
  });

  it('is not due before 07:00 on a slot day when the prior slot is already filled', () => {
    // Tue 05:00 EDT, Friday's edition already exists: nothing owed until 07:00.
    expect(editionDue(at('2026-09-15T09:00:00Z'), '2026-09-11').due).toBe(false);
  });

  it('self-heals: a Wednesday catch-up produces the missed Tuesday edition', () => {
    // Every Tue firing dropped; last edition is the prior Friday. Wed 06:00 EDT
    // catch-up sees the Tue slot still owed.
    const d = editionDue(at('2026-09-16T10:00:00Z'), '2026-09-11');
    expect(d.due).toBe(true);
    expect(d.slotDate).toBe('2026-09-15');
  });

  it('waits before 07:00 under EST too', () => {
    expect(editionDue(at('2026-11-03T11:30:00Z'), '2026-10-30').due).toBe(false);
  });

  it('produces after 07:00 under EST', () => {
    expect(editionDue(at('2026-11-03T13:00:00Z'), '2026-10-30').due).toBe(true);
  });

  it('is due when no edition exists at all', () => {
    const d = editionDue(at('2026-09-15T22:00:00Z'), null);
    expect(d.due).toBe(true);
    expect(d.lastEditionDate).toBe(null);
  });

  it('is not due when the newest edition is somehow ahead of the slot', () => {
    // Defensive: a manual future-dated edition must not trigger a re-produce.
    expect(editionDue(at('2026-09-15T22:00:00Z'), '2026-09-18').due).toBe(false);
  });
});
