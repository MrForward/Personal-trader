import test from 'node:test';
import assert from 'node:assert/strict';
import { BarBuilder } from '../src/bars.mjs';

const T = iso => Date.parse(iso);
const session = { openMs: T('2026-10-20T03:45:00Z'), closeMs: T('2026-10-20T10:00:00Z') }; // 09:15–15:30 IST
const make = () => new BarBuilder({ barMinutes: 15, symbols: ['A', 'B'], session });
const tick = (symbol, price, cumulativeVolume, iso) => ({ symbol, price, cumulativeVolume, exchangeTime: T(iso) });

test('ticks fold into a bar and the next-bar tick closes it', () => {
  const b = make();
  assert.equal(b.push(tick('A', 100, 10, '2026-10-20T03:45:05Z')), null);
  b.push(tick('A', 102, 25, '2026-10-20T03:50:00Z'));
  b.push(tick('B', 50, 5, '2026-10-20T03:51:00Z'));
  b.push(tick('A', 99, 30, '2026-10-20T03:59:59Z'));
  const row = b.push(tick('A', 101, 31, '2026-10-20T04:00:00Z'));
  assert.equal(row.timestamp, '2026-10-20T04:00:00.000Z'); assert.equal(row.source, 'ticks'); assert.equal(row.closed, true);
  assert.deepEqual(row.bars.A, { open: 100, high: 102, low: 99, close: 99, volume: 30, timestamp: '2026-10-20T04:00:00.000Z', closed: true });
  assert.equal(row.bars.B.volume, 5);
});

test('the closing tick opens the next bar', () => {
  const b = make(); b.seed('B', 50);
  b.push(tick('A', 100, 10, '2026-10-20T03:45:05Z'));
  b.push(tick('A', 101, 11, '2026-10-20T04:00:00Z'));
  const row = b.push(tick('A', 103, 12, '2026-10-20T04:15:00Z'));
  assert.deepEqual([row.bars.A.open, row.bars.A.close, row.bars.A.volume], [101, 101, 1]);
});

test('late tick inside a closed bar is dropped and counted', () => {
  const b = make(); b.seed('B', 50);
  b.push(tick('A', 100, 1, '2026-10-20T03:45:05Z'));
  b.push(tick('A', 100, 2, '2026-10-20T04:00:01Z'));
  assert.equal(b.push(tick('A', 1, 3, '2026-10-20T03:59:00Z')), null);
  assert.equal(b.counters.dropped, 1);
});

test('ticks outside the session are ignored', () => {
  const b = make();
  b.push(tick('A', 100, 1, '2026-10-20T03:40:00Z'));
  b.push(tick('A', 100, 1, '2026-10-20T10:00:30Z'));
  assert.equal(b.counters.outsideSession, 2);
});

test('symbol with no tick in the bar makes a thin row at its last price', () => {
  const b = make(); b.seed('B', 50);
  b.push(tick('A', 100, 1, '2026-10-20T03:45:05Z'));
  const row = b.push(tick('A', 100, 2, '2026-10-20T04:00:00Z'));
  assert.equal(row.source, 'thin'); assert.deepEqual([row.bars.B.open, row.bars.B.close, row.bars.B.volume], [50, 50, 0]);
  assert.equal(b.counters.thinBars, 1);
});

test('flush closes a bar 30 s after its end when no tick arrived; no row before that', () => {
  const b = make(); b.seed('B', 50);
  b.push(tick('A', 100, 1, '2026-10-20T03:45:05Z'));
  assert.equal(b.flush(T('2026-10-20T04:00:10Z')), null);
  assert.equal(b.flush(T('2026-10-20T04:00:30Z')).timestamp, '2026-10-20T04:00:00.000Z');
  assert.equal(b.flush(T('2026-10-20T04:00:31Z')), null);
});

test('no row until every symbol has a price', () => {
  const b = make();
  b.push(tick('A', 100, 1, '2026-10-20T03:45:05Z'));
  assert.equal(b.push(tick('A', 100, 2, '2026-10-20T04:00:00Z')), null);
  assert.equal(b.counters.missingPrice, 1);
});

test('first bar volume after a day change uses the new cumulative', () => {
  const b = make(); b.seed('B', 50);
  b.push(tick('A', 100, 5000, '2026-10-20T03:45:05Z'));
  const row = b.push(tick('A', 100, 5100, '2026-10-20T04:00:00Z'));
  assert.equal(row.bars.A.volume, 5000);
});

test('the last session bar ends at the close and closing-time ticks are outside it', () => {
  const b = make(); b.seed('B', 50);
  b.push(tick('A', 100, 1, '2026-10-20T09:50:00Z'));
  assert.equal(b.push(tick('A', 100, 2, '2026-10-20T10:00:00Z')), null);
  assert.equal(b.flush(T('2026-10-20T10:00:30Z')).timestamp, '2026-10-20T10:00:00.000Z');
});

test('invalid ticks are rejected', () => {
  const b = make();
  assert.throws(() => b.push(tick('Z', 1, 1, '2026-10-20T04:00:00Z')), /symbol/);
  assert.throws(() => b.push(tick('A', 0, 1, '2026-10-20T04:00:00Z')), /price/);
  assert.throws(() => b.push(tick('A', 1, -1, '2026-10-20T04:00:00Z')), /volume/);
});
