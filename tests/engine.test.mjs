import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { TradingEngine, confidenceRiskPct } from '../src/engine.mjs';
import { charges } from '../src/costs.mjs';

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
  // Held from an earlier session, so these are delivery sells, not intraday round trips.
  seed(engine, { stopPrice: 60, quantity: 5, cash: 500, openedAt: '2019-12-31T09:00:00.000Z' }); await step(engine);
  seed(engine, { stopPrice: 60, quantity: 5, cash: 500, openedAt: '2019-12-31T09:00:00.000Z' }); await step(engine);
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

test('catchUp fast-forwards over missed bars without decisions; the next open applies gap stops', async t => {
  const { engine } = fixture(t);
  engine.beginLive({ rows: rows(['A'], 40), assets: liveAssets, source: 'test live' });
  seed(engine, { stopPrice: 135 });
  const at = i => new Date(Date.UTC(2020, 0, 1, 9, i * 5)).toISOString();
  for (const i of [40, 41]) engine.appendBar({ timestamp: at(i), source: 'historical', bars: { A: { open: 150, high: 151, low: 120, close: 150, volume: 1 } } });
  engine.catchUp();
  assert.equal(engine.state.cursor, 41); assert.equal(engine.state.decisions.length, 0); assert.equal(engine.state.positions.length, 1);
  assert.ok(engine.store.audit().some(row => row.kind === 'catch-up' && row.payload.skipped === 2));
  engine.appendBar({ timestamp: at(42), source: 'ticks', bars: { A: { open: 130, high: 131, low: 129, close: 130, volume: 1 } } });
  await liveStep(engine);
  assert.equal(engine.state.positions.length, 0); assert.equal(engine.state.trades.at(-1).reason, 'Gap protective stop'); assert.equal(engine.state.trades.at(-1).price, 130);
});

test('dailyReport computes fixed costs per trading day and net after fixed costs', t => {
  const { engine, store } = fixture(t);
  engine.settings({ simulation: { fixedCostsPerMonthInr: 2100 } });
  engine.beginLive({ rows: rows(['A'], 40), assets: liveAssets, source: 'test live' });
  const bar = (iso, source = 'ticks') => engine.appendBar({ timestamp: iso, source, bars: { A: { open: 140, high: 141, low: 139, close: 140, volume: 1 } } });
  bar('2026-10-13T04:00:00Z'); bar('2026-10-14T04:00:00Z'); bar('2026-10-14T04:15:00Z', 'thin');
  const report = engine.dailyReport('2026-10-14', { ticks: 10, flagged: false });
  assert.equal(report.fixedCostsToDate, 200); assert.equal(report.monthToDateFixedCosts, 200); assert.equal(report.spendCap, 1200);
  assert.equal(report.netAfterFixedCosts, Math.round((report.equity - 1000 - 200) * 100) / 100);
  assert.equal(report.mode, 'prospective-paper'); assert.deepEqual(report.dataQuality, { ticks: 10, flagged: false });
  assert.deepEqual(store.dailyReports().map(row => row.day), ['2026-10-14']);
  engine.dailyReport('2026-10-14', { ticks: 11, flagged: true });
  assert.equal(store.dailyReports().length, 1); assert.equal(store.dailyReports()[0].dataQuality.ticks, 11);
});

test('a live run stays live after each step and replay controls are refused', async t => {
  const { engine } = fixture(t);
  engine.beginLive({ rows: rows(['A'], 40), assets: liveAssets, source: 'test live' });
  assert.equal(engine.state.status, 'live');
  engine.appendBar(bar40()); await liveStep(engine);
  assert.equal(engine.state.status, 'live');
  assert.throws(() => engine.control('start'), /driven by the live feed/);
});

test('review #5: a same-day round trip is charged at intraday rates with no DP charge', async t => {
  const data = rows(); data[30].bars.A = { open: 129, high: 131, low: 128, close: 130, volume: 1000 };
  data[31].bars.A = { open: 100, high: 102, low: 99, close: 101, volume: 1000 };
  const { engine } = fixture(t, { dataset: data }); engine.settings({ simulation: { costSchedule: 'zerodha-cnc-2026-10', slippageBps: 0 } });
  await step(engine); await step(engine);
  const [buy, sell] = engine.state.trades; const I = 'zerodha-intraday-2026-10';
  const expected = charges({ schedule: I, side: 'BUY', price: buy.price, quantity: buy.quantity, dpApplies: false }).total
    + charges({ schedule: I, side: 'SELL', price: sell.price, quantity: sell.quantity, dpApplies: false }).total;
  approx(buy.fee + sell.fee, expected); assert.equal(sell.charges.dp, 0); assert.equal(sell.charges.schedule, I);
  approx(engine.state.realizedPnl, (sell.price - buy.price) * buy.quantity - expected);
  approx(engine.state.cash, 1000 + engine.state.realizedPnl);
});

