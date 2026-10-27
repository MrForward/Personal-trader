import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/config.mjs';
import { SECTOR_INDEX, buildContextPack, calibration, makeDecider, makeScoring, reviewClosed, runTheses, scoreDecisions, scorecard, triggerFor, validateDecision, validateThesis } from '../src/expert.mjs';
import { Store } from '../src/store.mjs';
import { intelligenceContext } from '../src/intelligence.mjs';

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

// A MARKET calendar record (RBI policy), captured at 08:31 IST on the 14th.
const rbi = { id: 'MARKET:rbi000000001', symbol: 'MARKET', origin: 'RBI policy date', publishedAt: '2026-10-13T12:00:00.000Z', firstReceivedAt: '2026-10-14T03:01:00.000Z',
  analysisReadyAt: '2026-10-14T03:01:00.000Z', eventAt: '2026-10-21T04:30:00.000Z', sourceKind: 'calendar', verificationStatus: 'primary-confirmed', content: 'RBI policy decision on 21 Oct.', sourceUrl: 'https://www.rbi.org.in/p', version: 1 };
const marketNews = { ...rbi, id: 'MARKET:news00000001', origin: 'FII flows', sourceKind: 'news', verificationStatus: 'reported', content: 'FIIs sold.', sourceUrl: 'https://www.reuters.com/f' };
const marketAt = asOfIso => intelligenceContext({ records: [rbi, marketNews], symbol: 'MARKET', asOf: asOfIso });

test('I3: MARKET evidence reaches a stock pack, cut at asOf; its calendar claims join calendar.events', () => {
  const pack = buildContextPack({ ...fixture, market: marketAt(fixture.asOf) });
  assert.deepEqual(pack.evidence.market.map(c => c.recordId), [marketNews.id]);
  assert.deepEqual(pack.calendar.events.map(c => c.recordId), ['event', rbi.id]);
  const early = buildContextPack({ ...fixture, asOf: '2026-10-14T03:00:00Z', market: { claims: marketAt(fixture.asOf).claims } });
  assert.deepEqual([early.evidence.market, early.calendar.events.map(c => c.recordId)], [[], []]);
});

test('I3: an oversize pack keeps the 20 most recent market claims before giving up', () => {
  const claims = Array.from({ length: 30 }, (_, i) => ({ ...claim(`MARKET:m${String(i).padStart(2, '0')}`, '2026-10-14T03:00:00Z'), publishedAt: new Date(Date.parse('2026-10-13T00:00:00Z') + i * 60_000).toISOString(), content: 'x'.repeat(2000) }));
  const pack = buildContextPack({ ...fixture, market: { claims } });
  assert.equal(pack.evidence.market.length, 20); assert.ok(pack.evidence.market.every(c => c.recordId >= 'MARKET:m10'));
  assert.throws(() => buildContextPack({ ...fixture, market: { claims: claims.map(c => ({ ...c, content: 'x'.repeat(4000) })) } }), /60000/);
});

test('unmapped symbol gets null sector index', () => {
  assert.equal(SECTOR_INDEX.UNKNOWN ?? null, null); assert.equal(SECTOR_INDEX.TATASTEEL, 'NIFTY METAL');
});

// ---- Theses, decisions and triggers ----
const close = '2026-10-14T10:00:00.000Z';
const goodThesis = {
  stance: 'candidate', thesis: 'Results beat; momentum confirms.', mechanism: 'Upgrades follow results.', counterEvidence: ['Market weak'], evidenceIds: ['INFY:abc'],
  entryCondition: { type: 'rulesSignal' }, invalidation: { priceBelow: 90, note: 'Gap fill' }, expectedHoldSessions: 2, expiresAt: '2026-10-16T10:00:00.000Z',
  eventAssessment: { novelty: 'new', materiality: 'high', surprise: 'unknown', reaction: 'muted' },
};
const goodDecision = { action: 'enter', reason: 'Signal with evidence.', counterEvidence: ['Weak market'], evidenceIds: ['early'], tightenStopTo: null, invalidation: { priceBelow: 95, note: 'Below gap' }, confidence: 0.6 };
const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
const asOf = dataset.at(-1).timestamp, day = '2026-10-14';
const buyContext = (claims = [claim('early', '2026-10-14T03:00:00Z')]) => ({ rulesChoice: 'momentum', candidates: [{ strategyId: 'momentum', action: 'BUY' }], intelligence: { claims } });
const position = { symbol: 'DEMO1', quantity: 10, entryPrice: 100, stopPrice: 90, strategyId: 'expert' };

function harness(t, { value = goodDecision, thesis = { ...goodThesis, evidenceIds: [], createdAt: '2026-10-14T03:15:00.000Z' }, settings = DEFAULT_SETTINGS, ...options } = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  if (thesis) store.saveThesis('DEMO1', day, thesis);
  const calls = [];
  const runner = options.runner ?? (async args => { calls.push(args); return { value: typeof value === 'function' ? value(args) : value, usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.01 }; });
  const decider = makeDecider({ store, settings, runner, now: options.now ?? (() => Date.parse('2026-10-14T10:05:00Z')), replay: options.replay });
  const state = { ...fixture.state, positions: options.positions ?? [], cursor: options.cursor ?? dataset.length - 1 };
  return { store, calls, decider, state, run: (context = buyContext(), s = state) => decider({ symbol: 'DEMO1', state: s, context }) };
}

