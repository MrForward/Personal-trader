import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { TradingEngine } from '../src/engine.mjs';
import { LiveRunner, replayCapture } from '../src/live.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/ticks-2026-10-14.jsonl', import.meta.url));
const T = iso => Date.parse(iso);
const OPEN = T('2026-10-14T03:45:00Z');
const session14 = { day: '2026-10-14', openMs: OPEN, closeMs: T('2026-10-14T10:00:00Z') };

function warmupBars(symbol, endMs, count = 40) {
  return Array.from({ length: count }, (_, i) => {
    const price = symbol === 'DEMO1' ? 90 + i * 0.25 : 52 - i * 0.05;
    return { timestamp: new Date(endMs - (count - 1 - i) * 900_000).toISOString(), open: price, high: price + 0.5, low: price - 0.5, close: price, volume: 100 };
  });
}
function fakeSession({ state = 'valid', bars = warmupBars, fail = 0 } = {}) {
  const calls = [];
  return { calls, status: () => ({ state }), historicalBars: async ({ symbol, count, endMs }) => {
    calls.push(symbol); if (fail > 0) { fail--; throw new Error('historical API down'); } return bars(symbol, endMs, count);
  } };
}
// A replay source that advances the test clock to each tick's exchange time, so skew stays zero.
function followingClock(source, clock, offsetMs = 100) {
  return { start: handlers => source.start({ ...handlers, onTick: tick => { clock.now = tick.exchangeTime + offsetMs; return handlers.onTick(tick); } }), stop: () => source.stop() };
}
function setup(t, { store, session = fakeSession(), source = replayCapture(FIXTURE), clockStart = OPEN - 60_000, offsetMs, calendar = () => session14, onFatal } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'live-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  store ??= new Store(':memory:');
  const engine = new TradingEngine(store);
  engine.settings({ universe: ['DEMO1', 'DEMO2'], simulation: { startingCapital: 9000 } });
  const clock = { now: clockStart };
  const runner = new LiveRunner({ engine, session, captureDir: dir, calendar, now: () => clock.now, source: followingClock(source, clock, offsetMs), intervalMs: 0, onFatal });
  return { engine, store, runner, clock, dir, session };
}
const ledger = engine => JSON.stringify({ trades: engine.state.trades.map(({ id, ...trade }) => trade), outcomes: engine.state.decisions.map(d => d.outcome), equity: engine.state.metrics.equity });

test('replaying the fixture produces three bars and three steps, and the capture equals the fixture', async t => {
  const { engine, runner, dir } = setup(t);
  await runner.start(); await runner.idle();
  assert.equal(engine.state.mode, 'prospective-paper');
  assert.deepEqual(engine.state.dataset.slice(-3).map(row => [row.timestamp, row.source]),
    [['2026-10-14T04:00:00.000Z', 'ticks'], ['2026-10-14T04:15:00.000Z', 'ticks'], ['2026-10-14T04:30:00.000Z', 'thin']]);
  assert.equal(engine.state.cursor, engine.state.dataset.length - 1); assert.equal(engine.state.decisions.length, 6);
  assert.equal(readFileSync(join(dir, 'ticks-2026-10-14.jsonl'), 'utf8'), readFileSync(FIXTURE, 'utf8'));
  assert.equal(runner.status().state, 'live'); assert.equal(runner.status().barsToday, 3);
});

test('replaying twice from a fresh store yields identical ledgers', async t => {
  const first = setup(t); await first.runner.start(); await first.runner.idle();
  const second = setup(t); await second.runner.start(); await second.runner.idle();
  assert.equal(ledger(first.engine), ledger(second.engine));
});

test('first two bars after start block entries; a thin bar resets the clean count', async t => {
  const { engine, runner } = setup(t);
  await runner.start(); await runner.idle();
  assert.deepEqual(engine.state.decisions.filter(d => d.symbol === 'DEMO1').map(d => [d.action, d.outcome]), [
    ['BUY', 'Rejected: Data gap: waiting for clean bars'], ['BUY', 'Rejected: Data gap: waiting for clean bars'], ['BUY', 'Paper buy filled']]);
  assert.equal(runner.status().cleanBarsSinceGap, 0);
});

