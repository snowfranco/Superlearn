// Everything one editorial pass reads, gathered into a single PassInputs
// value. Two producers share this shape: live Supabase (here) and eval
// fixtures (evals/runner.ts), so the pass itself is a pure function of its
// inputs and the evals grade the same code path that runs for real.
import {
  contextRowSchema,
  editionRowSchema,
  outboxRowSchema,
  parseRows,
  readingItemRowSchema,
  themeLinkRowSchema,
  themeRowSchema,
} from './app-contract.ts';
import type {
  AppContext,
  OutboxItem,
  ReadingItem,
  Theme,
  ThemeLink,
} from './app-contract.ts';
import type { ManifoldConfig } from './env.ts';
import { parkPayloadItemIds } from './outbox.ts';
import { isTableMissing, type SupabaseClient } from './supabase.ts';
import { loadState, type ManifoldState } from './state.ts';

export interface PassInputs {
  /** Recent and unread items, newest first, read flags already joined from
   * article_read_states (the app writes flags there, not on the item row). */
  items: ReadingItem[];
  context: AppContext | null;
  existingThemes: Theme[];
  existingLinks: ThemeLink[];
  /** 0 when no edition exists yet. */
  maxEditionNo: number;
  /** Recent lede titles, so consecutive editions do not repeat a lede. */
  recentLedeTitles: string[];
  state: ManifoldState;
  /** The editorial exclusion set: item ids the reader already handled, as
   * read (article_read_states read=true) or parked (outbox rows with kind
   * 'park' in the rolling window, any status, plus manifold state parks).
   * Excluded items never lead and never appear in start_here (gate check
   * no-excluded-item-leads); they may still back themes and emerging
   * entries, because reader engagement is clustering signal. */
  excludedItemIds: string[];
  /** Below this many viable (non-excluded) candidates, the prompt asks for
   * a smaller honest edition instead of padding (MANIFOLD_EDITION_FLOOR). */
  editionFloor: number;
  /** The pass clock, injectable so fixtures are deterministic. */
  nowIso: string;
}

const RECENT_DAYS = 30;

export function selectItems(all: ReadingItem[], cap: number, nowIso: string): ReadingItem[] {
  const cutoff = Date.parse(nowIso) - RECENT_DAYS * 86_400_000;
  const eligible = all.filter((i) => {
    const ts = Date.parse(i.publishedAt ?? i.addedAt);
    return !i.read || (!Number.isNaN(ts) && ts >= cutoff);
  });
  eligible.sort(
    (a, b) => (Date.parse(b.publishedAt ?? b.addedAt) || 0) - (Date.parse(a.publishedAt ?? a.addedAt) || 0),
  );
  return eligible.slice(0, cap);
}

/** The reads-plus-parks join, shared by the live fetch and (in spirit) the
 * eval runner's materialize: reads come from the read flags, parks from the
 * window-scanned outbox park rows and manifold state. */
export function buildExclusionSet(
  readIds: Iterable<string>,
  parkedOutboxIds: Iterable<string>,
  state: ManifoldState,
): string[] {
  const excluded = new Set<string>(readIds);
  for (const id of parkedOutboxIds) excluded.add(id);
  for (const p of state.parked) for (const id of p.itemIds) excluded.add(id);
  return [...excluded];
}

/** Items still eligible to lead or be recommended after exclusion. */
export function viableItems(inputs: PassInputs): ReadingItem[] {
  const excluded = new Set(inputs.excludedItemIds);
  return inputs.items.filter((i) => !excluded.has(i.id));
}