test('validateThesis rejects unknown evidence id and too-late expiry', () => {
  const opts = { evidenceIds: ['INFY:abc'], sessionCloseIso: close };
  assert.deepEqual(validateThesis(goodThesis, opts), goodThesis);
  assert.throws(() => validateThesis({ ...goodThesis, evidenceIds: ['nope'] }, opts), /evidence/);
  assert.throws(() => validateThesis({ ...goodThesis, expectedHoldSessions: 2, expiresAt: '2026-11-30T10:00:00Z' }, opts), /expires/);
  assert.throws(() => validateThesis({ ...goodThesis, expectedHoldSessions: 1 }, opts), /expires/); // 16 Oct close is two sessions out
  assert.throws(() => validateThesis({ ...goodThesis, invalidation: { priceBelow: 0, note: 'x' } }, opts), /invalidation/);
  assert.throws(() => validateThesis({ ...goodThesis, stance: 'buy' }, opts), /enum/);
  // From Fri 16 Oct, two sessions skip the weekend and the 20 Oct holiday: Mon 19, Wed 21.
  assert.ok(validateThesis({ ...goodThesis, expiresAt: '2026-10-21T10:00:00Z' }, { evidenceIds: ['INFY:abc'], sessionCloseIso: '2026-10-16T10:00:00Z' }));
  assert.throws(() => validateThesis({ ...goodThesis, expiresAt: '2026-10-22T10:00:00Z' }, { evidenceIds: ['INFY:abc'], sessionCloseIso: '2026-10-16T10:00:00Z' }), /expires/);
});

test('validateDecision rejects invalidation moved down on a held position', () => {
  const thesis = { invalidation: { priceBelow: 100, note: 'x' } }, decision = { ...goodDecision, action: 'hold', invalidation: { priceBelow: 95, note: 'lower' } };
  assert.throws(() => validateDecision(decision, { evidenceIds: ['early'], position, thesis }), /invalidation/);
  assert.ok(validateDecision(decision, { evidenceIds: ['early'], position: null, thesis }));
  assert.throws(() => validateDecision({ ...goodDecision, evidenceIds: ['nope'] }, { evidenceIds: ['early'], position: null, thesis }), /evidence/);
  assert.throws(() => validateDecision({ ...goodDecision, tightenStopTo: 0 }, { evidenceIds: ['early'], position, thesis: null }), /tightenStopTo/);
  assert.throws(() => validateDecision({ ...goodDecision, extra: 1 }, { evidenceIds: ['early'], position: null, thesis }), /not allowed/);
});

test('triggerFor order and conditions', () => {
  const bar = { open: 100, high: 102, low: 99, close: 101 };
  const th = { stance: 'watch', entryCondition: { type: 'rulesSignal' }, invalidation: { priceBelow: 100, note: 'x' } };
  assert.equal(triggerFor({ thesis: { stance: 'candidate', entryCondition: { type: 'rulesSignal' } }, position: null, rulesSignal: true, bar }), 'entry');
  assert.equal(triggerFor({ thesis: { stance: 'candidate', entryCondition: { type: 'rulesSignal' } }, position: null, rulesSignal: false, bar }), null);
  assert.equal(triggerFor({ thesis: { stance: 'watch', entryCondition: { type: 'rulesSignal' } }, position: null, rulesSignal: true, bar }), null);
  assert.equal(triggerFor({ thesis: { stance: 'candidate', entryCondition: { type: 'priceAbove', level: 100.5 } }, position: null, bar }), 'entry');
  assert.equal(triggerFor({ thesis: { stance: 'candidate', entryCondition: { type: 'priceBelow', level: 100.5 } }, position: null, bar }), null);
  assert.equal(triggerFor({ thesis: null, position: null, rulesSignal: true, bar }), null);
  assert.equal(triggerFor({ thesis: th, position, bar: { low: 99 }, newEvidenceSince: true }), 'invalidation');
  assert.equal(triggerFor({ thesis: th, position, bar: { low: 101 }, newEvidenceSince: true }), 'new-evidence');
  assert.equal(triggerFor({ thesis: th, position, bar: { low: 101 }, newEvidenceSince: false, lastDecisionDay: '2026-10-14', day: '2026-10-16' }), 'stale-review');
  assert.equal(triggerFor({ thesis: th, position, bar: { low: 101 }, newEvidenceSince: false, lastDecisionDay: '2026-10-15', day: '2026-10-16' }), null);
  assert.equal(triggerFor({ thesis: th, position, bar: { low: 101 }, newEvidenceSince: false, lastDecisionDay: '2026-10-16', day: '2026-10-21' }), 'stale-review'); // 19 and 21; 20 is a holiday
  assert.equal(triggerFor({ thesis: th, position, bar: { low: 99 }, newEvidenceSince: true, alreadyFired: new Set(['invalidation']) }), 'new-evidence');
  assert.equal(triggerFor({ thesis: { stance: 'candidate', entryCondition: { type: 'rulesSignal' } }, position: null, rulesSignal: true, bar, alreadyFired: new Set(['entry']) }), null);
});

test('decider makes no call without a trigger', async t => {
  const { calls, run } = harness(t, { thesis: { ...goodThesis, stance: 'watch' } });
  assert.deepEqual(await run(), { action: 'abstain', reason: 'No trigger', evidence: [], counterEvidence: [], tightenStopTo: null, trigger: null, record: null });
  assert.equal(calls.length, 0);
});

test('decider calls once on an entry trigger, records the output and maps the result', async t => {
  const { store, calls, run } = harness(t);
  const result = await run();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, DEFAULT_SETTINGS.expert.decisionModel); assert.equal(calls[0].maxTurns, 1); assert.equal(calls[0].timeoutMs, 60000);
  assert.equal(calls[0].tools, undefined); assert.equal(typeof calls[0].input, 'string'); assert.match(calls[0].systemPrompt, /abstain/);
  assert.equal(JSON.parse(calls[0].input).trigger, 'entry');
  assert.deepEqual({ ...result, record: undefined }, { action: 'enter', reason: goodDecision.reason, evidence: ['early: claim early'], counterEvidence: ['Weak market'], tightenStopTo: null, confidence: 0.6, trigger: 'entry', record: undefined });
  const key = result.record.key, [engine, symbol, trigger, at, hash] = key.split('|');
  assert.deepEqual([engine, symbol, trigger, at], ['expert', 'DEMO1', 'entry', new Date(asOf).toISOString()]); assert.match(hash, /^[0-9a-f]{16}$/);
  assert.deepEqual(result.record.usage, { inputTokens: 10, outputTokens: 5 }); assert.equal(result.record.costUsd, 0.01); assert.equal(result.record.action, 'enter');
  assert.deepEqual(store.modelOutput(key).response, goodDecision); assert.equal(store.modelOutput(key).request.contextPack.symbol, 'DEMO1');
  assert.equal(store.callCount(), 1); assert.equal(store.db.prepare('SELECT status FROM model_calls').get().status, 'completed');
  assert.deepEqual(await run(), result); assert.equal(calls.length, 1); // same bar again: served from the record
});

