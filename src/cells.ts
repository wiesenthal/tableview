/**
 * Turning Arrow cells into text. Everything here runs while the grid draws
 * (and for its hidden accessibility table), so none of it may throw: a bad
 * row index or an unexpected value gives a null or fallback text, never an
 * exception that takes the window down.
 */
import { DataType, type Data, type Table, type Vector } from "apache-arrow";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function formatMicros(us: bigint): string {
  const ms = Number(us / 1000n);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return us.toString();
  const frac = Number(((us % 1_000_000n) + 1_000_000n) % 1_000_000n);
  const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return frac ? `${base}.${String(frac).padStart(6, "0").replace(/0+$/, "")}` : base;
}

export function formatDays(days: number): string {
  const d = new Date(days * 86_400_000);
  if (Number.isNaN(d.getTime())) return String(days);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** A row index this table actually has. */
function inRange(table: Table, row: number): boolean {
  return Number.isInteger(row) && row >= 0 && row < table.numRows;
}

/**
 * The chunk holding `row` and the index within it. Arrow slices a chunk's
 * value buffers along with the chunk, so this index addresses `values` and
 * `valueOffsets` directly; `data.offset` only applies to the null bitmap.
 */
function locate(vec: Vector, row: number): { data: Data; r: number } | null {
  let r = row;
  for (const data of vec.data) {
    if (r < data.length) return { data, r };
    r -= data.length;
  }
  return null;
}

function plain(vec: Vector, row: number): string | null {
  const v: unknown = vec.get(row);
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  return String(v);
}

/** Text for one cell, or null for SQL NULL or a row the table doesn't have. Timestamps keep microseconds. */
export function cellText(table: Table, col: number, row: number): string | null {
  if (!inRange(table, row)) return null;
  const vec = table.getChildAt(col);
  if (!vec) return null;
  try {
    if (!vec.isValid(row)) return null;
    const type = vec.type;
    if (DataType.isTimestamp(type) || DataType.isDate(type)) {
      const at = locate(vec, row);
      const raw: unknown = at ? (at.data.values as ArrayLike<unknown>)[at.r] : undefined;
      if (DataType.isDate(type) && typeof raw === "number") return formatDays(raw);
      if (DataType.isTimestamp(type) && typeof raw === "bigint") return formatMicros(raw);
    }
    return plain(vec, row);
  } catch {
    try {
      return plain(vec, row);
    } catch {
      return "";
    }
  }
}

/** The raw UTF-8 bytes of a text cell, without decoding it; null for other types, NULL, or a missing row. */
function utf8Bytes(table: Table, col: number, row: number): Uint8Array | null {
  if (!inRange(table, row)) return null;
  const vec = table.getChildAt(col);
  if (!vec || !DataType.isUtf8(vec.type)) return null;
  try {
    if (!vec.isValid(row)) return null;
    const at = locate(vec, row);
    if (!at) return null;
    const offsets = at.data.valueOffsets as Int32Array | undefined;
    const start = offsets?.[at.r], end = offsets?.[at.r + 1];
    if (start === undefined || end === undefined || end < start) return null;
    return (at.data.values as Uint8Array).subarray(start, end);
  } catch {
    return null;
  }
}

/** Cells bigger than this are drawn from a decoded prefix, not the whole value. */
const LARGE_CELL_BYTES = 16 * 1024;
const PREVIEW_BYTES = 2048;
const decoder = new TextDecoder();

/**
 * Text to draw for a cell: the whole value, or for a large text cell (a 1 MB
 * document, a long JSON) only its start, so scrolling never decodes megabytes per frame.
 */
export function cellPreview(table: Table, col: number, row: number): { text: string | null; large: boolean } {
  const bytes = utf8Bytes(table, col, row);
  if (!bytes || bytes.length <= LARGE_CELL_BYTES) return { text: cellText(table, col, row), large: false };
  let end = PREVIEW_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--; // don't split a UTF-8 sequence
  return { text: decoder.decode(bytes.subarray(0, end)), large: true };
}
