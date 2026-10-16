/**
 * Deterministic research candidates, not validated trading recommendations.
 * Callers must supply only bars that have already closed at the decision time.
 */
export const WARMUP_BARS = 25;

export const STRATEGIES = Object.freeze([
  Object.freeze({
    id: 'momentum',
    name: 'Trend follow',
    description: 'Follow an established trend using SMA10 / SMA25; exit when price loses the fast average.',
    regime: 'trending',
    kind: 'candidate',
  }),
  Object.freeze({
    id: 'mean_reversion',
    name: 'Range reversion',
    description: 'In a range, buy an RSI14 pullback below SMA10; exit on a recovery or a lost range.',
    regime: 'ranging',
    kind: 'candidate',
  }),
  Object.freeze({
    id: 'buy_hold',
    name: 'Buy and hold baseline',
    description: 'Enter once after warmup and hold, for comparison with adaptive candidates.',
    regime: 'all',
    kind: 'baseline',
  }),
]);

function timestampValue(timestamp) {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return timestamp;
  if (typeof timestamp === 'string') return Date.parse(timestamp);
  return NaN;
}

function validateHistory(history) {
  if (!Array.isArray(history)) throw new TypeError('History must be an array of closed OHLCV bars.');
  let previousTime = -Infinity;
  for (const [index, bar] of history.entries()) {
    if (!bar || typeof bar !== 'object') throw new TypeError(`Invalid bar at index ${index}.`);
    const time = timestampValue(bar.timestamp);
    if (!Number.isFinite(time) || time <= previousTime) {
      throw new RangeError(`Bar ${index} must have a valid timestamp strictly after the previous bar.`);
    }
    for (const field of ['open', 'high', 'low', 'close']) {
      if (!Number.isFinite(bar[field]) || bar[field] <= 0) {
        throw new RangeError(`Bar ${index} ${field} must be a finite positive number.`);
      }
    }
    if (bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)) {
      throw new RangeError(`Bar ${index} has inconsistent OHLC bounds.`);
    }
    if (!Number.isFinite(bar.volume) || bar.volume < 0) {
      throw new RangeError(`Bar ${index} volume must be a finite nonnegative number.`);
    }
    if (bar.closed === false || bar.isClosed === false) {
      throw new RangeError(`Bar ${index} is still open; decisions require closed bars.`);
    }
    previousTime = time;
  }
}

const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const display = (value) => value === null ? 'unavailable' : value.toFixed(2);

function wilderAverage(values, period) {
  if (values.length < period) return null;
  let result = average(values.slice(0, period));
  for (let index = period; index < values.length; index += 1) {
    result = ((period - 1) * result + values[index]) / period;
  }
  return result;
}

/** Indicator values are raw measurements. There is no calibrated win probability. */
export function analyzeMarket(history) {
  validateHistory(history);
  const sampleSize = history.length;
  const closes = history.map((bar) => bar.close);
  const latestPrice = closes.at(-1) ?? null;
  const smaFast = sampleSize >= 10 ? average(closes.slice(-10)) : null;
  const smaSlow = sampleSize >= 25 ? average(closes.slice(-25)) : null;
  const changes = closes.slice(1).map((close, index) => close - closes[index]);
  const gains = wilderAverage(changes.map((change) => Math.max(0, change)), 14);
  const losses = wilderAverage(changes.map((change) => Math.max(0, -change)), 14);
  const rsi = gains === null ? null : gains === 0 && losses === 0 ? 50
    : losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
  const trueRanges = history.map((bar, index) => index === 0 ? bar.high - bar.low
    : Math.max(bar.high - bar.low, Math.abs(bar.high - closes[index - 1]), Math.abs(bar.low - closes[index - 1])));
  const atr = wilderAverage(trueRanges, 14);
  const returns = closes.slice(1).map((close, index) => close / closes[index] - 1).slice(-20);
  const meanReturn = returns.length ? average(returns) : null;
  const volatilityPct = returns.length >= 20
    ? Math.sqrt(average(returns.map((value) => (value - meanReturn) ** 2))) * 100 : null;
  const recentCloses = closes.slice(-21);
  const travelled = recentCloses.slice(1).reduce((sum, close, index) => sum + Math.abs(close - recentCloses[index]), 0);
  const trendEfficiency = recentCloses.length >= 21
    ? travelled === 0 ? 0 : Math.abs(recentCloses.at(-1) - recentCloses[0]) / travelled : null;
  const trendGapAtr = smaSlow === null || atr === null ? null
    : atr === 0 ? 0 : Math.abs(smaFast - smaSlow) / atr;

  let regime = 'uncertain';
  if (sampleSize >= WARMUP_BARS) {
    if (trendGapAtr >= 0.7 && trendEfficiency >= 0.4) regime = 'trending';
    else if (trendGapAtr <= 1 && trendEfficiency <= 0.35) regime = 'ranging';
  }

  return {
    latestPrice, smaFast, smaSlow, rsi, atr, volatilityPct, regime, sampleSize,
    asOf: history.at(-1)?.timestamp ?? null,
    trendEfficiency, trendGapAtr,
  };
}

