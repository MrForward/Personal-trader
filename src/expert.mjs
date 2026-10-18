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
