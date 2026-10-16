import test from 'node:test';
import assert from 'node:assert/strict';
import { intelligenceContext, validateIntelligence, makeDemoIntelligence } from '../src/intelligence.mjs';
import { makeDemoSeries } from '../src/demo-data.mjs';

const at = (minute) => new Date(Date.UTC(2026, 0, 5, 9, minute)).toISOString();
const record = (patch = {}) => ({
  id: 'event-1', symbol: 'TEST', origin: 'issuer:operating-update',
  publishedAt: at(0), firstReceivedAt: at(8), analysisReadyAt: at(10),
  sourceKind: 'primary', verificationStatus: 'primary-confirmed', version: 1,
  content: 'The issuer published an operating update.', ...patch,
});

test('publication alone is not availability; analysis must be ready at the decision time', () => {
  const records = [record()];
  for (const minute of [0, 5, 8, 9]) {
    const context = intelligenceContext({ records, symbol: 'TEST', asOf: at(minute) });
    assert.equal(context.availableRecords.length, 0);
    assert.equal(context.claims.length, 0);
    assert.equal(context.entryBlocked, false);
  }
  assert.equal(intelligenceContext({ records, symbol: 'TEST', asOf: at(10) }).claims[0].usableForEntry, true);
});

test('a future correction changes neither earlier context nor its verification state', () => {
  const original = record();
  const correction = record({ id: 'event-2', version: 2, supersedes: 'event-1',
    publishedAt: at(20), firstReceivedAt: at(21), analysisReadyAt: at(22),
    verificationStatus: 'retracted', content: 'The earlier operating update was retracted.' });
  const before = intelligenceContext({ records: [original], symbol: 'TEST', asOf: at(15) });
  assert.deepEqual(intelligenceContext({ records: [original, correction], symbol: 'TEST', asOf: at(15) }), before);
  const after = intelligenceContext({ records: [original, correction], symbol: 'TEST', asOf: at(22) });
  assert.equal(after.availableRecords.length, 2);
  assert.equal(after.claims.length, 1);
  assert.equal(after.claims[0].status, 'retracted');
  assert.equal(after.claims[0].usableForEntry, false);
  assert.deepEqual(after.claims[0].supersededRecordIds, ['event-1']);
  assert.equal(after.evidence.length, 0);
  assert.equal(after.entryBlocked, true);
});

test('syndicated copies share one origin and cannot manufacture corroboration or freshness', () => {
  const original = record({ verificationStatus: 'reported', sourceKind: 'news', analysisReadyAt: at(9) });
  const copy = record({ id: 'copy', verificationStatus: 'reported', sourceKind: 'news',
    publishedAt: at(25), firstReceivedAt: at(26), analysisReadyAt: at(27), content: 'A syndicated repost of the update.' });
  const context = intelligenceContext({ records: [original, copy], symbol: 'TEST', asOf: at(30), maxAgeMinutes: 15 });
  assert.equal(context.availableRecords.length, 2);
  assert.equal(context.coverage.originCount, 1);
  assert.equal(context.coverage.syndicatedCopyCount, 1);
  assert.equal(context.claims[0].verified, false);
  assert.equal(context.claims[0].publishedAt, at(0));
  assert.equal(context.claims[0].fresh, false);
  assert.equal(context.evidence.length, 0);
});

test('rumor-only or disputed context blocks entry; unrelated symbols do not', () => {
  const rumor = record({ sourceKind: 'social', verificationStatus: 'unverified' });
  const context = intelligenceContext({ records: [rumor], symbol: 'TEST', asOf: at(15) });
  assert.equal(context.entryBlocked, true);
  assert.equal(context.evidence.length, 0);
  assert.ok(context.counterEvidence[0].includes('unverified'));
  assert.equal(intelligenceContext({ records: [rumor], symbol: 'OTHER', asOf: at(15) }).entryBlocked, false);
  const confirmed = record({ id: 'independent', origin: 'exchange:separate-notice' });
  const disputed = record({ id: 'dispute', origin: 'issuer:contested-event', verificationStatus: 'disputed' });
  assert.equal(intelligenceContext({ records: [confirmed, disputed], symbol: 'TEST', asOf: at(15) }).entryBlocked, true);
});