/** Returns a strategy ID. The baseline is selected only when explicitly enabled alone. */
export function chooseStrategy(features, enabled = ['momentum', 'mean_reversion']) {
  let ids;
  if (Array.isArray(enabled)) ids = new Set(enabled);
  else if (enabled && typeof enabled === 'object') ids = new Set(Object.keys(enabled).filter((id) => enabled[id] === true));
  else throw new TypeError('Enabled strategies must be an ID array or a boolean record.');

  if (!features || features.sampleSize < WARMUP_BARS || !Number.isFinite(features.latestPrice)) return 'none';
  if (ids.size === 1 && ids.has('buy_hold')) return 'buy_hold';
  if (features.regime === 'trending' && ids.has('momentum')) return 'momentum';
  if (features.regime === 'ranging' && ids.has('mean_reversion')) return 'mean_reversion';
  return 'none';
}

/** Pure long-only research decision. Execution, sizing and risk limits belong to the caller. */
export function evaluateStrategy(id, history, hasPosition = false) {
  if (typeof hasPosition !== 'boolean') throw new TypeError('hasPosition must be a boolean.');
  if (id !== 'none' && !STRATEGIES.some((strategy) => strategy.id === id)) {
    throw new RangeError(`Unknown strategy: ${id}`);
  }
  const features = analyzeMarket(history);
  const evidence = [`${features.sampleSize} closed bars available; regime: ${features.regime}.`];
  const counterEvidence = ['Candidate rules are unvalidated; this decision is not a probability of profit.'];
  const result = (action, reason) => ({ action, reason, evidence, counterEvidence, strategyId: id, features });

  if (features.sampleSize < WARMUP_BARS) {
    counterEvidence.push(`At least ${WARMUP_BARS} closed bars are required before an entry or strategy exit.`);
    return result('HOLD', 'Waiting for indicator warmup.');
  }
  if (id === 'none') return result('HOLD', 'No enabled candidate fits the measured regime.');
  if (id === 'buy_hold') {
    evidence.push('This is an explicit buy-and-hold comparison, independent of adaptive regime selection.');
    counterEvidence.push('The baseline stays exposed during drawdowns; portfolio risk controls still apply.');
    return result(hasPosition ? 'HOLD' : 'BUY', hasPosition ? 'Keep the baseline position.' : 'Enter the comparison baseline after warmup.');
  }

  const { latestPrice, smaFast, smaSlow, rsi, atr, regime } = features;
  evidence.push(`Last close ${display(latestPrice)}; SMA10 ${display(smaFast)}; SMA25 ${display(smaSlow)}.`);
  evidence.push(`RSI14 ${display(rsi)}; ATR14 ${display(atr)}; per-bar return volatility ${display(features.volatilityPct)}%.`);
  counterEvidence.push('Indicators lag; fees, spreads, partial fills and regime changes can consume a measured edge.');

  if (id === 'momentum') {
    if (hasPosition && (latestPrice < smaFast || smaFast < smaSlow)) {
      return result('SELL', 'Price or the fast average no longer supports the held trend.');
    }
    if (!hasPosition && regime === 'trending' && smaFast > smaSlow && latestPrice > smaFast) {
      return result('BUY', 'The upward trend passes the fixed SMA entry rules.');
    }
    if (regime !== 'trending') counterEvidence.push('The measured regime does not support a new trend entry.');
    if (smaFast <= smaSlow) counterEvidence.push('The fast average does not exceed the slow average.');
    return result('HOLD', hasPosition ? 'The trend exit rule has not triggered.' : 'The upward trend entry rule has not triggered.');
  }

  if (hasPosition && (latestPrice >= smaFast || rsi >= 55 || regime !== 'ranging')) {
    return result('SELL', regime !== 'ranging' ? 'The range assumption is no longer supported.' : 'Price or RSI has recovered from the pullback.');
  }
  if (!hasPosition && regime === 'ranging' && atr > 0 && rsi <= 35 && latestPrice <= smaFast - 0.5 * atr) {
    return result('BUY', 'A range pullback passes the fixed RSI and ATR distance rules.');
  }
  if (regime !== 'ranging') counterEvidence.push('The measured regime does not support a range entry.');
  if (rsi > 35) counterEvidence.push('RSI has not reached the entry threshold of 35.');
  return result('HOLD', hasPosition ? 'Waiting for the range recovery exit.' : 'The range pullback entry rule has not triggered.');
}