test('restart skips overlapping warmup rows, catches up and continues', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const first = setup(t, { store }); await first.runner.start(); await first.runner.idle();
  const before = first.engine.state.dataset.length, runId = first.engine.state.runId;
  first.runner.stop();
  // Restart at 10:31 IST: historical API now also has the 09:45–10:00 IST candle (ending 04:30Z) and one more ending 04:45Z.
  const later = (symbol, endMs, count) => [...warmupBars(symbol, OPEN, count - 3), ...['04:00', '04:15', '04:30', '04:45'].map(hm => ({ timestamp: `2026-10-14T${hm}:00.000Z`, open: 101, high: 102, low: 100, close: 101, volume: 5 }))];
  const second = setup(t, { store, session: fakeSession({ bars: later }), source: { start: () => {}, stop: () => {} }, clockStart: T('2026-10-14T05:01:00Z') });
  await second.runner.start(); await second.runner.idle();
  assert.equal(second.engine.state.runId, runId);
  assert.equal(second.engine.state.dataset.length, before + 1); assert.equal(second.engine.state.cursor, before);
  assert.ok(second.store.audit().some(row => row.kind === 'catch-up'));
});

test('login-needed when the session is not valid; no warmup call made', async t => {
  const session = fakeSession({ state: 'expired' });
  const { runner } = setup(t, { session });
  await runner.start();
  assert.equal(runner.status().state, 'login-needed'); assert.deepEqual(session.calls, []);
});

test('idle on a holiday; no warmup or source start', async t => {
  const session = fakeSession(); let started = false;
  const { runner } = setup(t, { session, calendar: () => null, source: { start: () => { started = true; }, stop: () => {} } });
  await runner.start();
  assert.equal(runner.status().state, 'idle'); assert.deepEqual(session.calls, []); assert.equal(started, false);
});

test('warmup failure with no live state waits; with live state continues on ticks', async t => {
  const failing = setup(t, { session: fakeSession({ fail: 2 }), source: { start: () => {}, stop: () => {} } });
  await failing.runner.start();
  assert.equal(failing.runner.status().state, 'warmup-failed'); assert.equal(failing.engine.state.mode, 'paper');
  const store = new Store(':memory:'); t.after(() => store.close());
  const live = setup(t, { store }); await live.runner.start(); await live.runner.idle(); live.runner.stop();
  const again = setup(t, { store, session: fakeSession({ fail: 2 }), source: { start: () => {}, stop: () => {} } });
  await again.runner.start();
  assert.equal(again.runner.status().state, 'live'); assert.equal(again.runner.status().counters.warmupFailed, 1);
});

test('three skewed ticks block entries with the clock-skew reason', async t => {
  // Without skew the third bar fills a DEMO1 buy (see the clean-bars test); with skew every buy is rejected.
  const { engine, runner } = setup(t, { offsetMs: 10_000 });
  await runner.start(); await runner.idle();
  assert.equal(runner.status().skewed, true);
  assert.deepEqual(engine.state.decisions.filter(d => d.action === 'BUY').map(d => d.outcome), Array(3).fill('Rejected: Clock skew over 5 s'));
  assert.equal(engine.state.positions.length, 0);
});

test('disconnect writes a protection-gap audit row per missed bar and emits no bar', async t => {
  let handlers;
  const { engine, runner, clock, store } = setup(t, { source: { start: h => { handlers = h; }, stop: () => {} } });
  await runner.start();
  const rows = engine.state.dataset.length;
  handlers.onTick({ symbol: 'DEMO1', price: 100, cumulativeVolume: 1, exchangeTime: OPEN + 1000 });
  handlers.onClose('socket');
  assert.equal(runner.status().state, 'disconnected');
  clock.now = T('2026-10-14T04:16:00Z'); runner.poll(); runner.poll();
  await runner.idle();
  assert.equal(store.audit().filter(row => row.kind === 'protection-gap').length, 2);
  assert.equal(engine.state.dataset.length, rows);
  handlers.onClose('expired'); assert.equal(runner.status().state, 'login-needed');
});