test('old/retracted records never become fresh evidence through late receipt', () => {
  const late = record({ firstReceivedAt: at(59), analysisReadyAt: at(60) });
  const optional = intelligenceContext({ records: [late], symbol: 'TEST', asOf: at(61), maxAgeMinutes: 30 });
  assert.equal(optional.claims[0].fresh, false);
  assert.equal(optional.coverage.freshVerifiedClaimCount, 0);
  assert.equal(optional.entryBlocked, false);
  assert.equal(intelligenceContext({ records: [late], symbol: 'TEST', asOf: at(61), maxAgeMinutes: 30, requireVerified: true }).entryBlocked, true);
  assert.equal(intelligenceContext({ records: [], symbol: 'TEST', asOf: at(61), mandatorySourceKinds: ['primary'] }).entryBlocked, true);
  assert.equal(intelligenceContext({ records: [], symbol: 'TEST', asOf: at(61) }).entryBlocked, false);
});

test('required source kinds need current verified evidence, not an older superseded source', () => {
  const original = record();
  const correction = record({ id: 'corrected', version: 2, supersedes: 'event-1', sourceKind: 'news',
    publishedAt: at(20), firstReceivedAt: at(21), analysisReadyAt: at(22), content: 'Corrected detail.' });
  const context = intelligenceContext({ records: [original, correction], symbol: 'TEST', asOf: at(25), mandatorySourceKinds: ['primary'] });
  assert.equal(context.claims[0].version, 2);
  assert.deepEqual(context.coverage.missingMandatoryKinds, ['primary']);
  assert.equal(context.entryBlocked, true);
});

test('schema normalization is pure and rejects invalid time, IDs, status and correction chains', () => {
  const source = record({ publishedAt: '2026-01-05T14:30:00+05:30' });
  const before = structuredClone(source);
  Object.freeze(source);
  const normalized = validateIntelligence([source]);
  assert.equal(normalized[0].publishedAt, at(0));
  assert.deepEqual(source, before);
  for (const patch of [
    { firstReceivedAt: at(-1) }, { analysisReadyAt: at(7) }, { publishedAt: '2026-02-30T09:00:00Z' },
    { publishedAt: '2026-01-05T09:00:00' }, { verificationStatus: 'profitable' }, { sourceKind: 'LLM' },
    { version: 2 }, { supersedes: 'event-1' }, { content: '' }, { unknown: true },
    { sourceUrl: 'https://secret:password@example.test/news' }, { sourceKind: 'synthetic' },
  ]) assert.throws(() => validateIntelligence([record(patch)]));
  assert.throws(() => validateIntelligence([record(), record()]), /Duplicate/);
  assert.throws(() => validateIntelligence([record(), record({ id: 'bad-copy', verificationStatus: 'unverified' })]), /agree on status/);
  assert.throws(() => validateIntelligence([record(), record({ id: 'bad-chain', origin: 'other-origin', version: 2, supersedes: 'event-1' })]), /same symbol\/origin/);
});

test('fictional fixtures are deterministic and time-correct; real imported symbols get no invented news', () => {
  const series = makeDemoSeries({ steps: 100 });
  const demo = makeDemoIntelligence(series);
  assert.deepEqual(demo, makeDemoIntelligence(series));
  assert.ok(demo.length > 0);
  assert.ok(demo.every((item) => item.symbol.startsWith('DEMO-') && item.sourceKind === 'synthetic'));
  const short = makeDemoIntelligence(series.slice(0, 35));
  const asOf = series[34].timestamp;
  for (const symbol of ['DEMO-A', 'DEMO-B', 'DEMO-C']) {
    assert.deepEqual(intelligenceContext({ records: demo, symbol, asOf }), intelligenceContext({ records: short, symbol, asOf }));
  }
  assert.equal(intelligenceContext({ records: demo, symbol: 'DEMO-B', asOf }).entryBlocked, true);
  assert.equal(intelligenceContext({ records: demo, symbol: 'DEMO-A', asOf }).coverage.originCount, 1);
  const imported = series.map((row) => ({ timestamp: row.timestamp, bars: { TEST: row.bars['DEMO-A'] } }));
  assert.deepEqual(makeDemoIntelligence({ rows: imported }), []);
});
