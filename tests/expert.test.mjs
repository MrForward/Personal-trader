import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/config.mjs';
import { SECTOR_INDEX, buildContextPack } from '../src/expert.mjs';

// 15-minute bars ending 09:30..15:30 IST on 13 and 14 October 2026.
const dataset = [];
for (const day of ['2026-10-13', '2026-10-14']) for (let slot = 0; slot < 25; slot++) {
  const end = Date.parse(`${day}T09:15:00+05:30`) + (slot + 1) * 15 * 60_000, price = 100 + dataset.length * 0.3 + (slot % 3);
  dataset.push({ timestamp: new Date(end).toISOString(), closed: true, bars: { DEMO1: { open: price, high: price + 1, low: price - 1, close: price + 0.2, volume: 1000 } } });
}
const daily = (from, volume) => Array.from({ length: 25 }, (_, i) => { const d = new Date(Date.UTC(2026, 8, 7 + i)); return { date: d.toISOString().slice(0, 10), open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume }; });
const claim = (recordId, analysisReadyAt, sourceKinds = ['news']) => ({ recordId, origin: recordId, content: `claim ${recordId}`, sourceKinds, analysisReadyAt, status: 'reported', fresh: true });
const fixture = {
  symbol: 'DEMO1', asOf: '2026-10-14T05:00:00Z', // 10:30 IST on the 14th
  state: { cash: 5000, metrics: { equity: 9000, exposurePct: 44 }, positions: [], dataset, cursor: dataset.length - 1, settings: DEFAULT_SETTINGS },
  daily: { DEMO1: [...daily(0, 1000), { date: '2026-10-14', open: 1, high: 1, low: 1, close: 1, volume: 1 }], 'NIFTY 50': daily(0, 0), 'NIFTY IT': daily(0, 0) },
  intelligence: { claims: [claim('early', '2026-10-14T03:00:00Z'), claim('event', '2026-10-14T03:30:00Z', ['calendar'])], coverage: { originCount: 2 }, limitations: ['captured only'] },
  memory: [], thesis: null, callsRemaining: 40,
};

test('context pack excludes anything after asOf and is deterministic', () => {
  const pack1 = buildContextPack(fixture);
  assert.deepEqual(buildContextPack(fixture), pack1);
  const later = { ...fixture, daily: { ...fixture.daily, DEMO1: [...fixture.daily.DEMO1, { date: '2026-10-15', open: 1, high: 1, low: 1, close: 1, volume: 1 }] },
    intelligence: { ...fixture.intelligence, claims: [...fixture.intelligence.claims, claim('late', '2026-10-14T06:00:00Z')] } };
  assert.equal(JSON.stringify(buildContextPack(later)), JSON.stringify(pack1));
  assert.equal(pack1.version, 1); assert.deepEqual(pack1.evidence.claims.map(c => c.recordId), ['early']);
  assert.ok(pack1.price.daily.at(-1).date < '2026-10-14'); assert.ok(pack1.price.daily.length <= 60);
});

test('context pack price block: 15-minute features, today range in ATR and volume against the 20-day mean', () => {
  const { price, calendar, portfolio, limits } = buildContextPack(fixture);
  assert.equal(price.features.sampleSize, 25 + 5); // 13 Oct full day plus 09:30..10:30 on the 14th
  const today = dataset.slice(25, 30).map(row => row.bars.DEMO1);
  const range = Math.max(...today.map(b => b.high)) - Math.min(...today.map(b => b.low));
  assert.ok(Math.abs(price.todayRangeAtr - range / price.features.atr) < 1e-9);
  assert.equal(price.volumeVs20d, 5000 / 1000);
  assert.deepEqual(price.nifty50.at(-1), { date: '2026-10-01', close: 125 }); assert.equal(price.sector.index, null);
  assert.deepEqual(calendar.events.map(e => e.recordId), ['event']); assert.ok(Array.isArray(calendar.holidays));
  assert.equal(portfolio.cash, 5000); assert.equal(limits.sizingIsDeterministic, true); assert.equal(limits.callsRemaining, 40); assert.equal(limits.stopLossPct, 2);
});

test('mapped symbols get their sector index series and missing inputs give null', () => {
  const mapped = buildContextPack({ ...fixture, symbol: 'INFY', state: { ...fixture.state, dataset: dataset.map(r => ({ ...r, bars: { INFY: r.bars.DEMO1 } })) }, daily: { INFY: fixture.daily.DEMO1, 'NIFTY IT': daily(0, 0) } });
  assert.equal(mapped.price.sector.index, 'NIFTY IT'); assert.equal(mapped.price.sector.closes.length, 25); assert.equal(mapped.price.nifty50, null);
  const bare = buildContextPack({ ...fixture, daily: {} });
  assert.equal(bare.price.volumeVs20d, null); assert.deepEqual(bare.price.daily, []);
});

test('context pack memory only includes reviews at or before asOf', () => {
  const memory = [{ reviewedAt: '2026-10-14T06:00:00Z', lesson: 'future' }, { reviewedAt: '2026-10-14T04:00:00Z', lesson: 'past' }];
  assert.deepEqual(buildContextPack({ ...fixture, memory }).memory.map(m => m.lesson), ['past']);
});

test('context pack rejects packs over 60000 characters', () => {
  assert.throws(() => buildContextPack({ ...fixture, thesis: { stance: 'watch', thesis: 'x'.repeat(70000) } }), /60000/);
});

test('unmapped symbol gets null sector index', () => {
  assert.equal(SECTOR_INDEX.UNKNOWN ?? null, null); assert.equal(SECTOR_INDEX.TATASTEEL, 'NIFTY METAL');
});
