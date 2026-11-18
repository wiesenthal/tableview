// Run with `npm run test:js`. Cell formatting must never throw: the grid calls
// it while drawing, and an exception there used to take the whole window down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DateDay, makeData, makeVector, Table, tableFromIPC, tableToIPC, TimestampMicrosecond, Utf8, vectorFromArray } from "apache-arrow";
import { cellPreview, cellText } from "../../src/cells.ts";

const micros = [1700000000000000n, 1700000001500000n, 1700000002000000n, 1700000003000000n, 1700000004000000n];
function sample(): Table {
  const ts = makeVector(makeData({ type: new TimestampMicrosecond(), length: 5, nullCount: 0, data: new BigInt64Array(micros) }));
  const day = makeVector(makeData({ type: new DateDay(), length: 5, nullCount: 0, data: new Int32Array([0, 1, 19000, 19001, 19002]) }));
  const name = vectorFromArray(["a", "b", null, "d", "x".repeat(20_000)], new Utf8());
  // Round-trip through IPC like results from the backend.
  return tableFromIPC(tableToIPC(new Table({ ts, day, name })));
}

test("formats timestamps, dates, text and NULL", () => {
  const t = sample();
  assert.equal(cellText(t, 0, 0), "2023-11-14 22:13:20");
  assert.equal(cellText(t, 0, 1), "2023-11-14 22:13:21.5");
  assert.equal(cellText(t, 1, 1), "1970-01-02");
  assert.equal(cellText(t, 2, 1), "b");
  assert.equal(cellText(t, 2, 2), null);
});

test("rows the table doesn't have give null instead of throwing", () => {
  const t = sample();
  for (const row of [-1, 5, 99, 1.5, NaN, undefined as unknown as number]) {
    for (let col = 0; col < 4; col++) {
      assert.equal(cellText(t, col, row), null, `col ${col} row ${row}`);
      assert.deepEqual(cellPreview(t, col, row), { text: null, large: false });
    }
  }
});

test("sliced tables read the right values", () => {
  const s = sample().slice(2);
  assert.equal(cellText(s, 0, 0), "2023-11-14 22:13:22");
  assert.equal(cellText(s, 1, 2), "2022-01-10"); // original row 4 (day 19002)
  assert.equal(cellText(s, 2, 1), "d");
  assert.equal(cellPreview(s, 2, 2).large, true);
});

test("results in several record batches", () => {
  const a = sample(), b = sample();
  const t = new Table([...a.batches, ...b.batches]);
  assert.equal(cellText(t, 0, 7), "2023-11-14 22:13:22");
  assert.equal(cellText(t, 0, 10), null);
});
