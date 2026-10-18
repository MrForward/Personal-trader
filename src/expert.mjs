import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeMarket } from './strategies.mjs';
import { HOLIDAYS_2026, sessionFor } from './calendar.mjs';
import { runClaudeCode, schemaErrors } from './models.mjs';
import { redact } from './secrets.mjs';

// shortcut: hand-maintained sector map for the placeholder universe; unmapped symbols simply get no sector series.
export const SECTOR_INDEX = { RELIANCE: 'NIFTY ENERGY', INFY: 'NIFTY IT', HDFCBANK: 'NIFTY BANK', ICICIBANK: 'NIFTY BANK', ITC: 'NIFTY FMCG', SBIN: 'NIFTY BANK', WIPRO: 'NIFTY IT', ONGC: 'NIFTY ENERGY', COALINDIA: 'NIFTY ENERGY', TATASTEEL: 'NIFTY METAL' };

const MAX_PACK_CHARS = 60_000, DAILY_ROWS = 60;
const istDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
const sum = values => values.reduce((total, value) => total + value, 0);

/**
 * Everything the model sees for one symbol at `asOf`. Pure: every series is cut at `asOf` here, whatever the caller passed in.
 * A daily bar is stamped at its session close (15:30 IST), so the day still forming at `asOf` is never visible.
 */
export function buildContextPack({ symbol, asOf, state, daily = {}, intelligence = null, memory = [], thesis = null, callsRemaining = null }) {
  const at = new Date(asOf).getTime();
  if (!Number.isFinite(at)) throw new RangeError('asOf must be a valid time.');
  asOf = new Date(at).toISOString();
  const today = istDay.format(at);
  const known = stamp => Date.parse(stamp) <= at;

  const rows = state.dataset.filter(row => known(row.timestamp) && row.bars[symbol]);
  const history = rows.map(row => ({ timestamp: row.timestamp, ...row.bars[symbol] }));
  const features = analyzeMarket(history);
  const todays = history.filter(bar => istDay.format(Date.parse(bar.timestamp)) === today);

  const series = name => (daily[name] ?? []).filter(bar => known(`${bar.date}T15:30:00+05:30`)).slice(-DAILY_ROWS);
  const closes = name => { const bars = series(name); return bars.length ? bars.map(({ date, close }) => ({ date, close })) : null; };
  const stockDaily = series(symbol);
  const prior = stockDaily.filter(bar => bar.date < today).slice(-20);
  const avgVolume = prior.length === 20 ? sum(prior.map(bar => bar.volume)) / 20 : 0;
  const sectorIndex = SECTOR_INDEX[symbol] ?? null;

  const claims = (intelligence?.claims ?? []).filter(claim => known(claim.analysisReadyAt));
  const holidayLimit = new Date(at + 5.5 * 3_600_000 + 14 * 86_400_000).toISOString().slice(0, 10);

  const pack = {
    version: 1, symbol, asOf,
    price: {
      features,
      todayRangeAtr: todays.length && features.atr > 0 ? (Math.max(...todays.map(bar => bar.high)) - Math.min(...todays.map(bar => bar.low))) / features.atr : null,
      volumeVs20d: todays.length && avgVolume > 0 ? sum(todays.map(bar => bar.volume)) / avgVolume : null,
      daily: stockDaily,
      nifty50: closes('NIFTY 50'),
      sector: { index: sectorIndex, closes: sectorIndex ? closes(sectorIndex) : null },
    },
    evidence: { claims: claims.filter(claim => !claim.sourceKinds?.includes('calendar')), coverage: intelligence?.coverage ?? null, limitations: intelligence?.limitations ?? [] },
    calendar: { events: claims.filter(claim => claim.sourceKinds?.includes('calendar')), holidays: HOLIDAYS_2026.filter(day => day > today && day <= holidayLimit) },
    portfolio: {
      cash: state.cash ?? null, equity: state.metrics?.equity ?? null, exposurePct: state.metrics?.exposurePct ?? null,
      position: structuredClone(state.positions?.find(position => position.symbol === symbol) ?? null),
      thesis: thesis && (!thesis.createdAt || known(thesis.createdAt)) ? thesis : null,
    },
    memory: memory.filter(entry => known(entry.reviewedAt)).sort((a, b) => Date.parse(b.reviewedAt) - Date.parse(a.reviewedAt)).slice(0, 5),
    limits: { ...state.settings.risk, sizingIsDeterministic: true, callsRemaining },
  };
  const size = JSON.stringify(pack).length;
  if (size > MAX_PACK_CHARS) throw new Error(`Context pack is ${size} characters; the limit is ${MAX_PACK_CHARS}.`);
  return pack;
}

