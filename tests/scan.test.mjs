import test from 'node:test';
import assert from 'node:assert/strict';
import { rankCandidates, chooseWatchlist, scanWatchlist } from '../src/scan.mjs';

const daily = ({ drift, lastVolume = 100, count = 30 }) => Array.from({ length: count }, (_, i) => ({ date: `d${i}`, open: 1, high: 1, low: 1, close: 100 * (1 + drift) ** i, volume: i === count - 1 ? lastVolume : 100 }));

test('rankCandidates keeps positive momentum only and ranks momentum with relative volume', () => {
  const ranked = rankCandidates({ FLAT: daily({ drift: 0 }), DOWN: daily({ drift: -0.01 }), UP: daily({ drift: 0.01 }), UPLOUD: daily({ drift: 0.009, lastVolume: 500 }), MID: daily({ drift: 0.008, lastVolume: 300 }), SHORT: daily({ drift: 0.02, count: 10 }) });
  assert.deepEqual(ranked.map(row => row.symbol), ['UPLOUD', 'UP', 'MID']);
  assert.ok(ranked[0].relVolume > 4 && ranked[1].momentum > 0.2);
});

test('chooseWatchlist keeps held names, fills the rest in rank order and sorts', () => {
  assert.deepEqual(chooseWatchlist({ held: ['ZZ', 'B'], ranked: ['C', 'B', 'A', 'D'], slots: 3 }), ['B', 'C', 'ZZ']);
  assert.deepEqual(chooseWatchlist({ held: ['A', 'B', 'C'], ranked: ['D'], slots: 2 }), ['A', 'B', 'C']);
});

test('scanWatchlist filters by price and turnover, fetches daily bars for the most traded names and tolerates a failed fetch', async () => {
  const quotes = { CHEAPLIQ: { price: 500, volume: 1_000_000, averagePrice: 500 }, PRICEY: { price: 2000, volume: 1_000_000, averagePrice: 2000 },
    THIN: { price: 50, volume: 100, averagePrice: 50 }, BROKEN: { price: 300, volume: 2_000_000, averagePrice: 300 }, DOWN: { price: 100, volume: 5_000_000, averagePrice: 100 } };
  const fetched = [], logs = [];
  const session = { equities: () => Object.keys(quotes), quotes: async symbols => Object.fromEntries(symbols.map(s => [s, quotes[s]])),
    historicalBars: async ({ symbol, barMinutes }) => { fetched.push([symbol, barMinutes]); if (symbol === 'BROKEN') throw new Error('rate limited'); return daily({ drift: symbol === 'DOWN' ? -0.01 : 0.01 }); } };
  const settings = { scan: { slots: 2, maxPrice: 1500, minTurnoverCr: 25 } };
  const list = await scanWatchlist({ session, settings, held: ['HELD'], endMs: 0, log: m => logs.push(m), pause: async () => {} });
  assert.deepEqual(fetched, [['BROKEN', 'day'], ['CHEAPLIQ', 'day'], ['DOWN', 'day']]); // by turnover; PRICEY and THIN never qualify
  assert.deepEqual(list, ['CHEAPLIQ', 'HELD']); assert.match(logs[0], /BROKEN.*rate limited/);
  await assert.rejects(() => scanWatchlist({ session: { ...session, quotes: async () => ({}) }, settings, held: [], endMs: 0, pause: async () => {} }), /no liquid candidates/);
});
