import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { TradingEngine } from '../src/engine.mjs';

function rows(symbols = ['A'], count = 36) {
  return Array.from({ length: count }, (_, i) => {
    const timestamp = new Date(Date.UTC(2020, 0, 1, 9, i * 5)).toISOString();
    return { timestamp, bars: Object.fromEntries(symbols.map(symbol => [symbol, { open: 99 + i, high: 101 + i, low: 98 + i, close: 100 + i, volume: 1000 }])) };
  });
}
function fixture(t, { dataset = rows(), path = ':memory:', ...options } = {}) {
  const store = new Store(path); t.after(() => { try { store.close(); } catch {} });
  const engine = new TradingEngine(store, options);
  engine.importDataset({ rows: dataset, name: 'test fixture' });
  engine.settings({ strategy: { mode: 'momentum' }, simulation: { startingCapital: 1000, costSchedule: 'none', slippageBps: 0 },
    risk: { stopLossPct: 20, takeProfitPct: 100, maxPositionPct: 100, maxExposurePct: 100, maxDrawdownPct: 50, maxDailyLossPct: 50, riskPerTradePct: 5 } });
  return { engine, store };
}
function seed(engine, { symbol = 'A', quantity = 5, cash = 355, strategyId = 'buy_hold', ...overrides } = {}) {
  const close = engine.state.dataset[29].bars[symbol].close;
  engine.state.cash = cash;
  engine.state.positions = [{ id: 'held-position', symbol, quantity, entryPrice: close, markPrice: close, entryFee: 0,
    stopPrice: 10, takeProfitPrice: 300, trailingStopPct: 0, peakPrice: close, strategyId, configVersion: 1, openedAt: engine.state.dataset[28].timestamp, ...overrides }];
  engine.updateMetrics(); engine.store.save(engine.state, 'test-fixture');
}
const step = engine => engine.step({ runId: engine.state.runId, expectedCursor: engine.state.cursor });
const approx = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} differs from ${expected}`);

test('held strategy exits survive strategy disable/selector change and do not call the model', async t => {
  const data = rows(); data[29].bars.A = { open: 100, high: 101, low: 89, close: 90, volume: 1000 };
  data[30].bars.A = { open: 91, high: 92, low: 90, close: 91, volume: 1000 };
  let calls = 0;
  const { engine } = fixture(t, { dataset: data, allowPaidCalls: true, reviewer: async () => { calls++; throw new Error('model failed'); } });
  seed(engine, { strategyId: 'momentum', stopPrice: 30, quantity: 5, cash: 550 });
  engine.settings({ strategy: { mode: 'auto', enabled: ['mean_reversion'] }, model: { provider: 'openai', model: 'mock-model' } });
  await step(engine);
  assert.equal(calls, 0); assert.equal(engine.state.positions.length, 0);
  assert.equal(engine.state.trades[0].strategyId, 'momentum'); assert.equal(engine.state.trades[0].phase, 'open');
  assert.equal(engine.state.decisions[0].positionConfigVersion, 1);
});

test('model failure for another symbol cannot suppress a held entry-strategy exit', async t => {
  const data = rows(['A', 'B']); data[29].bars.A = { open: 100, high: 101, low: 89, close: 90, volume: 1000 };
  data[30].bars.A = { open: 91, high: 92, low: 90, close: 91, volume: 1000 };
  let calls = 0;
  const { engine, store } = fixture(t, { dataset: data, allowPaidCalls: true, reviewer: async () => { calls++; throw new Error('mock unavailable'); } });
  seed(engine, { strategyId: 'momentum', stopPrice: 30, quantity: 5, cash: 550 });
  engine.settings({ strategy: { mode: 'auto' }, model: { provider: 'openai', model: 'mock-model' } });
  await step(engine);
  assert.equal(calls, 1); assert.equal(store.callCount(), 1);
  assert.equal(engine.state.positions.length, 0); assert.equal(engine.state.trades[0].action, 'SELL');
  assert.match(engine.state.decisions.find(d => d.symbol === 'B').reason, /AI unavailable/);
});

test('gap drawdown latches before entries and protective steps remain available', async t => {
  const data = rows(['A', 'B']);
  data[30].bars.A = { open: 80, high: 82, low: 79, close: 81, volume: 1000 };
  data[31].bars.A = { open: 81, high: 82, low: 5, close: 80, volume: 1000 };
  const { engine } = fixture(t, { dataset: data }); seed(engine);
  engine.settings({ risk: { maxDrawdownPct: 10 } });
  await step(engine);
  assert.equal(engine.state.status, 'risk-paused'); assert.equal(engine.state.trades.length, 0);
  assert.match(engine.state.decisions.find(d => d.symbol === 'B').outcome, /loss cap/);
  engine.settings({ risk: { maxDrawdownPct: 40 } }); engine.control('pause');
  assert.equal(engine.state.status, 'risk-paused'); assert.throws(() => engine.control('start'), /latched/);
  await step(engine);
  assert.equal(engine.state.positions.length, 0); assert.equal(engine.state.trades[0].action, 'SELL');
  assert.equal(engine.state.status, 'risk-paused');
});

test('daily loss cap is independent of total drawdown and uses Asia/Kolkata session accounting', async t => {
  const data = rows(['A', 'B']); data[30].bars.A = { open: 122, high: 124, low: 121, close: 123, volume: 1000 };
  const { engine } = fixture(t, { dataset: data }); seed(engine);
  engine.settings({ risk: { maxDrawdownPct: 50, maxDailyLossPct: 3 } });
  await step(engine);
  assert.equal(engine.state.status, 'risk-paused'); assert.match(engine.state.lastError, /daily loss/);
  assert.equal(engine.state.metrics.sessionTimezone, 'Asia/Kolkata');
  assert.equal(engine.state.metrics.sessionStartingEquity, 1000);
  assert.equal(engine.state.trades.length, 0);
});

test('intrabar liquidation proceeds cannot fund another symbol at the earlier open', async t => {
  const data = rows(['A', 'B']); data[30].bars.A = { open: 129, high: 132, low: 90, close: 130, volume: 1000 };
  const { engine } = fixture(t, { dataset: data }); seed(engine, { cash: 0, quantity: 10, stopPrice: 103.2 });
  await step(engine);
  assert.deepEqual(engine.state.trades.map(trade => trade.action), ['SELL']);
  assert.equal(engine.state.trades[0].phase, 'intrabar'); assert.ok(engine.state.cash > 0);
  assert.match(engine.state.decisions.find(d => d.symbol === 'B').outcome, /cash/);
});

test('a trailing level derived from the high becomes active only on the next bar', async t => {
  const data = rows(); data[30].bars.A = { open: 129, high: 150, low: 125, close: 145, volume: 1000 };
  data[31].bars.A = { open: 140, high: 141, low: 134, close: 136, volume: 1000 };
  const { engine } = fixture(t, { dataset: data }); seed(engine, { trailingStopPct: 10, stopPrice: 120 });
  await step(engine); assert.equal(engine.state.trades.length, 0); assert.equal(engine.state.positions[0].stopPrice, 135);
  await step(engine); assert.equal(engine.state.trades.length, 1); assert.equal(engine.state.trades[0].price, 135);
});

test('entry and exit fees/slippage reconcile to cash and realized PnL', async t => {
  const data = rows(); data[30].bars.A = { open: 129, high: 131, low: 128, close: 130, volume: 1000 };
  data[31].bars.A = { open: 100, high: 102, low: 99, close: 101, volume: 1000 };
  const { engine } = fixture(t, { dataset: data }); engine.settings({ simulation: { costSchedule: 'zerodha-cnc-2026-10', slippageBps: 10 } });
  await step(engine); assert.equal(engine.state.trades[0].action, 'BUY');
  await step(engine); const [buy, sell] = engine.state.trades;
  assert.equal(sell.action, 'SELL'); assert.equal(engine.state.positions.length, 0);
  approx(buy.price, 129 * 1.001); approx(sell.price, 100 * 0.999);
  approx(engine.state.fees, buy.fee + sell.fee);
  approx(engine.state.realizedPnl, (sell.price - buy.price) * buy.quantity - buy.fee - sell.fee);
  approx(engine.state.cash, 1000 + engine.state.realizedPnl);
});

test('stale step identities are rejected across restart without duplicate trades', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'trading-lab-engine-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  const { engine, store } = fixture(t, { path }); engine.control('start');
  const identity = { runId: engine.state.runId, expectedCursor: engine.state.cursor };
  await engine.step(identity); const count = engine.state.trades.length; store.close();
  const restoredStore = new Store(path); t.after(() => restoredStore.close());
  const restored = new TradingEngine(restoredStore);
  assert.equal(restored.state.status, 'paused'); assert.equal(restored.state.cursor, 30);
  await assert.rejects(restored.step(identity), /Stale/); assert.equal(restored.state.trades.length, count);
});

test('pending model work excludes concurrent mutations and decisions only see the closed prefix', async t => {
  let release, seen;
  const { engine } = fixture(t, { allowPaidCalls: true, reviewer: async ({ context }) => { seen = context; await new Promise(resolve => { release = resolve; }); return { strategyId: 'momentum', evidence: [], counterEvidence: [], usage: { inputTokens: 1, outputTokens: 1 } }; } });
  engine.settings({ strategy: { mode: 'auto' }, model: { provider: 'openai', model: 'mock-model' } });
  const pending = step(engine);
  assert.equal(engine.snapshot().run.cursor, 29); assert.equal(seen.features.sampleSize, 30); assert.equal(seen.asOf, engine.state.dataset[29].timestamp);
  assert.throws(() => engine.settings({ risk: { stopLossPct: 3 } }), /busy/);
  await assert.rejects(step(engine), /busy/); release(); await pending;
  assert.equal(engine.state.cursor, 30);
});

test('disabled paid calls fail before reserving a provider attempt', async t => {
  let calls = 0; const { engine, store } = fixture(t, { reviewer: async () => { calls++; throw new Error('must not be called'); } });
  engine.settings({ strategy: { mode: 'auto' }, model: { provider: 'openai', model: 'mock-model' } });
  await assert.rejects(engine.review('A'), /disabled/); await step(engine);
  assert.equal(calls, 0); assert.equal(store.callCount(), 0); assert.equal(engine.state.trades.length, 0);
});

test('failed persistence restores the paper ledger/cursor and blocks retry until recovery', async t => {
  const { engine, store } = fixture(t); const previous = engine.export();
  store.db.exec("CREATE TRIGGER fail_step BEFORE INSERT ON audit WHEN NEW.kind='step' BEGIN SELECT RAISE(ABORT,'injected'); END;");
  await assert.rejects(step(engine), /storage/);
  assert.equal(engine.state.cursor, previous.cursor); assert.equal(engine.state.cash, previous.cash); assert.deepEqual(engine.state.positions, previous.positions);
  assert.equal(store.load().cursor, previous.cursor); assert.equal(store.audit().some(event => event.kind === 'step'), false);
  assert.equal(engine.state.status, 'error-paused'); await assert.rejects(step(engine), /storage failure/);
});

test('archive and reset are atomic and settings cannot clear an existing loss latch', async t => {
  const { engine, store } = fixture(t); await step(engine);
  const count = store.archiveCount(), runId = engine.state.runId, positions = structuredClone(engine.state.positions);
  store.db.exec("CREATE TRIGGER fail_reset BEFORE INSERT ON audit WHEN NEW.kind='reset' BEGIN SELECT RAISE(ABORT,'injected'); END;");
  assert.throws(() => engine.control('reset'), /storage/);
  assert.equal(store.archiveCount(), count); assert.equal(store.load().runId, runId); assert.deepEqual(engine.state.positions, positions);
});

test('intelligence veto blocks entries, stores the exact context, and remains independent of exits', async t => {
  const { engine } = fixture(t, { intelligenceProvider: ({ symbol, asOf }) => ({ symbol, asOf, entryBlocked: true, blockReasons: ['rumor-only evidence'], records: [{ id: 'captured-fact' }] }) });
  engine.setIntelligence([{ id: 'already-validated-by-server' }]); await step(engine);
  assert.equal(engine.state.trades.length, 0); assert.match(engine.state.decisions[0].outcome, /intelligence veto/);
  assert.equal(engine.state.decisions[0].inputSnapshot.intelligence.records[0].id, 'captured-fact');
  assert.equal(engine.snapshot().intelligence.networkConnected, false);
});

test('benchmarks enter at the same next-open phase and disclose allocation differences', async t => {
  const { engine } = fixture(t, { dataset: rows(['A', 'B']) }); engine.settings({ risk: { maxPositionPct: 20, maxExposurePct: 40 } });
  assert.equal(engine.state.benchmark.positions.length, 0); await step(engine);
  assert.equal(engine.state.benchmark.entryTimestamp, engine.state.dataset[30].timestamp);
  assert.ok(engine.snapshot().benchmarks.capped.exposurePct <= 40);
  assert.ok(engine.snapshot().benchmarks.full.exposurePct > engine.snapshot().benchmarks.capped.exposurePct);
  assert.match(engine.snapshot().benchmarks.capped.note, /no strategy exits/);
});

test('intelligence failure still allows held exits and vetoes new exposure', async t => {
  const data = rows(['A', 'B']); data[29].bars.A = { open: 100, high: 101, low: 89, close: 90, volume: 1000 };
  data[30].bars.A = { open: 91, high: 92, low: 90, close: 91, volume: 1000 };
  const { engine } = fixture(t, { dataset: data, intelligenceProvider: () => { throw new Error('captured context unavailable'); } });
  seed(engine, { strategyId: 'momentum', stopPrice: 30, quantity: 5, cash: 550 });
  await step(engine);
  assert.deepEqual(engine.state.trades.map(trade => trade.action), ['SELL']);
  assert.match(engine.state.decisions.find(decision => decision.symbol === 'B').outcome, /intelligence veto/);
});

test('a new session day uses prior close equity so an overnight gap counts toward daily loss', async t => {
  const data = rows(['A', 'B']);
  for (let index = 30; index < data.length; index++) data[index].timestamp = new Date(Date.UTC(2020, 0, 2, 3, 45 + (index - 30) * 5)).toISOString();
  data[30].bars.A = { open: 122, high: 124, low: 121, close: 123, volume: 1000 };
  const { engine } = fixture(t, { dataset: data }); seed(engine);
  engine.settings({ risk: { maxDailyLossPct: 3 } }); await step(engine);
  assert.equal(engine.state.metrics.sessionDay, '2020-01-02');
  assert.equal(engine.state.metrics.sessionStartingEquity, 1000);
  assert.equal(engine.state.status, 'risk-paused'); assert.equal(engine.state.trades.length, 0);
});

test('DP charge applies once per scrip per session day and fills are labelled', async t => {
  const data = rows(); for (const i of [30, 31]) data[i].bars.A = { open: 50, high: 51, low: 49, close: 50, volume: 1000 };
  const { engine } = fixture(t, { dataset: data }); engine.settings({ simulation: { costSchedule: 'zerodha-cnc-2026-10' } });
  seed(engine, { stopPrice: 60, quantity: 5, cash: 500 }); await step(engine);
  seed(engine, { stopPrice: 60, quantity: 5, cash: 500 }); await step(engine);
  const sells = engine.state.trades.filter(trade => trade.action === 'SELL');
  assert.equal(sells.length, 2); approx(sells[0].fee - sells[1].fee, 15.34);
  assert.equal(sells[0].fill, 'assumed-open'); assert.equal(sells[0].charges.dp, 15.34); assert.equal(sells[1].charges.dp, 0);
});

const liveAssets = [{ symbol: 'A', name: 'A', sector: 'Test' }];
const bar40 = (source = 'ticks', bars = { A: { open: 140, high: 142, low: 139, close: 141, volume: 1000 } }) => ({ timestamp: new Date(Date.UTC(2020, 0, 1, 9, 40 * 5)).toISOString(), closed: true, source, bars });
const liveStep = (engine, extra = {}) => engine.step({ runId: engine.state.runId, expectedCursor: engine.state.cursor, ...extra });

test('beginLive sets prospective-paper mode and makes no decisions on historical bars', t => {
  const { engine, store } = fixture(t);
  engine.beginLive({ rows: rows(['A'], 40), assets: liveAssets, source: 'test live' });
  assert.equal(engine.state.mode, 'prospective-paper'); assert.equal(engine.state.cursor, 39);
  assert.equal(engine.state.decisions.length, 0); assert.equal(engine.state.dataSource, 'test live');
  assert.ok(engine.state.dataset.every(row => row.source === 'historical')); assert.equal(store.archiveCount(), 2);
  assert.equal(engine.snapshot().mode, 'prospective-paper');
});

test('appendBar then step decides once and fills at the appended bar open', async t => {
  const { engine } = fixture(t);
  engine.beginLive({ rows: rows(['A'], 40), assets: liveAssets, source: 'test live' });
  engine.appendBar(bar40()); assert.equal(engine.state.dataset.length, 41); assert.equal(engine.state.cursor, 39);
  await liveStep(engine);
  assert.equal(engine.state.cursor, 40); assert.equal(engine.state.decisions.length, 1);
  assert.equal(engine.state.decisions[0].executionTimestamp, bar40().timestamp);
  assert.equal(engine.snapshot().run.lastBarSource, 'ticks');
  for (const trade of engine.state.trades) assert.equal(trade.fill, 'observed-open');
});

test('appendBar rejects stale, duplicate, and missing-symbol rows without changing state', t => {
  const { engine } = fixture(t);
  engine.beginLive({ rows: rows(['A'], 40), assets: liveAssets, source: 'test live' });
  const last = engine.state.dataset[39];
  assert.throws(() => engine.appendBar({ ...bar40(), timestamp: last.timestamp }), /follow the last bar/);
  assert.throws(() => engine.appendBar({ ...bar40(), timestamp: engine.state.dataset[10].timestamp }), /follow the last bar/);
  assert.throws(() => engine.appendBar(bar40('ticks', { B: { open: 1, high: 1, low: 1, close: 1, volume: 0 } })), /every universe symbol/);
  assert.throws(() => engine.appendBar(bar40('ticks', { A: { open: 140, high: 130, low: 139, close: 141, volume: 1000 } })), /Inconsistent OHLC/);
  assert.equal(engine.state.dataset.length, 40); assert.equal(engine.store.load().dataset.length, 40);
});

test('blockEntries rejects buys with the given reason', async t => {
  const { engine } = fixture(t);
  engine.beginLive({ rows: rows(['A'], 40), assets: liveAssets, source: 'test live' });
  engine.appendBar(bar40());
  await liveStep(engine, { blockEntries: 'Data gap: waiting for clean bars' });
  assert.equal(engine.state.positions.length, 0);
  assert.equal(engine.state.decisions[0].action, 'BUY');
  assert.equal(engine.state.decisions[0].outcome, 'Rejected: Data gap: waiting for clean bars');
  await assert.rejects(() => liveStep(engine, { blockEntries: 5 }), /Invalid replay step identity/);
});

test('universe cannot change while a position is open', t => {
  const { engine } = fixture(t); seed(engine);
  assert.throws(() => engine.settings({ universe: ['INFY'] }), /Close open positions/);
  assert.throws(() => engine.settings({ barMinutes: 60 }), /Close open positions/);
});