// ---- Theses, decisions and triggers (spec §4) ----

const PROMPT_DIR = fileURLToPath(new URL('./prompts', import.meta.url));
const DAY_MS = 86_400_000, LIMIT_FALLBACK_MS = 3_600_000;
const text = maxLength => ({ type: 'string', maxLength });
const textList = { type: 'array', maxItems: 8, items: text(300) };
const invalidation = { type: 'object', additionalProperties: false, required: ['priceBelow', 'note'], properties: { priceBelow: { type: 'number' }, note: text(300) } };
const assessment = text(200);

export const THESIS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['stance', 'thesis', 'mechanism', 'counterEvidence', 'evidenceIds', 'entryCondition', 'invalidation', 'expectedHoldSessions', 'expiresAt', 'eventAssessment'],
  properties: {
    stance: { type: 'string', enum: ['avoid', 'watch', 'candidate'] }, thesis: text(1500), mechanism: text(500), counterEvidence: textList,
    evidenceIds: { type: 'array', items: text(100) },
    entryCondition: { type: 'object', additionalProperties: false, required: ['type'], properties: { type: { type: 'string', enum: ['rulesSignal', 'priceAbove', 'priceBelow'] }, level: { type: 'number' } } },
    invalidation, expectedHoldSessions: { type: 'integer', minimum: 1, maximum: 5 }, expiresAt: text(40),
    eventAssessment: { type: 'object', additionalProperties: false, required: ['novelty', 'materiality', 'surprise', 'reaction'],
      properties: { novelty: assessment, materiality: assessment, surprise: assessment, reaction: assessment } },
  },
};

export const DECISION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['action', 'reason', 'counterEvidence', 'evidenceIds', 'tightenStopTo', 'invalidation'],
  properties: {
    action: { type: 'string', enum: ['enter', 'hold', 'exit', 'abstain'] }, reason: text(1000), counterEvidence: textList,
    evidenceIds: { type: 'array', items: text(100) }, tightenStopTo: { type: ['number', 'null'] }, invalidation,
  },
};

const codeError = (message, code) => Object.assign(new Error(message), { code });
function checkShape(value, schema, kind) {
  const errors = schemaErrors(value, schema);
  if (errors.length) throw new Error(`${kind} output is invalid: ${errors.slice(0, 3).join('; ')}`);
}
function checkEvidence(ids, known, kind) {
  const unknown = ids.filter(id => !known.includes(id));
  if (unknown.length) throw new Error(`${kind} cites unknown evidence: ${unknown.slice(0, 3).join(', ')}`);
}
// Sessions strictly after `fromDay` up to and including `toDay` (IST dates).
function sessionsAfter(fromDay, toDay) {
  let count = 0;
  for (let ms = Date.parse(`${fromDay}T12:00:00+05:30`) + DAY_MS; ms <= Date.parse(`${toDay}T12:00:00+05:30`); ms += DAY_MS) if (sessionFor(ms)) count++;
  return count;
}

export function validateThesis(value, { evidenceIds, sessionCloseIso, expectedHoldSessionsMax = 5 }) {
  checkShape(value, THESIS_SCHEMA, 'Thesis');
  checkEvidence(value.evidenceIds, evidenceIds, 'Thesis');
  if (value.invalidation.priceBelow <= 0) throw new Error('Thesis invalidation must be a positive price.');
  if (value.entryCondition.type !== 'rulesSignal' && !(value.entryCondition.level > 0)) throw new Error('Thesis entry level must be a positive price.');
  // Latest allowed expiry: the close of the Nth session after the thesis day.
  let limit = Date.parse(sessionCloseIso);
  for (let left = Math.min(value.expectedHoldSessions, expectedHoldSessionsMax); left > 0;) { limit += DAY_MS; if (sessionFor(limit)) left--; }
  if (!(Date.parse(value.expiresAt) <= limit)) throw new Error(`Thesis expires after ${new Date(limit).toISOString()} or has no valid expiresAt.`);
  return value;
}