test('entry trigger fires once per session day', async t => {
  const { calls, run, state } = harness(t);
  await run(buyContext(), { ...state, cursor: dataset.length - 2 });
  assert.equal((await run()).trigger, null); assert.equal(calls.length, 1);
});

test('decider serves recorded output in replay and throws REPLAY_MISS otherwise', async t => {
  const live = harness(t), recorded = await live.run();
  const replay = makeDecider({ store: live.store, settings: DEFAULT_SETTINGS, runner: () => assert.fail('runner called in replay'), replay: true });
  assert.deepEqual(await replay({ symbol: 'DEMO1', state: live.state, context: buyContext() }), recorded);
  const empty = harness(t, { replay: true, runner: () => assert.fail('runner called in replay') });
  await assert.rejects(empty.run(), error => error.code === 'REPLAY_MISS');
  assert.equal(empty.store.callCount(), 0);
});

test('decider suppresses calls until limitUntil after MODEL_LIMIT', async t => {
  let calls = 0, now = Date.parse('2026-10-14T10:05:00Z');
  const resetAt = '2026-10-14T11:05:00.000Z';
  const runner = async () => { calls++; throw Object.assign(new Error('limit'), { code: 'MODEL_LIMIT', resetAt }); };
  const h = harness(t, { runner, now: () => now });
  await assert.rejects(h.run(), new RegExp(`^Error: subscription limit until ${resetAt}$`));
  assert.equal(h.decider.limitUntil, Date.parse(resetAt)); assert.equal(h.store.db.prepare('SELECT status FROM model_calls').get().status, 'failed');
  await assert.rejects(h.run(buyContext(), { ...h.state, cursor: dataset.length - 2 }), /subscription limit until/);
  assert.equal(calls, 1); assert.equal(h.store.lastDecision('DEMO1'), null);
  now = Date.parse(resetAt) + 1;
  await assert.rejects(h.run(), /subscription limit until/); assert.equal(calls, 1); // this bar's suppression is recorded
  await assert.rejects(h.run(buyContext(), { ...h.state, cursor: dataset.length - 3 }), /subscription limit until/); assert.equal(calls, 2);
  const unknown = harness(t, { runner: async () => { throw Object.assign(new Error('limit'), { code: 'MODEL_LIMIT', resetAt: null }); } });
  await assert.rejects(unknown.run(), /subscription limit until 2026-10-14T11:05:00.000Z/); // null reset waits 60 minutes
});

test('decider suppresses at the daily call cap, on oversize packs and on invalid output', async t => {
  const capped = harness(t, { settings: { ...DEFAULT_SETTINGS, model: { ...DEFAULT_SETTINGS.model, dailyCallLimit: 0 } } });
  await assert.rejects(capped.run(), /^Error: Daily AI call limit reached$/); assert.equal(capped.calls.length, 0);
  const huge = harness(t, { thesis: { ...goodThesis, evidenceIds: [], thesis: 'x'.repeat(70000) } });
  await assert.rejects(huge.run(), /^Error: Context pack too large$/); assert.equal(huge.calls.length, 0);
  const bad = harness(t, { value: { ...goodDecision, evidenceIds: ['invented'] } });
  await assert.rejects(bad.run(), /evidence/);
  assert.equal(bad.store.db.prepare('SELECT status FROM model_calls').get().status, 'failed'); assert.equal(bad.store.lastDecision('DEMO1'), null);
});

test('expired thesis blocks entry', async t => {
  const { calls, run } = harness(t, { thesis: { ...goodThesis, evidenceIds: [], expiresAt: '2026-10-14T09:00:00Z' } });
  assert.equal((await run()).trigger, null); assert.equal(calls.length, 0);
});

test('held position: decider works on frozen state, passes tightenStopTo and detects new evidence', async t => {
  const hold = { ...goodDecision, action: 'hold', tightenStopTo: 98, invalidation: { priceBelow: 92, note: 'raised' } };
  const h = harness(t, { value: hold, positions: [position] });
  const frozen = deepFreeze(structuredClone(h.state)), context = deepFreeze(buyContext());
  const first = await h.decider({ symbol: 'DEMO1', state: frozen, context });
  assert.equal(first.trigger, 'stale-review'); assert.equal(first.action, 'hold'); assert.equal(first.tightenStopTo, 98);
  const later = { ...h.state, cursor: dataset.length - 1 }, earlier = { ...h.state, cursor: dataset.length - 3 };
  const fresh = harness(t, { value: hold, positions: [position] });
  await fresh.run(buyContext(), earlier); // stale-review at 15:00
  assert.equal((await fresh.run(buyContext(), later)).trigger, null); // nothing new since
  const news = [claim('early', '2026-10-14T03:00:00Z'), claim('late', '2026-10-14T09:45:00Z')];
  assert.equal((await fresh.run(buyContext(news), later)).trigger, 'new-evidence');
  const entryOnly = harness(t, { value: { ...goodDecision, tightenStopTo: 98 } });
  assert.equal((await entryOnly.run()).tightenStopTo, null);
});

test('runTheses skips symbols with a stored thesis and stores invalid output as watch', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.saveThesis('DEMO2', day, { stance: 'avoid', createdAt: '2026-10-14T03:00:00.000Z' });
  const calls = [], thesisAsOf = '2026-10-14T03:15:00.000Z';
  const runner = async args => { calls.push(args); return { value: { ...goodThesis, evidenceIds: [], expiresAt: '2026-11-30T10:00:00Z' }, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 }; };
  const args = { store, settings: DEFAULT_SETTINGS, symbols: ['DEMO1', 'DEMO2'], day, asOf: thesisAsOf, runner, intelligenceFor: () => ({ claims: [] }), dailyFor: () => ({}), state: fixture.state };
  await runTheses(args);
  assert.equal(calls.length, 1); assert.equal(calls[0].model, DEFAULT_SETTINGS.expert.thesisModel); assert.equal(calls[0].maxTurns, 1);
  const stored = store.thesis('DEMO1', day);
  assert.equal(stored.stance, 'watch'); assert.match(stored.invalid, /expires/); assert.equal(stored.createdAt, thesisAsOf);
  assert.equal(store.thesis('DEMO2', day).stance, 'avoid'); assert.equal(store.db.prepare('SELECT status FROM model_calls').get().status, 'failed');
});