test('stored state without expert settings loads with the expert defaults and keeps validating updates', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const first = new TradingEngine(store), legacy = structuredClone(first.state);
  delete legacy.settings.expert; store.save(legacy, 'legacy');
  const engine = new TradingEngine(store);
  assert.equal(engine.state.settings.expert.enabled, false);
  engine.settings({ expert: { maxResearchPerSession: 2 } });
  assert.equal(engine.state.settings.expert.maxResearchPerSession, 2);
});

const verdict = o => ({ action: 'abstain', reason: 'none', evidence: [], counterEvidence: [], tightenStopTo: null, trigger: null, record: null, ...o });
const decider = fn => async args => verdict(await fn(args));
function expertEngine(t, fn, { dataset, mode = 'momentum' } = {}) {
  const { engine } = fixture(t, { dataset, decider: decider(fn) });
  engine.settings({ strategy: { mode }, risk: { trailingStopPct: 0 } });
  return engine;
}

test('decider enter is sized by the engine, tagged expert and recorded', async t => {
  const engine = expertEngine(t, () => ({ action: 'enter', reason: 'thesis', trigger: 'entry', record: { a: 1 } }));
  await step(engine);
  const p = engine.state.positions[0], d = engine.state.decisions.at(-1);
  assert.ok(p.quantity > 0 && p.strategyId === 'expert');
  assert.equal(d.action, 'BUY'); assert.equal(d.strategyId, 'expert'); assert.equal(d.expert.a, 1); assert.equal(d.trigger, 'entry');
  assert.equal(d.provider, 'claude-code'); assert.equal(d.model, engine.state.settings.expert.decisionModel);
  assert.equal(d.outcome, 'Paper buy filled'); assert.equal(engine.state.trades[0].strategyId, 'expert');
});

test('decider with no record is recorded as rules-provider', async t => {
  const engine = expertEngine(t, () => ({ action: 'abstain' }));
  await step(engine);
  const d = engine.state.decisions.at(-1);
  assert.equal(d.action, 'HOLD'); assert.equal(d.provider, 'rules'); assert.equal(d.expert, null);
});

test('decider entries use the same sizing as the rules book', async t => {
  const expert = expertEngine(t, () => ({ action: 'enter', reason: 'thesis', record: {} }));
  const { engine: rules } = fixture(t); rules.settings({ risk: { trailingStopPct: 0 } });
  await step(expert); await step(rules);
  assert.equal(rules.state.positions[0].strategyId, 'momentum');
  assert.equal(expert.state.positions[0].quantity, rules.state.positions[0].quantity);
  assert.equal(expert.state.positions[0].stopPrice, rules.state.positions[0].stopPrice);
});

test('tightenStopTo is applied on the bar timestamp; widening, unchanged and above-mark are rejected', async t => {
  let tighten = null;
  const engine = expertEngine(t, ({ state }) => state.positions.length ? { tightenStopTo: tighten } : { action: 'enter', record: {} });
  await step(engine);
  const stop = engine.state.positions[0].stopPrice;
  tighten = stop + 1; await step(engine);
  const p = engine.state.positions[0], d1 = engine.state.decisions.at(-1);
  assert.equal(p.stopPrice, stop + 1); assert.equal(d1.stopRejected, undefined);
  assert.deepEqual(p.stopRevisions, [{ timestamp: engine.state.dataset[engine.state.cursor].timestamp, previous: stop, next: stop + 1, source: 'expert' }]);
  for (const [value, reason] of [[stop - 1, 'widening'], [stop + 1, 'unchanged'], [1e9, 'above-mark'], [Number.NaN, 'invalid']]) {
    tighten = value; await step(engine);
    assert.equal(engine.state.decisions.at(-1).stopRejected, reason);
    assert.equal(engine.state.positions[0].stopPrice, stop + 1); assert.equal(engine.state.positions[0].stopRevisions.length, 1);
  }
});