export function validateDecision(value, { evidenceIds, position, thesis }) {
  checkShape(value, DECISION_SCHEMA, 'Decision');
  checkEvidence(value.evidenceIds, evidenceIds, 'Decision');
  if (value.tightenStopTo !== null && value.tightenStopTo <= 0) throw new Error('Decision tightenStopTo must be a positive price.');
  if (position && value.invalidation.priceBelow < (thesis?.invalidation?.priceBelow ?? -Infinity)) throw new Error('Decision moves the invalidation down on a held position.');
  return value;
}

/** Spec §4 trigger table, evaluated in order; a condition in `alreadyFired` is skipped so the next one can fire. A held position with no earlier decision counts as stale. */
export function triggerFor({ thesis, position, bar, rulesSignal = false, newEvidenceSince = false, lastDecisionDay = null, day, alreadyFired = new Set() }) {
  if (!position) {
    if (thesis?.stance !== 'candidate' || alreadyFired.has('entry')) return null;
    const { type, level } = thesis.entryCondition ?? {};
    return (type === 'rulesSignal' ? rulesSignal : type === 'priceAbove' ? bar.close > level : type === 'priceBelow' && bar.close < level) ? 'entry' : null;
  }
  if (!alreadyFired.has('invalidation') && bar.low <= thesis?.invalidation?.priceBelow) return 'invalidation';
  if (newEvidenceSince) return 'new-evidence';
  if (!lastDecisionDay || sessionsAfter(lastDecisionDay, day) >= 2) return 'stale-review';
  return null;
}

function loadPrompt(dir, name, schema) {
  const body = readFileSync(join(dir, `${name}.md`), 'utf8');
  return { text: body, hash: createHash('sha256').update(body + JSON.stringify(schema)).digest('hex').slice(0, 16) };
}
function packFor(args) {
  try { return buildContextPack(args); } catch (error) { throw /limit is/.test(error.message) ? new Error('Context pack too large') : error; }
}
const evidenceMap = pack => new Map([...pack.evidence.claims, ...pack.calendar.events].flatMap(c => [c.recordId, ...(c.recordIds ?? [])].map(id => [id, c.content])));

// Reserves a call, runs, validates; the caller records the outcome.
async function callModel({ store, settings, runner, model, prompt, schema, request, validate }) {
  let id;
  try { id = store.reserveCall({ provider: 'claude-code', model, dailyCallLimit: settings.model.dailyCallLimit }); }
  catch (error) { throw error.code === 'DAILY_CALL_LIMIT' ? new Error('Daily AI call limit reached') : error; }
  let out, value;
  try { out = await runner({ model, systemPrompt: prompt.text, input: JSON.stringify(request), schema, maxTurns: 1, timeoutMs: 60000 }); }
  catch (error) { store.finishCall(id, 'failed'); throw error; }
  try { value = validate(out.value); } catch (error) { store.finishCall(id, 'failed', out.usage); throw error; }
  store.finishCall(id, 'completed', out.usage);
  return { value, usage: out.usage, costUsd: out.costUsd, request: { model, ...request } };
}

// Replays the recorded outcome for `row.key` (an output, or a suppression rethrown with its message); live, runs `live` and records whichever it was.
async function recorded({ store, row, replay, live }) {
  const stored = store.modelOutput(row.key);
  if (stored?.response.suppressed) throw new Error(stored.response.suppressed);
  if (stored) return { value: stored.response, usage: stored.usage, costUsd: stored.costUsd, request: stored.request };
  if (replay) throw codeError(`No recorded model output for ${row.key}.`, 'REPLAY_MISS');
  let out;
  try { out = await live(); } catch (error) {
    if (['PERSISTENCE_ERROR', 'STALE_STATE'].includes(error.code)) throw error;
    const message = redact(error.message).slice(0, 1000);
    store.saveModelOutput({ ...row, request: {}, response: { suppressed: message } });
    throw codeError(message, error.code);
  }
  store.saveModelOutput({ ...row, request: out.request, response: out.value, usage: out.usage, costUsd: out.costUsd });
  return out;
}