test('runTheses records valid theses with createdAt and replays them', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const thesisAsOf = '2026-10-14T03:15:00.000Z', value = { ...goodThesis, evidenceIds: ['early'] };
  const intelligenceFor = (symbol, at) => ({ claims: [claim('early', '2026-10-14T03:00:00Z')] });
  const args = { store, settings: DEFAULT_SETTINGS, symbols: ['DEMO1'], day, asOf: thesisAsOf, intelligenceFor, dailyFor: () => ({}), state: fixture.state };
  await runTheses({ ...args, runner: async () => ({ value, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 }) });
  assert.deepEqual(store.thesis('DEMO1', day), { ...value, createdAt: thesisAsOf });
  const key = store.db.prepare('SELECT key FROM model_outputs').get().key;
  assert.match(key, /^expert\|DEMO1\|thesis\|2026-10-14T03:15:00.000Z\|[0-9a-f]{16}$/);
  store.db.exec('DELETE FROM expert_thesis');
  await runTheses({ ...args, replay: true, runner: () => assert.fail('runner called in replay') });
  assert.deepEqual(store.thesis('DEMO1', day), { ...value, createdAt: thesisAsOf });
  await assert.rejects(runTheses({ ...args, symbols: ['DEMO2'], replay: true, runner: () => assert.fail('runner called in replay') }), error => error.code === 'REPLAY_MISS');
});

test('runTheses stops the pass at a subscription limit and suppresses at the call cap and on oversize packs', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let calls = 0; const thesisAsOf = '2026-10-14T03:15:00.000Z';
  const base = { store, settings: DEFAULT_SETTINGS, day, asOf: thesisAsOf, intelligenceFor: () => ({ claims: [] }), dailyFor: () => ({}), state: fixture.state };
  await runTheses({ ...base, symbols: ['DEMO1', 'DEMO2'], runner: async () => { calls++; throw Object.assign(new Error('limit'), { code: 'MODEL_LIMIT', resetAt: null }); } });
  assert.equal(calls, 1);
  for (const symbol of ['DEMO1', 'DEMO2']) assert.deepEqual(store.thesis(symbol, day), { stance: 'watch', invalid: 'subscription limit', createdAt: thesisAsOf });
  const capped = { ...DEFAULT_SETTINGS, model: { ...DEFAULT_SETTINGS.model, dailyCallLimit: 0 } };
  await runTheses({ ...base, settings: capped, symbols: ['DEMO3'], runner: () => assert.fail('runner called at the cap') });
  assert.deepEqual(store.thesis('DEMO3', day), { stance: 'watch', invalid: 'Daily AI call limit reached', createdAt: thesisAsOf });
  await runTheses({ ...base, symbols: ['DEMO4'], intelligenceFor: () => ({ claims: [claim('big', '2026-10-14T03:00:00Z')].map(c => ({ ...c, content: 'x'.repeat(70000) })) }), runner: () => assert.fail('runner called on an oversize pack') });
  assert.deepEqual(store.thesis('DEMO4', day), { stance: 'watch', invalid: 'Context pack too large', createdAt: thesisAsOf });
});

test('I3: theses and decisions can cite a MARKET calendar record', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const seen = [], value = { ...goodThesis, evidenceIds: [rbi.id] };
  const runner = async args => { seen.push(JSON.parse(args.input).contextPack); return { value, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 }; };
  const intelligenceFor = (symbol, at) => intelligenceContext({ records: [rbi], symbol, asOf: at });
  await runTheses({ store, settings: DEFAULT_SETTINGS, symbols: ['DEMO1'], day, asOf: '2026-10-14T03:15:00.000Z', runner, intelligenceFor, dailyFor: () => ({}), state: fixture.state });
  assert.deepEqual(seen[0].calendar.events.map(c => c.recordId), [rbi.id]);
  assert.deepEqual(store.thesis('DEMO1', day), { ...value, createdAt: '2026-10-14T03:15:00.000Z' });
  const decisions = [];
  const decider = makeDecider({ store, settings: DEFAULT_SETTINGS, dailyFor: () => ({}), marketFor: at => intelligenceContext({ records: [rbi], symbol: 'MARKET', asOf: at }),
    runner: async args => { decisions.push(args); return { value: { ...goodDecision, evidenceIds: [rbi.id] }, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 }; } });
  const result = await decider({ symbol: 'DEMO1', state: fixture.state, context: buyContext([]) });
  assert.equal(decisions.length, 1); assert.equal(result.action, 'enter'); assert.deepEqual(result.evidence, [`${rbi.id}: ${rbi.content}`]);
});

// Bar index for an IST time on 14 Oct in the 15-minute fixture (bar ending 09:30 is index 25).
const at = hhmm => 25 + (Date.parse(`2026-10-14T${hhmm}:00+05:30`) - Date.parse('2026-10-14T09:30:00+05:30')) / 900_000;

test('a deduped invalidation still lets new evidence through on a held position', async t => {
  const hold = { ...goodDecision, action: 'hold', invalidation: { priceBelow: 115, note: 'unchanged' } };
  const h = harness(t, { value: hold, positions: [position], thesis: { ...goodThesis, evidenceIds: [], invalidation: { priceBelow: 115, note: 'every bar touches' }, createdAt: '2026-10-14T03:15:00.000Z' } });
  const bar = hhmm => ({ ...h.state, cursor: at(hhmm) });
  assert.equal((await h.run(buyContext(), bar('10:00'))).trigger, 'invalidation');
  assert.equal((await h.run(buyContext(), bar('10:30'))).trigger, null); // still below, already reviewed today
  const news = [claim('early', '2026-10-14T03:00:00Z'), claim('late', '2026-10-14T05:15:00Z')]; // ready 10:45 IST
  assert.equal((await h.run(buyContext(news), bar('11:00'))).trigger, 'new-evidence');
  assert.equal((await h.run(buyContext(news), bar('11:15'))).trigger, null); assert.equal(h.calls.length, 2);
});