test('flush closes a bar nobody ticked past, and the session ends closed', async t => {
  let handlers;
  const { engine, runner, clock } = setup(t, { source: { start: h => { handlers = h; }, stop: () => {} } });
  await runner.start();
  handlers.onTick({ symbol: 'DEMO1', price: 100, cumulativeVolume: 1, exchangeTime: T('2026-10-14T09:50:00Z') });
  handlers.onTick({ symbol: 'DEMO2', price: 50, cumulativeVolume: 1, exchangeTime: T('2026-10-14T09:50:01Z') });
  clock.now = T('2026-10-14T10:00:31Z'); runner.poll(); await runner.idle();
  assert.equal(engine.state.dataset.at(-1).timestamp, '2026-10-14T10:00:00.000Z');
  runner.poll(); assert.equal(runner.status().state, 'closed');
});

test('persistence error stops the runner and calls onFatal', async t => {
  let fatal;
  const { runner, store } = setup(t, { onFatal: error => { fatal = error; } });
  const save = store.save.bind(store); let calls = 0;
  store.save = (...args) => { if (++calls > 1) { const error = new Error('disk full'); error.code = 'PERSISTENCE_ERROR'; throw error; } return save(...args); };
  await runner.start(); await runner.idle();
  assert.equal(fatal?.code, 'PERSISTENCE_ERROR'); assert.equal(runner.status().state, 'idle');
});

test('closing the session writes the daily report with data quality', async t => {
  let handlers;
  const { runner, clock, store } = setup(t, { source: { start: h => { handlers = h; }, stop: () => {} } });
  await runner.start();
  handlers.onTick({ symbol: 'DEMO1', price: 100, cumulativeVolume: 1, exchangeTime: T('2026-10-14T09:50:00Z') });
  clock.now = T('2026-10-14T10:00:31Z'); runner.poll(); await runner.idle(); runner.poll(); await runner.idle();
  const [report] = store.dailyReports();
  assert.equal(report.day, '2026-10-14'); assert.equal(report.dataQuality.ticks, 1); assert.equal(report.dataQuality.thinBars, 1);
  assert.equal(report.dataQuality.flagged, true);
  runner.poll(); await runner.idle(); assert.equal(store.dailyReports().length, 1);
});

test('starting after the close writes a missing report once and stays idle', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const first = setup(t, { store }); await first.runner.start(); await first.runner.idle(); first.runner.stop();
  const later = setup(t, { store, clockStart: T('2026-10-14T11:00:00Z') });
  await later.runner.start(); await later.runner.idle();
  assert.equal(later.runner.status().state, 'idle'); assert.deepEqual(store.dailyReports().map(row => row.day), ['2026-10-14']);
});

test('review #1: failed reconnect attempts keep retrying on backoff from poll', async t => {
  let starts = 0, handlers;
  const source = { start: h => { handlers = h; starts++; if (starts > 1) h.onError?.(new Error('ECONNREFUSED')); }, stop: () => {} };
  const { runner, clock } = setup(t, { source });
  await runner.start();
  handlers.onTick({ symbol: 'DEMO1', price: 100, cumulativeVolume: 1, exchangeTime: OPEN + 1000 });
  handlers.onClose('socket');
  for (const seconds of [1, 2, 4, 8]) { clock.now += seconds * 1000; runner.poll(); }
  assert.equal(starts, 5); assert.equal(runner.status().state, 'disconnected');
  handlers.onTick({ symbol: 'DEMO1', price: 100, cumulativeVolume: 2, exchangeTime: clock.now });
  assert.equal(runner.status().state, 'live');
});

