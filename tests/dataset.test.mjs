import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDataset, parseCsv } from '../src/dataset.mjs';
const rows = () => Array.from({ length: 35 }, (_, i) => ({ timestamp: new Date(Date.UTC(2020, 0, 1, 9, i)).toISOString(), bars: { A: { open: 10, high: 11, low: 9, close: 10.5, volume: 100 } } }));
const csv = data => ['timestamp,symbol,open,high,low,close,volume', ...data.map(row => `${row.timestamp},A,10,11,9,10.5,100`)].join('\n');

test('normalizes explicit timezone offsets and closes a validated copy', () => {
  const data = rows(); data[0].timestamp = '2020-01-01T14:30:00+05:30';
  const result = validateDataset(data); assert.equal(result.rows[0].timestamp, '2020-01-01T09:00:00.000Z'); assert.equal(result.rows[0].bars.A.closed, true);
  result.rows[0].bars.A.close = 9; assert.equal(data[0].bars.A.close, 10.5);
  assert.equal(parseCsv(csv(rows())).rows.length, 35);
});
test('rejects ambiguous timezone, invalid calendar dates, future or open bars', () => {
  for (const stamp of ['2020-01-01T09:00:00', '2020-02-30T09:00:00Z', '2020-01-01T25:00:00Z', '2020-01-01T09:00:00+14:30', '2099-01-01T09:00:00Z']) {
    const data = rows(); data[0].timestamp = stamp; assert.throws(() => validateDataset(data));
  }
  for (const change of [data => { data[0].closed = false; }, data => { data[0].bars.A.isClosed = false; }, data => { data[0].bars.A.timestamp = '2020-01-01T08:00:00Z'; }]) {
    const data = rows(); change(data); assert.throws(() => validateDataset(data));
  }
});
test('rejects missing symbols, duplicate timestamps, invalid numbers and inconsistent OHLC', () => {
  for (const change of [data => { data[1].timestamp = data[0].timestamp; }, data => { data[1].bars = {}; }, data => { data[0].bars.A.close = Infinity; }, data => { data[0].bars.A.low = 12; }, data => { data[0].bars.A.volume = -1; }, data => { data[0].bars.A.extra = 2; }, data => { data[0].bars.A = null; }]) {
    const data = rows(); change(data); assert.throws(() => validateDataset(data));
  }
});
test('CSV rejects malformed, duplicated, unordered and nondecimal fields', () => {
  for (const input of ['', 'wrong header', csv(rows()).replace(',100\n', ',Infinity\n'), csv(rows()).replace(',10,11,', ',0xA,11,'), `${csv(rows())}\n${csv(rows()).split('\n')[1]}`, csv(rows()).replace(',A,', ',"A",')]) assert.throws(() => parseCsv(input));
});