test('a thesis created after asOf drives no trigger', async t => {
  const h = harness(t, { thesis: { ...goodThesis, evidenceIds: [], createdAt: '2026-10-14T05:30:00.000Z' } }); // 11:00 IST
  assert.equal((await h.run(buyContext(), { ...h.state, cursor: at('09:45') })).trigger, null);
  assert.equal((await h.run(buyContext(), { ...h.state, cursor: at('11:00') })).trigger, 'entry'); assert.equal(h.calls.length, 1);
});

test('a live day with a timeout replays identically with no runner calls', async t => {
  let calls = 0;
  const runner = async () => { if (calls++ === 0) throw Object.assign(new Error('claude -p timed out.'), { code: 'MODEL_TIMEOUT' }); return { value: goodDecision, usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.01 }; };
  const h = harness(t, { runner });
  const outcome = promise => promise.then(value => ({ value }), error => ({ error: String(error) }));
  const bars = [at('15:00'), at('15:15'), at('15:30')];
  const live = [];
  for (const cursor of bars) live.push(await outcome(h.run(buyContext(), { ...h.state, cursor })));
  assert.deepEqual(live.map(r => r.error ?? r.value.trigger), ['Error: claude -p timed out.', 'entry', null]); assert.equal(calls, 2);
  const replay = makeDecider({ store: h.store, settings: DEFAULT_SETTINGS, runner: () => assert.fail('runner called in replay'), replay: true });
  const replayed = [];
  for (const cursor of bars) replayed.push(await outcome(replay({ symbol: 'DEMO1', state: { ...h.state, cursor }, context: buyContext() })));
  assert.deepEqual(replayed, live); assert.equal(calls, 2);
});

test('thesis placeholders replay identically', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const base = { store, settings: DEFAULT_SETTINGS, day, asOf: '2026-10-14T03:15:00.000Z', symbols: ['DEMO1', 'DEMO2', 'DEMO3'], intelligenceFor: () => ({ claims: [] }), dailyFor: () => ({}), state: fixture.state };
  let calls = 0;
  await runTheses({ ...base, runner: async () => { calls++; throw Object.assign(new Error(calls === 1 ? 'claude -p timed out.' : 'limit'), { code: calls === 1 ? 'MODEL_TIMEOUT' : 'MODEL_LIMIT', resetAt: null }); } });
  const live = store.thesesFor(day);
  assert.deepEqual(Object.values(live).map(th => th.invalid), ['claude -p timed out.', 'subscription limit', 'subscription limit']); assert.equal(calls, 2);
  store.db.exec('DELETE FROM expert_thesis');
  await runTheses({ ...base, replay: true, runner: () => assert.fail('runner called in replay') });
  assert.deepEqual(store.thesesFor(day), live);
});

// ---- Task 7: scoring, review memory, scorecard ----

const sbars = [[100, 101, 99, 100], [100, 103, 99, 102], [102, 102, 98, 99], [99, 100, 96, 97], [97, 99, 97, 98], [98, 99, 97, 98.5]];
const sdata = sbars.map(([open, high, low, close], i) => ({ timestamp: new Date(Date.parse('2026-10-14T09:15:00+05:30') + (i + 1) * 900_000).toISOString(), bars: { DEMO1: { open, high, low, close } } }));
const sdecision = (over = {}) => ({ id: 'd1', symbol: 'DEMO1', trigger: 'entry', timestamp: sdata[0].timestamp, executionTimestamp: sdata[1].timestamp, action: 'BUY', outcome: 'Paper buy filled',
  expert: { action: 'enter', reason: 'because', invalidation: { priceBelow: 97 } }, ...over });
const strade = (action, realizedPnl, i) => ({ symbol: 'DEMO1', action, timestamp: sdata[i].timestamp, realizedPnl, strategyId: 's' });
const sthesis = (over = {}) => ({ stance: 'candidate', invalidation: { priceBelow: 97, note: '' }, expectedHoldSessions: 1, ...over });

test('scoreDecisions: invalidation hit, mfe/mae, rules window, thesis states', () => {
  const expertState = { dataset: sdata, decisions: [sdecision(), sdecision({ id: 'skip', trigger: null })], trades: [strade('BUY', 0, 1), strade('SELL', -3, 3)] };
  const rulesState = { trades: [strade('BUY', 0, 2), strade('SELL', 1.2, 4)] };
  const [score, ...rest] = scoreDecisions({ expertState, rulesState, day: '2026-10-14', thesisFor: () => sthesis() });
  assert.equal(rest.length, 0);
  assert.deepEqual(score, { decisionId: 'd1', symbol: 'DEMO1', trigger: 'entry', action: 'enter', reason: 'because', invalidationHit: true, mfe: 3, mae: -4, realised: -3,
    rulesSameWindow: { entered: true, realised: 1.2 }, thesisScore: 'invalidated' });
  const rising = sdata.map((r, i) => i === 5 ? { ...r, bars: { DEMO1: { ...r.bars.DEMO1, close: 101 } } } : r);
  const calm = scoreDecisions({ expertState: { ...expertState, dataset: rising, trades: [] }, rulesState: { trades: [] }, day: '2026-10-14', thesisFor: () => sthesis({ invalidation: { priceBelow: 90 } }) })[0];
  assert.equal(calm.invalidationHit, false); assert.equal(calm.thesisScore, 'held'); assert.deepEqual(calm.rulesSameWindow, { entered: false, realised: 0 });
  const longer = scoreDecisions({ expertState, rulesState, day: '2026-10-14', thesisFor: () => sthesis({ invalidation: { priceBelow: 90 }, expectedHoldSessions: 3 }) })[0];
  assert.equal(longer.thesisScore, 'open');
  const down = scoreDecisions({ expertState, rulesState, day: '2026-10-14', thesisFor: () => sthesis({ invalidation: { priceBelow: 90 } }) })[0];
  assert.equal(down.thesisScore, 'expired');
});

