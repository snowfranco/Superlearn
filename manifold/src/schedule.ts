// The edition cadence and its staleness gate.
//
// Product intent: a fresh Superlearn edition on Tuesday and Friday at 07:00
// America/Toronto (docs/adr/0001-manifold-runtime.md). The original workflow
// gated on the exact wall-clock hour: a bash step let the run proceed only
// when `TZ=America/Toronto date +%H` was "07". GitHub Actions cron cannot
// honor that. Scheduled runs are routinely delayed by hours and occasionally
// dropped, so the job almost always fired at 11:00 or 12:00 Toronto, the hour
// guard rejected it (proceed=false), every real step was skipped, and the job
// still reported "success". No edition was written and nothing looked broken:
// a silent skip. Editions only ever appeared from manual workflow_dispatch
// runs, which bypassed the guard, so the app's main page froze on whatever the
// last manual run produced (weeks stale).
//
// The fix is to stop gating on an instant. This module decides, from the
// calendar alone, whether the most recent scheduled slot still owes an edition
// by comparing that slot's date to the newest edition's date. The workflow now
// fires several times across the day; the first firing after a slot opens
// produces the edition, later firings that day see it is done and skip, and a
// delayed or dropped firing is caught by the next one (or by the next-day
// catch-up cron). This mirrors the ingest and sweep workflows, which are
// idempotent by design so a run Actions delays, doubles, or drops is harmless
// (.github/workflows/manifold-ingest.yml, manifold-sweep.yml).
//
// Everything here is pure and clock-injectable, so manifold/tests/
// schedule.test.ts covers the timezone and DST edges the untestable bash guard
// never could.

const TZ = 'America/Toronto';

/** Scheduled slot days, as Intl/`Date` weekday numbers (Sun=0 .. Sat=6):
 *  Tuesday and Friday. */
export const EDITION_WEEKDAYS: readonly number[] = [2, 5];

/** The hour (America/Toronto) at which a day's slot opens: 07:00. */
export const EDITION_HOUR = 7;

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export interface TorontoParts {
  /** YYYY-MM-DD in America/Toronto. */
  date: string;
  /** Hour 0..23 in America/Toronto. */
  hour: number;
  /** Weekday 0..6 (Sun..Sat) in America/Toronto. */
  weekday: number;
}

/** The wall-clock calendar fields of `date` in America/Toronto. One formatter
 *  yields date, hour, and weekday from the same instant, so a day boundary can
 *  never be read inconsistently across two calls. */
export function torontoParts(date: Date): TorontoParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(get('hour')) % 24; // some ICU builds render midnight as 24
  const weekday = WEEKDAY_INDEX[get('weekday').slice(0, 3)] ?? 0;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour, weekday };
}

/** The date (YYYY-MM-DD, America/Toronto) of the most recent scheduled slot at
 *  or before `now`: the latest Tuesday or Friday whose 07:00 America/Toronto
 *  has already passed. Today counts only once 07:00 has passed; before that,
 *  the most recent slot is an earlier slot day. Walks back in fixed 24h steps
 *  and reads only the calendar weekday and date. A 24h step can skip or repeat
 *  a calendar day across a DST transition, but transitions always fall on a
 *  Sunday (02:00), never a Tuesday or Friday, so a slot day is never missed;
 *  the <=8 bound leaves margin for the repeated day. */
export function mostRecentSlotDate(now: Date): string {
  for (let back = 0; back <= 8; back++) {
    const probe = torontoParts(new Date(now.getTime() - back * 86_400_000));
    if (!EDITION_WEEKDAYS.includes(probe.weekday)) continue;
    // The slot day is today but 07:00 has not arrived yet: keep looking back.
    if (back === 0 && probe.hour < EDITION_HOUR) continue;
    return probe.date;
  }
  // Unreachable: Tuesday and Friday are never more than 4 days apart, so a slot
  // day is always found within the window above.
  return torontoParts(now).date;
}

export interface DueDecision {
  /** True when the current slot still owes an edition. */
  due: boolean;
  /** The slot the decision is about (YYYY-MM-DD, America/Toronto). */
  slotDate: string;
  /** The newest edition's date at decision time, or null when none exists. */
  lastEditionDate: string | null;
  /** Human-readable explanation, logged by the CLI and shown in run output. */
  reason: string;
}

/** Whether the current scheduled slot still owes an edition. An edition is
 *  owed when the newest edition's date is older than the most recent slot (or
 *  when no edition exists at all). YYYY-MM-DD strings compare chronologically
 *  with `<`, so no date parsing is needed and the comparison is timezone-safe.
 *
 *  This is idempotent per slot: the moment an edition dated on or after the
 *  slot exists, `due` flips to false, so repeated firings in the same slot
 *  produce exactly one edition. The `edition_date` an edition receives is the
 *  Toronto date of its pass (manifold/src/editorial.ts), which is why the
 *  comparison lines up. */
export function editionDue(now: Date, lastEditionDate: string | null): DueDecision {
  const slotDate = mostRecentSlotDate(now);
  if (!lastEditionDate) {
    return {
      due: true,
      slotDate,
      lastEditionDate: null,
      reason: `no edition exists yet; the ${slotDate} slot is owed`,
    };
  }
  const due = lastEditionDate < slotDate;
  return {
    due,
    slotDate,
    lastEditionDate,
    reason: due
      ? `newest edition is dated ${lastEditionDate}, older than the current slot ${slotDate}: an edition is owed`
      : `newest edition ${lastEditionDate} is not older than the current slot ${slotDate}: already produced, nothing owed`,
  };
}