/** The engine's decider for the expert book. Never mutates `state` or `context`; a rejection becomes a suppressed HOLD in the engine. */
export function makeDecider({ store, engineName = 'expert', settings, runner = runClaudeCode, promptDir = PROMPT_DIR, dailyFor = day => store.dailyFor(day), now = Date.now, replay = false }) {
  const prompt = loadPrompt(promptDir, 'decision', DECISION_SCHEMA);
  const decider = async ({ symbol, state, context }) => {
    const row = state.dataset[state.cursor], asOf = new Date(row.timestamp).toISOString(), day = istDay.format(Date.parse(asOf));
    let thesis = store.thesis(symbol, day);
    if (Date.parse(thesis?.createdAt) > Date.parse(asOf)) thesis = null; // not yet written at this bar
    if (thesis && Date.parse(thesis.expiresAt) < Date.parse(asOf)) thesis = { ...thesis, stance: 'watch' }; // expired reverts to watch
    const position = state.positions.find(p => p.symbol === symbol) ?? null;
    const rulesSignal = context.rulesChoice !== 'none' && context.candidates.some(c => c.strategyId === context.rulesChoice && c.action === 'BUY');
    const last = store.lastDecision(symbol, asOf), lastDay = last && istDay.format(Date.parse(last.asOf));
    const newEvidenceSince = Boolean(last) && (context.intelligence?.claims ?? []).some(c => Date.parse(c.analysisReadyAt) > Date.parse(last.asOf));
    // Entry and invalidation conditions persist across bars; each fires once per session day (spec §10).
    const alreadyFired = new Set(store.decisionTriggers(symbol, new Date(`${day}T00:00:00+05:30`).toISOString(), asOf));
    const trigger = triggerFor({ thesis, position, bar: row.bars[symbol], rulesSignal, newEvidenceSince, lastDecisionDay: lastDay, day, alreadyFired });
    if (!trigger) return { action: 'abstain', reason: 'No trigger', evidence: [], counterEvidence: [], tightenStopTo: null, trigger: null, record: null };

    const key = [engineName, symbol, trigger, asOf, prompt.hash].join('|');
    const out = await recorded({ store, replay, row: { key, engine: engineName, symbol, trigger, asOf, promptHash: prompt.hash }, live: async () => {
      if (now() < decider.limitUntil) throw new Error(`subscription limit until ${new Date(decider.limitUntil).toISOString()}`);
      const pack = packFor({ symbol, asOf, state, daily: dailyFor(day), intelligence: context.intelligence, memory: store.memoryFor(symbol, asOf), thesis,
        callsRemaining: settings.model.dailyCallLimit - store.callCount() });
      try {
        return await callModel({ store, settings, runner, prompt, schema: DECISION_SCHEMA, model: settings.expert.decisionModel, request: { trigger, contextPack: pack },
          validate: value => validateDecision(value, { evidenceIds: [...evidenceMap(pack).keys()], position, thesis }) });
      } catch (error) {
        if (error.code !== 'MODEL_LIMIT') throw error;
        decider.limitUntil = Date.parse(error.resetAt) || now() + LIMIT_FALLBACK_MS;
        throw new Error(`subscription limit until ${new Date(decider.limitUntil).toISOString()}`);
      }
    } });
    const decision = out.value, ids = evidenceMap(out.request.contextPack);
    return { action: decision.action, reason: decision.reason, evidence: decision.evidenceIds.map(id => `${id}: ${ids.get(id)}`), counterEvidence: [...decision.counterEvidence],
      tightenStopTo: position ? decision.tightenStopTo : null, trigger, record: { ...decision, key, usage: out.usage, costUsd: out.costUsd } };
  };
  decider.limitUntil = 0;
  return decider;
}