test('scoreDecisions: abstention is scored against what rules did', () => {
  const expertState = { dataset: sdata, decisions: [sdecision({ action: 'HOLD', expert: { action: 'abstain', reason: 'thin', invalidation: { priceBelow: 90 } } })], trades: [] };
  const rulesState = { trades: [strade('BUY', 0, 1), strade('SELL', -2, 3), { ...strade('SELL', 9, 3), symbol: 'OTHER' }] };
  const [score] = scoreDecisions({ expertState, rulesState, day: '2026-10-14' });
  assert.equal(score.action, 'abstain'); assert.deepEqual(score.rulesSameWindow, { entered: true, realised: -2 }); assert.equal(score.realised, 0);
});

const scoreRow = (symbol, over = {}) => ({ decisionId: `d-${symbol}`, symbol, trigger: 'entry', action: 'enter', reason: 'r', invalidationHit: false, mfe: 1, mae: -1, realised: 5, rulesSameWindow: { entered: false, realised: 0 }, thesisScore: 'held', ...over });
const reviewValue = { lesson: 'Wait for confirmation.', decisionQuality: 'good', note: 'ok' };
const rtrade = (symbol, action, i, realizedPnl = 0) => ({ id: `${symbol}-${action}-${i}`, symbol, action, timestamp: sdata[i].timestamp, realizedPnl });
const closedState = (...symbols) => ({ decisions: [], trades: symbols.flatMap(symbol => [rtrade(symbol, 'BUY', 1), rtrade(symbol, 'SELL', 3, -3)]) });
const okRunner = calls => async args => { calls.push(args); return { value: reviewValue, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0.02 }; };

test('reviewClosed writes one memory per closed position and memoryFor hides it before its timestamp', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const calls = [], runner = okRunner(calls), score = scoreRow('DEMO1', { decisionId: 'd1' });
  const expertState = { decisions: [sdecision(), sdecision({ id: 'other', symbol: 'DEMO2', executionTimestamp: sdata[2].timestamp })],
    trades: [...closedState('DEMO1', 'DEMO2').trades, rtrade('DEMO3', 'BUY', 2)] }; // DEMO3 is still open
  assert.equal(await reviewClosed({ store, settings: DEFAULT_SETTINGS, day, scores: [score], expertState, runner }), 2);
  assert.equal(calls.length, 2); assert.equal(calls[0].model, DEFAULT_SETTINGS.expert.researchModel); assert.equal(calls[0].maxTurns, 1);
  const input = JSON.parse(calls[0].input);
  assert.equal(input.symbol, 'DEMO1'); assert.equal(input.realised, -3); assert.equal(input.decisions.length, 1); assert.deepEqual(input.decisions[0].score, score); assert.equal(input.decisions[0].reason, 'because');
  assert.equal(JSON.parse(calls[1].input).decisions[0].score, null);
  const closeIso = '2026-10-14T10:00:00.000Z';
  assert.equal(store.memoryFor('DEMO1', '2026-10-14T09:59:59Z').length, 0);
  const [memory] = store.memoryFor('DEMO1', closeIso);
  assert.equal(memory.lesson, reviewValue.lesson); assert.equal(memory.reviewedAt, closeIso);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM model_outputs WHERE trigger='review'").get().n, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM model_calls").get().n, 2);
  // Running it again serves the recorded outputs: no calls and no duplicate memory.
  assert.equal(await reviewClosed({ store, settings: DEFAULT_SETTINGS, day, scores: [score], expertState, runner }), 0);
  assert.equal(calls.length, 2); assert.equal(store.memoryFor('DEMO1', closeIso).length, 1);
});

test('two closes of one symbol on one day get two reviews with distinct replay keys', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const calls = [], expertState = { decisions: [], trades: [rtrade('DEMO1', 'BUY', 0), rtrade('DEMO1', 'SELL', 1, 2), rtrade('DEMO1', 'BUY', 2), rtrade('DEMO1', 'SELL', 3, -1)] };
  assert.equal(await reviewClosed({ store, settings: DEFAULT_SETTINGS, day, scores: [], expertState, runner: okRunner(calls) }), 2);
  assert.equal(calls.length, 2); assert.equal(store.memoryFor('DEMO1', '2026-10-14T10:00:00Z').length, 2);
  assert.equal(store.db.prepare("SELECT COUNT(DISTINCT key) AS n FROM model_outputs WHERE trigger='review'").get().n, 2);
  assert.deepEqual(calls.map(c => JSON.parse(c.input).realised), [2, -1]);
  const again = [];
  assert.equal(await reviewClosed({ store, settings: DEFAULT_SETTINGS, day, scores: [], expertState, runner: okRunner(again), replay: true }), 0);
  assert.equal(again.length, 0);
});

test('reviewClosed failures are suppressed, logged and not stored; replay misses abort', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const logs = [], log = message => logs.push(message);
  const bad = async () => ({ value: { lesson: 'x', decisionQuality: 'great', note: '' }, usage: {}, costUsd: 0 });
  assert.equal(await reviewClosed({ store, settings: DEFAULT_SETTINGS, day, scores: [], expertState: closedState('DEMO1'), runner: bad, log }), 0);
  assert.equal(logs.length, 1); assert.match(logs[0], /DEMO1/); assert.equal(store.memoryFor('DEMO1', '2026-10-15T00:00:00Z').length, 0);
  assert.equal(await reviewClosed({ store, settings: DEFAULT_SETTINGS, day, scores: [], expertState: closedState('DEMO2'), runner: async () => { throw new Error('boom'); }, log }), 0);
  const empty = new Store(':memory:'); t.after(() => empty.close());
  await assert.rejects(reviewClosed({ store: empty, settings: DEFAULT_SETTINGS, day, scores: [], expertState: closedState('DEMO1'), runner: bad, replay: true, log }), { code: 'REPLAY_MISS' });
  const capped = { ...DEFAULT_SETTINGS, model: { ...DEFAULT_SETTINGS.model, dailyCallLimit: 0 } };
  assert.equal(await reviewClosed({ store, settings: capped, day, scores: [], expertState: closedState('DEMO3'), runner: bad, log }), 0);
  assert.match(logs.at(-1), /Daily AI call limit/);
});