export async function fetchPassInputs(sb: SupabaseClient, config: ManifoldConfig): Promise<PassInputs> {
  const parkCutoffIso = new Date(Date.now() - config.parkWindowDays * 86_400_000).toISOString();
  const [itemRows, readStateRows, contextRows, themeRows, linkRows, editionRows, parkRows] = await Promise.all([
    sb.fetch<unknown[]>(`/reading_items?order=added_at.desc&limit=${config.itemCap * 2}`),
    sb.fetch<{ article_id?: string; read?: boolean }[]>('/article_read_states?limit=1000'),
    sb.fetch<unknown[]>(`/context?tenant=eq.${encodeURIComponent(config.tenant)}&limit=1`),
    // Freshest first: if the map ever outgrows the window, the stalest
    // themes fall out of carry-forward, not the live ones.
    sb.fetch<unknown[]>('/themes?order=updated_at.desc&limit=500'),
    sb.fetch<unknown[]>('/theme_links?limit=500'),
    // id must be selected: the reader schema requires it and would drop the
    // row otherwise, silently restarting edition numbering at 1.
    sb.fetch<unknown[]>('/editions?select=id,edition_no,lede,created_at&order=created_at.desc&limit=10'),
    // Every park in the rolling window, ANY status: a queued park is already
    // a reader decision, so exclusion never waits on the sweep.
    sb.fetch<unknown[]>(
      `/outbox?kind=eq.park&created_at=gte.${encodeURIComponent(parkCutoffIso)}&order=created_at.desc&limit=500`,
    ),
  ]);

  const readMap = new Map<string, boolean>();
  for (const row of readStateRows) {
    if (row.article_id) readMap.set(row.article_id, row.read ?? false);
  }

  const items = parseRows(itemRows, readingItemRowSchema, 'reading_items').map((i) => ({
    ...i,
    read: readMap.get(i.id) ?? i.read,
  }));

  const editions = parseRows(editionRows, editionRowSchema, 'editions');
  const state = await loadState(sb, config.tenant);
  const readIds = [...readMap.entries()].filter(([, read]) => read).map(([id]) => id);
  const parkedOutboxIds = parseRows(parkRows, outboxRowSchema, 'outbox').flatMap((row) =>
    parkPayloadItemIds(row.payload),
  );
  const nowIso = new Date().toISOString();

  return {
    items: selectItems(items, config.itemCap, nowIso),
    context: parseRows(contextRows, contextRowSchema, 'context')[0] ?? null,
    existingThemes: parseRows(themeRows, themeRowSchema, 'themes'),
    existingLinks: parseRows(linkRows, themeLinkRowSchema, 'theme_links'),
    maxEditionNo: Math.max(0, ...editions.map((e) => e.editionNo ?? 0)),
    recentLedeTitles: editions.flatMap((e) => (e.lede ? [e.lede.title] : [])).slice(0, 5),
    state,
    excludedItemIds: buildExclusionSet(readIds, parkedOutboxIds, state),
    editionFloor: config.editionFloor,
    nowIso,
  };
}

/** The newest edition's date (YYYY-MM-DD, America/Toronto), or null when no
 *  edition exists. The schedule gate (manifold/src/schedule.ts) reads this to
 *  decide whether the current slot still owes an edition, without paying for
 *  the full pass-inputs fetch or a model call, so a not-due firing exits in one
 *  cheap read.
 *
 *  Degrades to null only when the editions table is genuinely missing (first
 *  run, unmigrated backend). A transient read failure rethrows: treating a
 *  network blip as "no edition" would report an edition owed and risk a second
 *  edition for a slot that already has one. `edition_date=not.is.null` guards
 *  against a stray null sorting first under `desc`. */
export async function fetchLatestEditionDate(sb: SupabaseClient): Promise<string | null> {
  try {
    const rows = await sb.fetch<{ edition_date?: string | null }[]>(
      '/editions?select=edition_date&edition_date=not.is.null&order=edition_date.desc&limit=1',
    );
    return rows[0]?.edition_date ?? null;
  } catch (err) {
    if (isTableMissing(err)) return null;
    throw err;
  }
}

export async function fetchQueuedOutbox(sb: SupabaseClient): Promise<OutboxItem[]> {
  const rows = await sb.fetch<unknown[]>('/outbox?status=eq.queued&order=created_at.asc&limit=100');
  return parseRows(rows, outboxRowSchema, 'outbox');
}