/** Pre-open pass: one thesis call per symbol without a stored thesis for `day`. Failures store a `watch` placeholder (and record it for replay), so the pass is idempotent per day. */
export async function runTheses({ store, settings, symbols, day, asOf, runner = runClaudeCode, intelligenceFor, dailyFor = d => store.dailyFor(d), state, replay = false, engineName = 'expert', promptDir = PROMPT_DIR }) {
  const prompt = loadPrompt(promptDir, 'thesis', THESIS_SCHEMA);
  asOf = new Date(asOf).toISOString();
  const sessionCloseIso = new Date(`${day}T15:30:00+05:30`).toISOString();
  let limited = false;
  for (const symbol of symbols) {
    if (store.thesis(symbol, day)) continue;
    const row = { key: [engineName, symbol, 'thesis', asOf, prompt.hash].join('|'), engine: engineName, symbol, trigger: 'thesis', asOf, promptHash: prompt.hash };
    let payload;
    try {
      ({ value: payload } = await recorded({ store, replay, row, live: async () => {
        if (limited) throw codeError('subscription limit', 'MODEL_LIMIT');
        const pack = packFor({ symbol, asOf, state, daily: dailyFor(day), intelligence: intelligenceFor(symbol, asOf), memory: store.memoryFor(symbol, asOf),
          callsRemaining: settings.model.dailyCallLimit - store.callCount() });
        const ids = [...evidenceMap(pack).keys()];
        try {
          return await callModel({ store, settings, runner, prompt, schema: THESIS_SCHEMA, model: settings.expert.thesisModel,
            request: { contextPack: pack }, validate: value => validateThesis(value, { evidenceIds: ids, sessionCloseIso }) });
        } catch (error) { throw error.code === 'MODEL_LIMIT' ? codeError('subscription limit', 'MODEL_LIMIT') : error; }
      } }));
    } catch (error) {
      if (['REPLAY_MISS', 'PERSISTENCE_ERROR', 'STALE_STATE'].includes(error.code)) throw error;
      limited ||= error.code === 'MODEL_LIMIT';
      payload = { stance: 'watch', invalid: error.message.slice(0, 300) };
    }
    store.saveThesis(symbol, day, { ...payload, createdAt: asOf });
  }
}

// ---- Nightly scoring, review memory and scorecard (spec §6) ----

export const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['lesson', 'decisionQuality', 'note'],
  properties: { lesson: text(500), decisionQuality: { type: 'string', enum: ['good', 'poor', 'lucky', 'unlucky'] }, note: text(300) },
};
const round2 = value => Math.round(value * 100) / 100;
const closeOf = day => Date.parse(`${day}T15:30:00+05:30`);

/**
 * Pure. Scores every trigger-driven decision whose window includes `day`: the window runs `expectedHoldSessions` sessions from the decision's next open
 * (thesis of the decision's own day via `thesisFor(symbol, day)`), cut at `day`'s close. Decisions whose window ended earlier were resolved on their last day.
 * `held` = window ended, never invalidated, last close at or above the reference open; `expired` = ended without that; `open` = window runs past `day`.
 */