test('a gap stop closes the position before a decider exit: one sale only', async t => {
  const engine = expertEngine(t, ({ state }) => state.positions.length ? { action: 'exit', reason: 'thesis broken', tightenStopTo: 150, record: {} } : {});
  seed(engine, { strategyId: 'expert', stopPrice: 200 });
  await step(engine);
  const sells = engine.state.trades.filter(trade => trade.action === 'SELL');
  assert.equal(sells.length, 1); assert.match(sells[0].reason, /Gap protective stop/);
  assert.equal(engine.state.decisions.at(-1).outcome, 'Gap stop filled'); assert.equal(engine.state.positions.length, 0);
});

test('decider exit sells at the next open', async t => {
  const engine = expertEngine(t, ({ state }) => state.positions.length ? { action: 'exit', reason: 'thesis broken', record: {} } : {});
  seed(engine, { strategyId: 'expert' });
  await step(engine);
  assert.equal(engine.state.positions.length, 0); assert.equal(engine.state.trades[0].reason, 'thesis broken'); assert.equal(engine.state.trades[0].phase, 'open');
  assert.equal(engine.state.decisions.at(-1).outcome, 'Paper strategy sell filled');
});

test('decider errors suppress entries and keep the held position', async t => {
  const engine = expertEngine(t, () => { throw Object.assign(new Error('call limit reached'), { code: 'MODEL_LIMIT' }); });
  seed(engine, { strategyId: 'expert' });
  await step(engine);
  const d = engine.state.decisions.at(-1);
  assert.equal(d.action, 'HOLD'); assert.match(d.outcome, /^Suppressed: call limit reached/);
  assert.equal(engine.state.positions.length, 1); assert.equal(engine.state.trades.length, 0);
});

test('storage failures from the decider still abort the step', async t => {
  const engine = expertEngine(t, () => { throw Object.assign(new Error('disk'), { code: 'PERSISTENCE_ERROR' }); });
  const cursor = engine.state.cursor;
  await assert.rejects(step(engine), /disk/);
  assert.equal(engine.state.cursor, cursor); assert.equal(engine.state.persistenceFault, true);
});

test('a REPLAY_MISS from the decider aborts the step without committing or faulting', async t => {
  const engine = expertEngine(t, () => { throw Object.assign(new Error('No recorded model output for k.'), { code: 'REPLAY_MISS' }); });
  const before = JSON.stringify(engine.state);
  await assert.rejects(step(engine), error => error.code === 'REPLAY_MISS');
  assert.equal(JSON.stringify(engine.state), before); assert.equal(engine.state.persistenceFault, undefined); assert.notEqual(engine.state.status, 'error-paused');
});

test('blocked entries are not offered to the decider; held positions still are', async t => {
  const seen = [];
  const engine = expertEngine(t, ({ symbol }) => { seen.push(symbol); return { action: 'enter', record: {} }; }, { dataset: rows(['A', 'B']) });
  seed(engine, { strategyId: 'expert' });
  await engine.step({ runId: engine.state.runId, expectedCursor: engine.state.cursor, blockEntries: 'market halt' });
  assert.deepEqual(seen, ['A']);
  const b = engine.state.decisions.find(d => d.symbol === 'B');
  assert.equal(b.action, 'HOLD'); assert.match(b.outcome, /^Suppressed: entries blocked.*market halt/);
  assert.equal(engine.state.positions.length, 1);
});

test('user tightenStop: higher stop records a user revision', t => {
  const { engine } = fixture(t); seed(engine, { stopPrice: 100 });
  engine.tightenStop('held-position', { stopPrice: 110 });
  const p = engine.state.positions[0];
  assert.equal(p.stopPrice, 110); assert.equal(p.stopRevisions.length, 1);
  assert.deepEqual({ ...p.stopRevisions[0], timestamp: undefined }, { timestamp: undefined, previous: 100, next: 110, source: 'user' });
});
test('user tightenStop: equal stop is accepted and recorded as before', t => {
  const { engine } = fixture(t); seed(engine, { stopPrice: 100 });
  engine.tightenStop('held-position', { stopPrice: 100 });
  const p = engine.state.positions[0];
  assert.equal(p.stopPrice, 100); assert.equal(p.stopRevisions.length, 1);
  assert.deepEqual({ ...p.stopRevisions[0], timestamp: undefined }, { timestamp: undefined, previous: 100, next: 100, source: 'user' });
});
test('user tightenStop: lower stop and stops at or above the mark throw the existing messages', t => {
  const { engine } = fixture(t); seed(engine, { stopPrice: 100 });
  assert.throws(() => engine.tightenStop('held-position', { stopPrice: 99 }), /Existing stops may only be tightened\./);
  const mark = engine.state.positions[0].markPrice;
  for (const stopPrice of [mark, mark + 1]) assert.throws(() => engine.tightenStop('held-position', { stopPrice }), /Stop must be positive and below the current mark price\./);
  assert.equal(engine.state.positions[0].stopPrice, 100); assert.equal(engine.state.positions[0].stopRevisions, undefined);
});