// Three sessions (14, 15, 16 Oct 2026), two bars each: 09:30 and 15:30 IST.
const mdata = ['2026-10-14', '2026-10-15', '2026-10-16'].flatMap((d, i) => [['09:30', [100 + i, 101 + i, 99 + i, 100 + i]], ['15:30', [100 + i, 103 + i, 98 + i * 2, 101 + i]]]
  .map(([time, [open, high, low, close]]) => ({ timestamp: new Date(`${d}T${time}:00+05:30`).toISOString(), bars: { DEMO1: { open, high, low, close } } })));
const mdecision = { id: 'm1', symbol: 'DEMO1', trigger: 'entry', timestamp: mdata[0].timestamp, executionTimestamp: mdata[1].timestamp, action: 'BUY', expert: { action: 'enter', reason: 'multi', invalidation: { priceBelow: 90 } } };
const mscore = day => scoreDecisions({ expertState: { dataset: mdata, decisions: [mdecision], trades: [] }, rulesState: { trades: [] }, day, thesisFor: () => sthesis({ invalidation: { priceBelow: 90 }, expectedHoldSessions: 3 }) });

test('a 3-session decision stays open after day 1 and resolves on day 3 over its full window', () => {
  const [d1] = mscore('2026-10-14'), [d2] = mscore('2026-10-15'), [d3] = mscore('2026-10-16');
  assert.equal(d1.thesisScore, 'open'); assert.equal(d2.thesisScore, 'open');
  assert.equal(d1.mfe, 3); assert.equal(d1.mae, -2); // day 1 only: reference 100, high 103, low 98
  assert.equal(d3.thesisScore, 'held'); assert.equal(d3.mfe, 5); assert.equal(d3.mae, -2); // reference 100; day 3 high 105; day 3 low 102, day 1 low 98
  assert.deepEqual(mscore('2026-10-17'), []); // 17 Oct is a Saturday and the window ended on the 16th: nothing left to score
});

test('a position entered on day 1 and stopped out on day 2 with no day-2 decision gets exactly one review on day 2', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const expertState = { dataset: mdata, decisions: [mdecision], trades: [{ ...rtrade('DEMO1', 'BUY', 0), timestamp: mdata[1].timestamp }, { ...rtrade('DEMO1', 'SELL', 0, -2), timestamp: mdata[2].timestamp }] };
  const thesisFor = () => sthesis({ invalidation: { priceBelow: 90 }, expectedHoldSessions: 3 }), calls = [];
  const args = day => ({ store, settings: DEFAULT_SETTINGS, day, expertState, runner: okRunner(calls),
    scores: scoreDecisions({ expertState, rulesState: { trades: [] }, day, thesisFor }) });
  assert.equal(await reviewClosed(args('2026-10-14')), 0);
  const day2 = args('2026-10-15');
  assert.equal(day2.scores.length, 1); // the day-1 decision is still being scored on day 2, and no day-2 decision exists
  assert.equal(await reviewClosed(day2), 1);
  assert.equal(calls.length, 1); assert.equal(JSON.parse(calls[0].input).decisions[0].score.decisionId, 'm1');
  assert.equal(store.memoryFor('DEMO1', '2026-10-15T10:00:00Z').length, 1);
});

const srow = (n, { rules = {}, expert = {}, flagged = false, scores = [], suppressions = [], coverage = 3, cost = 0.5 } = {}) => ({
  day: `2026-11-${String(n).padStart(2, '0')}`,
  rules: { netAfterFixedCosts: 10 * n, equity: 1000 + 10 * n, benchmarkEquity: 1000 + 5 * n, dataQuality: { flagged }, ...rules },
  expert: { netAfterFixedCosts: 20 * n, ...expert, expert: { scores, suppressions, coverage, universe: 3, costUsd: cost } },
});

test('scorecard computes exit bar', () => {
  const rows = Array.from({ length: 40 }, (_, i) => srow(i + 1, { scores: i === 0 ? [scoreRow('A'), scoreRow('B', { thesisScore: 'invalidated' }), scoreRow('C', { thesisScore: 'open' }),
    scoreRow('D', { action: 'abstain', thesisScore: 'expired', rulesSameWindow: { entered: true, realised: -2 } })] : [], suppressions: i < 2 ? [{ symbol: 'A', cause: 'x' }] : [], coverage: i === 3 ? 2 : 3 }));
  const card = scorecard({ reports: rows });
  assert.equal(card.sessions, 40); assert.equal(card.expertNet, 800); assert.equal(card.rulesNet, 400); assert.equal(card.buyHoldNet, 400 - 200);
  assert.equal(card.exitBarMet, true); assert.equal(card.thesisAccuracy, 1 / 3); assert.equal(card.unresolvedTheses, 1); assert.equal(card.abstentionValue, -2);
  assert.equal(card.suppressedCalls, 2); assert.equal(card.missingCoverageSessions, 1); assert.equal(card.modelCostUsdEstimate, 20);
  assert.equal(scorecard({ reports: rows.slice(0, 39) }).exitBarMet, false);
  const behind = rows.map(r => ({ ...r, expert: { ...r.expert, netAfterFixedCosts: 5 * Number(r.day.slice(-2)) } }));
  assert.equal(scorecard({ reports: behind }).exitBarMet, false);
});

test('scorecard excludes flagged sessions by increments and handles no data', () => {
  const rows = [srow(1), srow(2, { flagged: true }), srow(3)];
  const card = scorecard({ reports: rows });
  assert.equal(card.sessions, 2); assert.equal(card.expertNet, 20 + 20); assert.equal(card.rulesNet, 10 + 10);
  assert.deepEqual(scorecard({ reports: [] }), { sessions: 0, expertNet: 0, rulesNet: 0, buyHoldNet: 0, thesisAccuracy: null, unresolvedTheses: 0, abstentionValue: 0, suppressedCalls: 0, missingCoverageSessions: 0, modelCostUsdEstimate: 0, exitBarMet: false });
});