export function scoreDecisions({ expertState, rulesState, day, thesisFor = () => null }) {
  const dayClose = closeOf(day);
  const within = (trades, symbol, from, to, action) => trades.filter(t => t.symbol === symbol && t.action === action && Date.parse(t.timestamp) >= from && Date.parse(t.timestamp) <= to);
  return expertState.decisions.filter(d => d.trigger && istDay.format(Date.parse(d.timestamp)) <= day).flatMap(d => {
    const thesis = thesisFor(d.symbol, istDay.format(Date.parse(d.timestamp))), from = Date.parse(d.executionTimestamp);
    let naturalEnd = sessionFor(from)?.closeMs ?? from;
    for (let left = (thesis?.expectedHoldSessions ?? 1) - 1; left > 0;) { naturalEnd += DAY_MS; if (sessionFor(naturalEnd)) left--; }
    if (naturalEnd < dayClose) return [];
    const to = Math.min(naturalEnd, dayClose);
    const bars = expertState.dataset.filter(row => Date.parse(row.timestamp) >= from && Date.parse(row.timestamp) <= to && row.bars[d.symbol]).map(row => row.bars[d.symbol]);
    const reference = bars[0]?.open, level = thesis?.invalidation?.priceBelow ?? d.expert?.invalidation?.priceBelow;
    const invalidationHit = level != null && bars.some(bar => bar.low <= level);
    const realisedBy = state => sum(within(state.trades, d.symbol, from, to, 'SELL').map(t => t.realizedPnl));
    return [{ decisionId: d.id, symbol: d.symbol, trigger: d.trigger, action: d.expert?.action ?? d.action, reason: d.expert?.reason ?? d.reason, invalidationHit,
      mfe: bars.length ? round2((Math.max(...bars.map(b => b.high)) / reference - 1) * 100) : null,
      mae: bars.length ? round2((Math.min(...bars.map(b => b.low)) / reference - 1) * 100) : null,
      realised: realisedBy(expertState),
      rulesSameWindow: { entered: within(rulesState.trades, d.symbol, from, to, 'BUY').length > 0, realised: realisedBy(rulesState) },
      thesisScore: invalidationHit ? 'invalidated' : !bars.length || naturalEnd > dayClose ? 'open' : bars.at(-1).close >= reference ? 'held' : 'expired' }];
  });
}

/**
 * One review call per expert position closed (a SELL) on `day`, whatever closed it, through the same recorded/guarded path as decisions.
 * The input is the position's decision chain (entry to close) with the scores available today. Returns the memories newly written.
 */
export async function reviewClosed({ store, settings, day, scores, expertState, runner = runClaudeCode, replay = false, engineName = 'expert', promptDir = PROMPT_DIR, log = message => process.stderr.write(`${redact(message)}\n`) }) {
  const prompt = loadPrompt(promptDir, 'review', REVIEW_SCHEMA);
  const reviewedAt = new Date(closeOf(day)).toISOString(); // the session close, so a lesson is invisible to every decision at or before it
  const open = new Map(), closed = [];
  for (const trade of expertState.trades) { // trades are in execution order and a symbol holds one position at a time
    if (trade.action === 'BUY') open.set(trade.symbol, trade);
    else if (trade.action === 'SELL' && istDay.format(Date.parse(trade.timestamp)) === day && open.has(trade.symbol)) closed.push({ entry: open.get(trade.symbol), exit: trade });
  }
  let written = 0;
  for (const { entry, exit } of closed) {
    const symbol = entry.symbol, enteredAt = entry.timestamp, closedAt = exit.timestamp;
    const chain = expertState.decisions.filter(d => d.symbol === symbol && d.trigger && Date.parse(d.executionTimestamp) >= Date.parse(enteredAt) && Date.parse(d.executionTimestamp) <= Date.parse(closedAt))
      .map(d => ({ trigger: d.trigger, action: d.expert?.action ?? d.action, reason: d.expert?.reason ?? d.reason, score: scores.find(score => score.decisionId === d.id) ?? null }));
    const request = { symbol, day, enteredAt, closedAt, realised: exit.realizedPnl, thesis: store.thesis(symbol, istDay.format(Date.parse(enteredAt))), decisions: chain };
    // Entry and close times, not trade ids (random per run), keep the key identical on replay and distinct per position.
    const row = { key: [engineName, symbol, 'review', `${enteredAt}~${closedAt}`, prompt.hash].join('|'), engine: engineName, symbol, trigger: 'review', asOf: reviewedAt, promptHash: prompt.hash };
    try {
      const { value } = await recorded({ store, replay, row, live: () => callModel({ store, settings, runner, prompt, schema: REVIEW_SCHEMA, model: settings.expert.researchModel, request,
        validate: value => { checkShape(value, REVIEW_SCHEMA, 'Review'); return value; } }) });
      if (store.memoryFor(symbol, reviewedAt).some(memory => memory.enteredAt === enteredAt && memory.closedAt === closedAt)) continue; // written by an earlier run
      store.saveMemory(symbol, reviewedAt, { ...value, enteredAt, closedAt }); written++;
    } catch (error) {
      if (['REPLAY_MISS', 'PERSISTENCE_ERROR', 'STALE_STATE'].includes(error.code)) throw error;
      log(`Review for ${symbol} failed: ${error.message}`);
    }
  }
  return written;
}