test('dailyReport merges extra fields', t => {
  const { engine, store } = fixture(t);
  const payload = engine.dailyReport('2026-10-14', { flagged: false }, { expert: { scores: [{ decisionId: 'd1' }] } });
  assert.deepEqual(payload.expert.scores, [{ decisionId: 'd1' }]);
  assert.deepEqual(store.dailyReports()[0].expert.scores, [{ decisionId: 'd1' }]); assert.equal(engine.dailyReport('2026-10-15').expert, undefined);
});

test('confidenceRiskPct maps confidence to 0.25x-2x of base risk, capped only on the way up', () => {
  const approxEq = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  approxEq(confidenceRiskPct(0.5, 0, 1), 0.125);
  approxEq(confidenceRiskPct(0.5, 1, 1), 1);
  approxEq(confidenceRiskPct(0.5, 1, 0.8), 0.8);
  approxEq(confidenceRiskPct(0.5, 3 / 7, 1), 0.5);
  approxEq(confidenceRiskPct(0.5, null, 1), 0.5);
  approxEq(confidenceRiskPct(5, 1, 1), 5); // a base above the cap is never cut by it
});

test('expert entries are sized by confidence and record it on decision, position and closing trade', async t => {
  const make = confidence => expertEngine(t, ({ state }) => state.positions.length ? { action: 'exit', reason: 'done', record: {} } : { action: 'enter', reason: 'thesis', record: {}, confidence });
  const low = make(0), high = make(1);
  for (const e of [low, high]) { e.settings({ simulation: { startingCapital: 100000 }, risk: { riskPerTradePct: 0.5, stopLossPct: 2, maxPositionPct: 100, maxExposurePct: 100 }, expert: { maxRiskPerTradePct: 1 } }); await step(e); }
  const [pl, ph] = [low.state.positions[0], high.state.positions[0]];
  assert.ok(ph.quantity > pl.quantity * 4, `${ph.quantity} vs ${pl.quantity}`);
  assert.equal(pl.confidence, 0); assert.equal(ph.riskPct, 1);
  const d = high.state.decisions.at(-1); assert.equal(d.confidence, 1); assert.equal(d.riskPct, 1);
  await step(high);
  const sell = high.state.trades.find(trade => trade.action === 'SELL');
  assert.equal(sell.confidence, 1); assert.equal(sell.riskPct, 1);
});

test('rules book sizing ignores confidence', async t => {
  const { engine } = fixture(t); engine.settings({ risk: { trailingStopPct: 0 }, expert: { maxRiskPerTradePct: 5 } });
  await step(engine);
  assert.equal(engine.state.positions[0].riskPct, engine.state.settings.risk.riskPerTradePct);
});

test('universe may change with a position open as long as the held name stays; bar size still needs a flat book', t => {
  const { engine } = fixture(t); seed(engine);
  assert.throws(() => engine.settings({ universe: ['INFY'] }), /Close open positions in A/);
  assert.throws(() => engine.settings({ barMinutes: 60 }), /Close open positions before changing the bar size/);
  assert.deepEqual(engine.settings({ universe: ['INFY', 'A'] }).settings.universe, ['INFY', 'A']);
});

