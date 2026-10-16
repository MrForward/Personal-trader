import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMarket, chooseStrategy, evaluateStrategy, STRATEGIES } from '../src/strategies.mjs';
import { makeDemoSeries, DEMO_ASSETS } from '../src/demo-data.mjs';

function barsFrom(closes) {
  return closes.map((close, index) => ({
    timestamp: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
    open: close, high: close + 0.4, low: close - 0.4, close, volume: 1000,
  }));
}

test('warmup and empty histories hold without invented confidence', () => {
  for (const history of [[], barsFrom(Array.from({ length: 24 }, (_, index) => 100 + index))]) {
    const features = analyzeMarket(history);
    assert.equal(features.regime, 'uncertain');
    assert.equal(chooseStrategy(features), 'none');
    const decision = evaluateStrategy('momentum', history, false);
    assert.equal(decision.action, 'HOLD');
    assert.ok(decision.counterEvidence.some((reason) => reason.includes('25')));
    assert.equal('confidence' in decision, false);
    assert.equal('confidence' in features, false);
  }
});

test('a sustained bullish history selects and enters momentum, then exits after reversal', () => {
  const trend = barsFrom(Array.from({ length: 60 }, (_, index) => 100 + index * 0.6));
  const features = analyzeMarket(trend);
  assert.equal(features.regime, 'trending');
  assert.equal(chooseStrategy(features), 'momentum');
  assert.equal(evaluateStrategy('momentum', trend, false).action, 'BUY');
  assert.equal(evaluateStrategy('momentum', trend, true).action, 'HOLD');
  const reversed = barsFrom([...trend.map((bar) => bar.close), 132, 130, 128]);
  assert.equal(evaluateStrategy('momentum', reversed, true).action, 'SELL');
});

test('an oscillating range selects reversion and does not silently select a baseline', () => {
  const range = barsFrom(Array.from({ length: 80 }, (_, index) => 100 + 2 * Math.sin(index * Math.PI * 2 / 10)));
  const features = analyzeMarket(range);
  assert.equal(features.regime, 'ranging');
  assert.equal(chooseStrategy(features), 'mean_reversion');
  assert.equal(chooseStrategy(features, ['momentum']), 'none');
  assert.equal(chooseStrategy(features, []), 'none');
  assert.equal(chooseStrategy(features, { momentum: false, mean_reversion: true }), 'mean_reversion');
  assert.equal(chooseStrategy(features, ['buy_hold']), 'buy_hold');
  assert.equal(evaluateStrategy('buy_hold', range, false).action, 'BUY');
  assert.equal(evaluateStrategy('buy_hold', range, true).action, 'HOLD');
});

test('flat prices have finite neutral indicators and no mean-reversion entry', () => {
  const history = barsFrom(Array(30).fill(100));
  const features = analyzeMarket(history);
  assert.equal(features.rsi, 50);
  assert.equal(features.volatilityPct, 0);
  assert.ok(features.atr > 0);
  assert.equal(evaluateStrategy('mean_reversion', history, false).action, 'HOLD');
});

test('future bars cannot alter a recorded prefix decision and analysis does not mutate input', () => {
  const history = makeDemoSeries({ steps: 60 }).map((step) => step.bars['DEMO-A']);
  const prefix = history.slice(0, 40);
  const original = structuredClone(prefix);
  for (const bar of prefix) Object.freeze(bar);
  Object.freeze(prefix);
  const before = evaluateStrategy('momentum', prefix, false);
  const future = barsFrom([10000, 10001, 10002]).map((bar, index) => ({
    ...bar, timestamp: new Date(Date.parse(history.at(-1).timestamp) + (index + 1) * 60_000).toISOString(),
  }));
  evaluateStrategy('momentum', [...history, ...future], false);
  assert.deepEqual(evaluateStrategy('momentum', prefix, false), before);
  assert.deepEqual(prefix, original);
  assert.equal(before.features.asOf, prefix.at(-1).timestamp);
  assert.equal(before.features.sampleSize, 40);
});

test('invalid bars, duplicate/out-of-order time, and still-open bars reject', () => {
  const valid = barsFrom([100, 101, 102]);
  assert.throws(() => analyzeMarket(null), /array/);
  for (const patch of [
    { close: NaN }, { open: 0 }, { high: Infinity }, { low: -1 },
    { high: 99 }, { low: 102 }, { volume: -1 }, { timestamp: 'invalid' }, { closed: false },
  ]) {
    assert.throws(() => analyzeMarket([{ ...valid[0], ...patch }]));
  }
  assert.throws(() => analyzeMarket([valid[0], valid[0]]), /strictly after/);
  assert.throws(() => analyzeMarket([valid[1], valid[0]]), /strictly after/);
  assert.throws(() => evaluateStrategy('unknown', valid, false), /Unknown strategy/);
});

test('synthetic replay is deterministic, prefix-stable, and uses consistent fictional OHLCV bars', () => {
  const short = makeDemoSeries({ steps: 50 });
  const long = makeDemoSeries({ steps: 180 });
  assert.deepEqual(short, makeDemoSeries({ steps: 50 }));
  assert.deepEqual(short, long.slice(0, 50));
  assert.deepEqual(DEMO_ASSETS.map((asset) => asset.symbol), ['DEMO-A', 'DEMO-B', 'DEMO-C']);
  for (const { symbol } of DEMO_ASSETS) {
    const history = long.map((step) => {
      const bar = step.bars[symbol];
      assert.equal(bar.timestamp, step.timestamp);
      assert.ok(bar.high >= Math.max(bar.open, bar.close));
      assert.ok(bar.low <= Math.min(bar.open, bar.close));
      assert.ok(bar.low > 0 && bar.volume > 0);
      return bar;
    });
    assert.doesNotThrow(() => analyzeMarket(history));
  }
  assert.deepEqual(STRATEGIES.map((strategy) => strategy.id), ['momentum', 'mean_reversion', 'buy_hold']);
  assert.throws(() => makeDemoSeries({ steps: -1 }), /integer/);
});