test('review #2: disconnected at the close still closes, reports, and records gaps only up to the close', async t => {
  let handlers;
  const { runner, clock, store } = setup(t, { source: { start: h => { handlers = h; }, stop: () => {} } });
  await runner.start();
  handlers.onTick({ symbol: 'DEMO1', price: 100, cumulativeVolume: 1, exchangeTime: T('2026-10-14T09:20:00Z') });
  handlers.onClose('socket');
  clock.now = T('2026-10-14T10:30:00Z'); for (let i = 0; i < 5; i++) runner.poll();
  await runner.idle();
  assert.equal(runner.status().state, 'closed'); assert.equal(store.dailyReports().length, 1);
  const gaps = store.audit().filter(row => row.kind === 'protection-gap').map(row => row.payload.barEnd);
  assert.deepEqual(gaps, ['2026-10-14T09:30:00.000Z', '2026-10-14T09:45:00.000Z', '2026-10-14T10:00:00.000Z']);
});

test('review #2: an expired session keeps recording protection gaps and still reports at the close', async t => {
  let handlers;
  const { runner, clock, store } = setup(t, { source: { start: h => { handlers = h; }, stop: () => {} } });
  await runner.start();
  handlers.onTick({ symbol: 'DEMO1', price: 100, cumulativeVolume: 1, exchangeTime: T('2026-10-14T09:40:00Z') });
  handlers.onClose('expired');
  clock.now = T('2026-10-14T09:46:00Z'); runner.poll(); await runner.idle();
  assert.equal(runner.status().state, 'login-needed');
  assert.deepEqual(store.audit().filter(row => row.kind === 'protection-gap').map(row => row.payload.barEnd), ['2026-10-14T09:45:00.000Z']);
  clock.now = T('2026-10-14T10:01:00Z'); runner.poll(); await runner.idle();
  assert.equal(store.dailyReports().length, 1);
});

test('review #2/#6: the next start back-fills the last live day\'s missing report, flagged partial', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const first = setup(t, { store }); await first.runner.start(); await first.runner.idle(); first.runner.stop();
  const next = setup(t, { store, calendar: () => null, clockStart: T('2026-10-15T03:00:00Z') });
  await next.runner.start(); await next.runner.idle();
  const [report] = store.dailyReports();
  assert.equal(report.day, '2026-10-14'); assert.equal(report.dataQuality.partial, true); assert.equal(report.dataQuality.flagged, true);
});

test('review #6: a runner started after the open marks its report partial', async t => {
  let handlers;
  const { runner, clock, store } = setup(t, { clockStart: T('2026-10-14T05:00:00Z'), source: { start: h => { handlers = h; }, stop: () => {} } });
  await runner.start();
  handlers.onTick({ symbol: 'DEMO1', price: 100, cumulativeVolume: 1, exchangeTime: T('2026-10-14T09:50:00Z') });
  handlers.onTick({ symbol: 'DEMO2', price: 50, cumulativeVolume: 1, exchangeTime: T('2026-10-14T09:50:01Z') });
  clock.now = T('2026-10-14T10:00:31Z'); runner.poll(); await runner.idle();
  assert.equal(store.dailyReports()[0].dataQuality.partial, true); assert.equal(store.dailyReports()[0].dataQuality.flagged, true);
});

test('review #3: a VPS clock behind the exchange is flagged as skew and bars are still applied', async t => {
  const { engine, runner } = setup(t, { offsetMs: -10_000 });
  await runner.start(); await runner.idle();
  assert.equal(runner.status().skewed, true); assert.equal(runner.status().counters.rejectedRows, 0);
  assert.equal(engine.state.dataset.at(-1).timestamp, '2026-10-14T04:30:00.000Z');
});

test('review #4: changing only the bar size starts a new live run', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  // A skewed first run opens no position, so the bar size may change.
  const first = setup(t, { store, offsetMs: 10_000 }); await first.runner.start(); await first.runner.idle(); first.runner.stop();
  assert.equal(first.engine.state.positions.length, 0); const runId = first.engine.state.runId;
  const second = setup(t, { store, source: { start: () => {}, stop: () => {} }, clockStart: T('2026-10-14T05:01:00Z') });
  second.engine.settings({ barMinutes: 5 });
  await second.runner.start();
  assert.notEqual(second.engine.state.runId, runId); assert.equal(second.engine.state.liveBarMinutes, 5);
});