test('relist swaps the watchlist on a live run without resetting the book, keeps held names and merges new history', async t => {
  const { engine } = fixture(t);
  engine.beginLive({ rows: rows(['A', 'B'], 40), assets: [...liveAssets, { symbol: 'B', name: 'B', sector: 'Test' }], source: 'test live' });
  engine.appendBar(bar40('ticks', { A: { open: 140, high: 142, low: 139, close: 141, volume: 1000 }, B: { open: 1, high: 2, low: 1, close: 1, volume: 5 } }));
  await liveStep(engine); // momentum buys A at the open of bar 40
  const { runId, cash, trades, positions } = engine.state;
  assert.equal(positions.length, 1);
  assert.throws(() => engine.relist({ rows: rows(['C'], 41), universe: ['C'] }), /Close open positions in A/);
  assert.throws(() => engine.relist({ rows: rows(['C'], 40), universe: ['A', 'C'] }), /do not reach the current bar for C/);
  // History for C covers every existing bar and one newer closed bar, which joins the dataset.
  engine.relist({ rows: rows(['A', 'C'], 42), universe: ['A', 'C'] });
  const s = engine.state;
  assert.equal(s.runId, runId); assert.equal(s.cash, cash); assert.deepEqual(s.trades, trades); assert.equal(s.positions[0].symbol, 'A');
  assert.deepEqual(s.assets.map(a => a.symbol), ['A', 'C']); assert.deepEqual(s.settings.universe, ['A', 'C']);
  assert.equal(s.dataset.length, 42); assert.equal(s.cursor, 41); assert.equal(s.dataset[41].source, 'historical');
  assert.ok(s.dataset[0].bars.C && !s.dataset[0].bars.B); assert.equal(s.dataset[40].bars.A.open, bar40().bars.A.open);
  assert.equal(engine.histories('C').length, 42); assert.match(s.configHistory.at(-1).note, /Watchlist scan/);
  assert.throws(() => engine.appendBar({ ...bar40(), timestamp: new Date(Date.parse(s.dataset[41].timestamp) + 300_000).toISOString() }), /every universe symbol/);
  const { engine: replay } = fixture(t);
  assert.throws(() => replay.relist({ rows: rows(['A'], 40), universe: ['A'] }), /only to a live run/);
});

test('an index mark turns the pending benchmarks into NIFTY 50 buy-and-hold; a delisted equal-weight holding keeps its last mark', async t => {
  const { engine } = fixture(t);
  engine.beginLive({ rows: rows(['A'], 40), assets: liveAssets, source: 'test live' });
  engine.settings({ risk: { maxExposurePct: 60, maxPositionPct: 25 } });
  engine.markIndex({ name: 'NIFTY 50', close: 25000 });
  let s = engine.state;
  assert.equal(s.benchmark.index, 'NIFTY 50'); approx(s.benchmark.units, 1000 / 25000); approx(s.cappedBenchmark.units, 600 / 25000);
  approx(s.metrics.benchmarkEquity, 1000); approx(s.metrics.cappedBenchmarkEquity, 1000);
  engine.appendBar(bar40()); await liveStep(engine);
  assert.equal(engine.state.benchmark.positions.length, 0); // no equal-weight entry once the index book exists
  engine.markIndex({ name: 'NIFTY 50', close: 26000 });
  s = engine.state; approx(s.metrics.benchmarkEquity, 1040); approx(s.metrics.cappedBenchmarkEquity, 1024);
  assert.throws(() => engine.markIndex({ name: 'NIFTY 50', close: 0 }), /positive close/);
  // A run whose equal-weight benchmark already holds a name the scan later drops: valued at its last mark, never a crash.
  const { engine: legacy } = fixture(t);
  legacy.beginLive({ rows: rows(['A', 'B'], 40), assets: [...liveAssets, { symbol: 'B', name: 'B', sector: 'Test' }], source: 'test live' });
  legacy.appendBar(bar40('ticks', { A: { open: 140, high: 142, low: 139, close: 141, volume: 1000 }, B: { open: 10, high: 12, low: 9, close: 11, volume: 5 } })); await liveStep(legacy);
  legacy.state.positions = legacy.state.positions.filter(p => p.symbol !== 'B'); legacy.updateMetrics(); legacy.store.save(legacy.state, 'test-fixture'); // flat in B, so it may leave
  const before = legacy.state.metrics.benchmarkEquity, bHolding = legacy.state.benchmark.positions.find(p => p.symbol === 'B');
  assert.equal(bHolding.markPrice, 11);
  legacy.relist({ rows: rows(['A', 'C'], 42), universe: ['A', 'C'] });
  assert.ok(Number.isFinite(legacy.state.metrics.benchmarkEquity)); assert.equal(legacy.state.benchmark.positions.find(p => p.symbol === 'B').markPrice, 11);
  assert.notEqual(before, undefined);
});
