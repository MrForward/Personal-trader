/** Entirely synthetic fictional assets. These bars are not market data or a performance claim. */
export const DEMO_ASSETS = Object.freeze([
  Object.freeze({ symbol: 'DEMO-A', name: 'Synthetic trend A', sector: 'Fictional trend market' }),
  Object.freeze({ symbol: 'DEMO-B', name: 'Synthetic range B', sector: 'Fictional range market' }),
  Object.freeze({ symbol: 'DEMO-C', name: 'Synthetic mixed C', sector: 'Fictional changing regime' }),
]);

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = Math.imul(state ^ state >>> 15, state | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

const rounded = (value) => Math.round(value * 1_000_000) / 1_000_000;

/** Fixed seed and origin ensure a shorter request is an identical prefix of a longer replay. */
export function makeDemoSeries({ steps = 180 } = {}) {
  if (!Number.isInteger(steps) || steps < 0 || steps > 10_000) {
    throw new RangeError('Synthetic demo steps must be an integer from 0 to 10000.');
  }
  const random = seededRandom(0x51A7C0DE);
  const previous = { 'DEMO-A': 55, 'DEMO-B': 100, 'DEMO-C': 140 };
  const origin = Date.UTC(2026, 0, 5, 9, 0);
  const series = [];

  for (let index = 0; index < steps; index += 1) {
    const timestamp = new Date(origin + index * 5 * 60_000).toISOString();
    const bars = {};
    for (const { symbol } of DEMO_ASSETS) {
      const open = previous[symbol];
      const noise = random() - 0.5;
      let close;
      const phase = index % 180;
      if (symbol === 'DEMO-A') {
        const drift = phase < 60 ? 0.0018 : phase < 110 ? 0.0001 : -0.0013;
        close = open * (1 + drift + noise * 0.0012);
      } else if (symbol === 'DEMO-B') {
        close = 100 * (1 + 0.038 * Math.sin(index * Math.PI * 2 / 18) + noise * 0.0016);
      } else {
        const drift = phase < 70 ? 0 : phase < 120 ? 0.0022 : -0.0019;
        close = open * (1 + drift + noise * 0.008);
      }
      const wick = 0.0006 + random() * 0.0012;
      const bar = {
        timestamp,
        open: rounded(open),
        high: rounded(Math.max(open, close) * (1 + wick)),
        low: rounded(Math.min(open, close) * (1 - wick)),
        close: rounded(close),
        volume: Math.floor(30_000 + random() * 120_000),
      };
      previous[symbol] = bar.close;
      bars[symbol] = bar;
    }
    series.push({ timestamp, bars });
  }
  return series;
}