test('scorecard measures rules and buy-and-hold from the rules report before the first paired session', () => {
  const leading = [1, 2].map(n => ({ day: `2026-10-0${n}`, rules: { netAfterFixedCosts: -5000, equity: 5000, benchmarkEquity: 5000, dataQuality: { flagged: false } }, expert: null }));
  const paired = [1, 2].map(n => ({ day: `2026-10-1${n}`, rules: { netAfterFixedCosts: -5000 + 10 * n, equity: 5000 + 10 * n, benchmarkEquity: 5000 + 5 * n, dataQuality: { flagged: false } },
    expert: { netAfterFixedCosts: 20 * n, expert: { scores: [], suppressions: [], coverage: 3, universe: 3, costUsd: 0 } } }));
  const card = scorecard({ reports: [...leading, ...paired] });
  assert.equal(card.sessions, 2); assert.equal(card.rulesNet, 20); assert.equal(card.buyHoldNet, 10); assert.equal(card.expertNet, 40);
});

test('scorecard counts a decision scored on several days once, by its latest score', () => {
  const x = over => scoreRow('X', { action: 'abstain', ...over });
  const rows = [srow(1, { scores: [x({ thesisScore: 'open', rulesSameWindow: { entered: true, realised: 1 } })] }),
    srow(2, { scores: [x({ thesisScore: 'open', rulesSameWindow: { entered: true, realised: 3 } }), scoreRow('Y', { thesisScore: 'open' })] }),
    srow(3, { scores: [x({ thesisScore: 'held', rulesSameWindow: { entered: true, realised: 4 } })] })];
  const card = scorecard({ reports: rows });
  assert.equal(card.thesisAccuracy, 1); assert.equal(card.unresolvedTheses, 1); assert.equal(card.abstentionValue, 4);
});

test('makeScoring scores, reviews and writes the expert report with extras', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.saveThesis('DEMO1', day, { ...sthesis(), createdAt: '2026-10-14T03:15:00.000Z' });
  store.saveModelOutput({ key: 'k1', engine: 'expert', symbol: 'DEMO1', trigger: 'entry', asOf: sdata[0].timestamp, promptHash: 'h', request: {}, response: {}, costUsd: 0.25, createdAt: '2026-10-14T05:00:00.000Z' });
  const reports = [];
  const expertEngine = { store, state: { dataset: sdata, trades: [strade('BUY', 0, 1), strade('SELL', -3, 3)], assets: [{ symbol: 'DEMO1' }, { symbol: 'DEMO2' }], settings: DEFAULT_SETTINGS,
    intelligenceRecords: [{ symbol: 'DEMO1', firstReceivedAt: '2026-10-14T02:00:00Z' }, { symbol: 'DEMO2', firstReceivedAt: '2026-10-13T02:00:00Z' }],
    decisions: [sdecision(), sdecision({ id: 's1', trigger: null, symbol: 'DEMO2', outcome: 'Suppressed: Daily AI call limit reached' })] },
    dailyReport: (d, q, extra) => { reports.push({ d, q, extra }); return extra; } };
  const scoring = makeScoring({ expertEngine, rulesEngine: { state: { trades: [] } }, runner: async () => ({ value: reviewValue, usage: {}, costUsd: 0.1 }) });
  const out = await scoring(day, { flagged: false });
  assert.equal(reports.length, 1); assert.deepEqual(reports[0].q, { flagged: false }); assert.equal(out, reports[0].extra);
  const { scores, theses, calls, costUsd, coverage, universe, suppressions } = out.expert;
  assert.equal(scores.length, 1); assert.equal(theses.DEMO1.stance, 'candidate');
  // The review row is stamped with wall-clock time, so only the entry row (stamped on `day`) is counted here.
  assert.deepEqual(calls.byTrigger, { entry: 1 }); assert.equal(calls.count, 1); assert.equal(costUsd, 0.25);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM model_outputs WHERE trigger='review'").get().n, 1);
  assert.equal(coverage, 1); assert.equal(universe, 2); assert.deepEqual(suppressions.map(s => [s.symbol, s.cause]), [['DEMO2', 'Daily AI call limit reached']]);
  assert.equal(store.memoryFor('DEMO1', '2026-10-14T10:00:00Z').length, 1);
});

test('validateDecision requires a confidence between 0 and 1', () => {
  const opts = { evidenceIds: ['early'], position: null, thesis: null };
  assert.equal(validateDecision(goodDecision, opts).confidence, 0.6);
  for (const confidence of [1.2, -0.1, NaN]) assert.throws(() => validateDecision({ ...goodDecision, confidence }, opts), /confidence/);
  const { confidence: _c, ...missing } = goodDecision;
  assert.throws(() => validateDecision(missing, opts), /confidence/);
});
test('calibration buckets closed expert trades by entry confidence', () => {
  const trades = [
    { action: 'SELL', strategyId: 'expert', confidence: 0.2, realizedPnl: -100 },
    { action: 'SELL', strategyId: 'expert', confidence: 0.8, realizedPnl: 300 },
    { action: 'SELL', strategyId: 'expert', confidence: 0.9, realizedPnl: -50 },
    { action: 'SELL', strategyId: 'expert', confidence: null, realizedPnl: 10 },
    { action: 'BUY', strategyId: 'expert', confidence: 0.9, realizedPnl: 0 },
  ];
  assert.deepEqual(calibration(trades), [
    { bucket: 'low (<0.4)', trades: 1, wins: 0, winRate: 0, avgPnl: -100 },
    { bucket: 'medium (0.4-0.7)', trades: 0, wins: 0, winRate: null, avgPnl: null },
    { bucket: 'high (>=0.7)', trades: 2, wins: 1, winRate: 0.5, avgPnl: 125 },
  ]);
});
