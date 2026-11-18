import { DataType, Field } from "apache-arrow";

/**
 * Every user preference is declared here once. The Settings dialog renders
 * these definitions, and the backend stores the values without knowing them,
 * so adding a setting means adding one entry.
 */
export type PrefDef =
  | { key: string; section: string; label: string; description: string; kind: "toggle"; default: boolean }
  | { key: string; section: string; label: string; description: string; kind: "select"; default: string; options: { value: string; label: string }[] };

export const PREF_DEFS = [
  {
    key: "compactIds", section: "Grid", kind: "toggle", default: true,
    label: "Shorten IDs",
    description: "Show long values in ID, primary key and foreign key columns as abc…xyz. Copying, editing and the row inspector use the full value.",
  },
  {
    key: "timestampPrecision", section: "Grid", kind: "select", default: "minute",
    label: "Timestamps",
    description: "How much of each date-time to show. Editing and the row inspector always use the exact value.",
    options: [
      { value: "minute", label: "Minutes · 2026-11-02 02:30" },
      { value: "second", label: "Seconds · 2026-11-02 02:30:49" },
      { value: "full", label: "Full · 2026-11-02 02:30:49.635" },
    ],
  },
  {
    key: "timeZone", section: "Grid", kind: "select", default: "utc",
    label: "Time zone",
    description: "Zone for columns that store an instant (timestamptz, MySQL TIMESTAMP). Plain timestamps are shown as stored.",
    options: [
      { value: "utc", label: "UTC" },
      { value: "local", label: "This Mac's time zone" },
    ],
  },
] as const satisfies readonly PrefDef[];

type Def = (typeof PREF_DEFS)[number];
export type Prefs = { [D in Def as D["key"]]: D["default"] extends boolean ? boolean : string };

export const DEFAULT_PREFS = Object.fromEntries(PREF_DEFS.map((d) => [d.key, d.default])) as Prefs;

export function withDefaults(saved: Record<string, unknown>): Prefs {
  const out = { ...DEFAULT_PREFS } as Record<string, unknown>;
  for (const d of PREF_DEFS) {
    const v = saved[d.key];
    if (d.kind === "toggle" && typeof v === "boolean") out[d.key] = v;
    if (d.kind === "select" && typeof v === "string" && d.options.some((o) => o.value === v)) out[d.key] = v;
  }
  return out as Prefs;
}

/** Column names that hold identifiers: id, user_id, surveyId, uuid, author_ids. */
const ID_SNAKE = /^(id|uuid|guid)$|_(id|uuid|guid)s?$|^id_/i;
const ID_CAMEL = /[a-z0-9](Id|ID|Uuid|UUID)s?$/;

export function isIdColumn(name: string, keys?: Set<string>): boolean {
  return (keys?.has(name) ?? false) || ID_SNAKE.test(name) || ID_CAMEL.test(name);
}

export function shortenId(v: string): string {
  return v.length > 9 ? `${v.slice(0, 3)}…${v.slice(-3)}` : v;
}

export type ColumnFormat = { id: boolean; ts: "naive" | "zoned" | null };

export function columnFormats(fields: Field[], keys?: Set<string>): ColumnFormat[] {
  return fields.map((f) => ({
    id: isIdColumn(f.name, keys),
    ts: DataType.isTimestamp(f.type) ? ((f.type as { timezone?: string | null }).timezone ? "zoned" : "naive") : null,
  }));
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `text` is the exact value, as `YYYY-MM-DD HH:MM:SS[.ffffff]` in UTC for zoned columns. */
export function formatTimestamp(text: string, zoned: boolean, prefs: Prefs): string {
  let t = text;
  if (zoned && prefs.timeZone === "local") {
    const d = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(t) ? new Date(`${t.slice(0, 10)}T${t.slice(11, 19)}Z`) : new Date(NaN);
    if (!Number.isNaN(d.getTime())) {
      const frac = t.slice(19);
      t = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${frac}`;
    }
  }
  if (prefs.timestampPrecision === "minute") return t.slice(0, 16);
  if (prefs.timestampPrecision === "second") return t.slice(0, 19);
  return t;
}

/** What the grid shows for a cell, given its exact text. */
export function displayText(text: string, fmt: ColumnFormat | undefined, prefs: Prefs): string {
  if (!fmt) return text;
  if (fmt.ts) return formatTimestamp(text, fmt.ts === "zoned", prefs);
  if (fmt.id && prefs.compactIds) return shortenId(text);
  return text;
}