/**
 * The expert engine's scoring step for a closed session: score, review, then write its daily report with the expert extras.
 * Runs inside the live runner's serial queue; the rules engine is only read.
 */
export function makeScoring({ expertEngine, rulesEngine, runner, replay = false, log }) {
  return async (day, dataQuality) => {
    const { store, state } = expertEngine, settings = state.settings;
    const theses = store.thesesFor(day);
    const scores = scoreDecisions({ expertState: state, rulesState: rulesEngine.state, day, thesisFor: (symbol, thesisDay) => store.thesis(symbol, thesisDay) });
    await reviewClosed({ store, settings, day, scores, expertState: state, runner, replay, ...(log && { log }) });
    const calls = store.callsFor(day);
    const covered = new Set(state.intelligenceRecords?.filter(r => istDay.format(Date.parse(r.firstReceivedAt)) === day).map(r => r.symbol));
    const suppressions = state.decisions.filter(d => istDay.format(Date.parse(d.timestamp)) === day && d.outcome?.startsWith('Suppressed:'))
      .map(d => ({ symbol: d.symbol, timestamp: d.timestamp, cause: d.outcome.slice('Suppressed: '.length) }));
    return expertEngine.dailyReport(day, dataQuality, { expert: { scores, theses, calls, costUsd: calls.costUsd, coverage: state.assets.filter(a => covered.has(a.symbol)).length, universe: state.assets.length, suppressions } });
  };
}

/**
 * Phase 1b scorecard over `[{ day, rules, expert }]`. Reports hold cumulative net figures, so sessions add their day-on-day change. Rules and buy-and-hold are measured
 * from the rules report just before the first paired session (rules-only history moves the baseline, not the totals); the expert from its own start.
 * Flagged data-quality sessions are left out. A decision scored on several days counts once, by its latest score.
 */
export function scorecard({ reports }) {
  const card = { sessions: 0, expertNet: 0, rulesNet: 0, buyHoldNet: 0, thesisAccuracy: null, unresolvedTheses: 0, abstentionValue: 0, suppressedCalls: 0, missingCoverageSessions: 0, modelCostUsdEstimate: 0 };
  const before = { expert: 0, rules: 0, buyHold: 0 }, latest = new Map();
  for (const { rules, expert } of reports) {
    const now = {};
    if (rules) now.rules = rules.netAfterFixedCosts, now.buyHold = rules.netAfterFixedCosts + rules.benchmarkEquity - rules.equity;
    if (expert) now.expert = expert.netAfterFixedCosts;
    if (rules && expert && !rules.dataQuality?.flagged) {
      card.sessions++;
      for (const key of ['expert', 'rules', 'buyHold']) card[`${key}Net`] += now[key] - before[key];
      const extra = expert.expert ?? {};
      for (const score of extra.scores ?? []) latest.set(score.decisionId, score);
      card.suppressedCalls += extra.suppressions?.length ?? 0;
      if (extra.coverage < extra.universe) card.missingCoverageSessions++;
      card.modelCostUsdEstimate += extra.costUsd ?? 0;
    }
    Object.assign(before, now);
  }
  const scores = [...latest.values()], resolved = scores.filter(score => score.thesisScore !== 'open');
  card.abstentionValue = sum(scores.filter(score => score.action === 'abstain').map(score => score.rulesSameWindow.realised));
  card.unresolvedTheses = scores.length - resolved.length;
  card.thesisAccuracy = resolved.length ? resolved.filter(score => score.thesisScore === 'held').length / resolved.length : null; // unresolved decisions are counted separately
  for (const key of ['expertNet', 'rulesNet', 'buyHoldNet', 'abstentionValue', 'modelCostUsdEstimate']) card[key] = round2(card[key]);
  return { ...card, exitBarMet: card.sessions >= 40 && card.expertNet > card.rulesNet && card.expertNet > card.buyHoldNet };
}
