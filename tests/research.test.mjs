import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/config.mjs';
import { intelligenceContext } from '../src/intelligence.mjs';
import { RESEARCH_SCHEMA, researchSymbol, researchMarket, isAnomaly } from '../src/research.mjs';

const NOW = '2026-10-19T03:00:00Z';
const fakeRunner = (output, seen = []) => async (args) => { seen.push(args); return { value: output, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0.01 }; };
const rec = (sourceUrl, extra = {}) => ({ origin: 'Infosys results', publishedAt: '2026-10-18T10:00:00+05:30', sourceKind: 'primary', verificationStatus: 'primary-confirmed', content: 'Results announced.', sourceUrl, ...extra });
const run = (records, extra = {}) => researchSymbol({ symbol: 'INFY', companyName: 'Infosys', now: NOW, settings: DEFAULT_SETTINGS, runner: fakeRunner({ records, coverageNote: 'ok' }), ...extra });

test('records get capture timestamps, ids and pass validateIntelligence', async () => {
  const r = await run([rec('https://www.nseindia.com/x')]);
  assert.equal(r.records[0].firstReceivedAt, '2026-10-19T03:00:00.000Z');
  assert.equal(r.records[0].analysisReadyAt, '2026-10-19T03:00:00.000Z');
  assert.equal(r.records[0].version, 1);
  assert.equal(r.records[0].symbol, 'INFY');
  assert.match(r.records[0].id, /^INFY:[0-9a-f]{12}$/);
  assert.deepEqual([r.dropped, r.coverageNote, r.costUsd], [0, 'ok', 0.01]);
});

test('off-list URLs are dropped and counted', async () => {
  const r = await run([rec('https://www.nseindia.com/x'), rec('https://example.com/y', { origin: 'Other' }), rec('https://evilnseindia.com/z', { origin: 'Spoof' })]);
  assert.equal(r.records.length, 1); assert.equal(r.dropped, 2);
});

test('subdomain of an allowed domain is accepted', async () => {
  assert.equal((await run([rec('https://archives.nseindia.com/a.pdf')])).records.length, 1);
});

test('a publishedAt after now is dropped while a good record survives', async () => {
  const r = await run([rec('https://www.nseindia.com/x', { origin: 'Future', publishedAt: '2026-10-20T10:00:00+05:30' }), rec('https://www.nseindia.com/y')]);
  assert.deepEqual([r.records.length, r.dropped], [1, 1]); assert.equal(r.records[0].origin, 'Infosys results');
});

test('a status disagreement with an earlier copy drops only that record', async () => {
  const r = await run([rec('https://www.nseindia.com/a'), rec('https://www.reuters.com/b', { publishedAt: '2026-10-18T11:00:00+05:30', verificationStatus: 'reported', sourceKind: 'news' })]);
  assert.deepEqual([r.records.length, r.dropped], [1, 1]);
});

test('same origin twice yields two records that intelligenceContext merges to one claim with earliest publishedAt', async () => {
  const r = await run([rec('https://www.nseindia.com/a', { publishedAt: '2026-10-18T12:00:00+05:30' }), rec('https://www.reuters.com/b', { publishedAt: '2026-10-18T10:00:00+05:30', sourceKind: 'news' })]);
  assert.equal(r.records.length, 2);
  const ctx = intelligenceContext({ records: r.records, symbol: 'INFY', asOf: NOW });
  assert.equal(ctx.claims.length, 1); assert.equal(ctx.claims[0].publishedAt, '2026-10-18T04:30:00.000Z');
});

test('runner receives WebFetch domain rules and no portfolio fields', async () => {
  const seen = []; await run([], { runner: fakeRunner({ records: [], coverageNote: 'none' }, seen) });
  const a = seen[0];
  assert.ok(a.tools.includes('WebSearch') && a.tools.includes('WebFetch(domain:nseindia.com)'));
  assert.deepEqual([a.model, a.maxTurns, a.timeoutMs, a.schema], ['claude-sonnet-5-5', 3, 120000, RESEARCH_SCHEMA]);
  assert.match(a.systemPrompt, /evidence/i);
  const input = JSON.parse(a.input);
  assert.deepEqual([input.symbol, input.companyName], ['INFY', 'Infosys']); assert.match(input.nowIst, /\+05:30$/);
  assert.ok(!/cash|equity|position/i.test(a.input));
});

test('researchMarket tags MARKET, sends no company name, applies the allow-list', async () => {
  const seen = [];
  const r = await researchMarket({ now: NOW, settings: DEFAULT_SETTINGS, runner: fakeRunner({ records: [rec('https://www.rbi.org.in/p', { origin: 'RBI policy', sourceKind: 'calendar', eventAt: '2026-10-25T10:00:00+05:30' }), rec('https://example.com/q', { origin: 'x' })], coverageNote: 'ok' }, seen) });
  assert.deepEqual([r.records.length, r.dropped, r.records[0].symbol], [1, 1, 'MARKET']);
  assert.match(r.records[0].id, /^MARKET:/);
  assert.equal(JSON.parse(seen[0].input).companyName, undefined);
});

test('isAnomaly on range and volume', () => {
  const t0 = Date.parse('2026-10-14T04:00:00Z');
  const history = Array.from({ length: 30 }, (_, i) => ({ timestamp: new Date(t0 + i * 900_000).toISOString(), open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 }));
  const daily = Array.from({ length: 20 }, () => ({ volume: 37_500 })); // 1500 per 15-min bar
  const bar = (high, low, volume) => ({ open: 100, high, low, close: 100, volume });
  assert.equal(isAnomaly(bar(101.5, 99, 1000), history, daily), true);   // range 2.5 > 2 x ~1
  assert.equal(isAnomaly(bar(100.5, 99.5, 4600), history, daily), true); // volume > 3 x 1500
  assert.equal(isAnomaly(bar(100.5, 99.5, 4400), history, daily), false);
  assert.equal(isAnomaly(bar(101.5, 99, 9999), history.slice(0, 10), daily), false);
  assert.equal(isAnomaly(bar(100.5, 99.5, 99999), history.slice(0, 10), daily), false);
  assert.equal(isAnomaly(bar(100.5, 99.5, 99999), history, daily.slice(0, 19)), false);
  assert.equal(isAnomaly(bar(100.5, 99.5, 9001), history, daily, 30), true); // 30-min bars: 3000 each, 3x = 9000
});
