/** Off-price-path evidence collector: asks Claude to search allow-listed sources and returns intelligence records. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runClaudeCode } from './models.mjs';
import { SOURCE_KINDS, VERIFICATION_STATUSES, validateIntelligence } from './intelligence.mjs';
import { analyzeMarket, WARMUP_BARS } from './strategies.mjs';

const SYSTEM_PROMPT = readFileSync(new URL('./prompts/research.md', import.meta.url), 'utf8');
const WINDOW = 'last 7 days plus scheduled events in the next 14 days';
const SESSION_MINUTES = 375; // NSE 09:15-15:30

const schemaFor = kinds => ({
  type: 'object', additionalProperties: false, required: ['records', 'coverageNote'],
  properties: {
    records: { type: 'array', maxItems: 20, items: {
      type: 'object', additionalProperties: false,
      required: ['origin', 'publishedAt', 'sourceKind', 'verificationStatus', 'content', 'sourceUrl'],
      properties: {
        origin: { type: 'string', maxLength: 240 }, publishedAt: { type: 'string', maxLength: 40 }, eventAt: { type: 'string', maxLength: 40 },
        sourceKind: { type: 'string', enum: kinds }, verificationStatus: { type: 'string', enum: [...VERIFICATION_STATUSES] },
        content: { type: 'string', maxLength: 1000 }, sourceUrl: { type: 'string', maxLength: 2048 },
      } } },
    coverageNote: { type: 'string', maxLength: 300 },
  },
});
export const RESEARCH_SCHEMA = schemaFor(SOURCE_KINDS.filter(kind => kind !== 'synthetic'));
const MARKET_SCHEMA = schemaFor(['calendar', 'news']);

const onList = (sourceUrl, domains) => {
  try { const host = new URL(sourceUrl).hostname.toLowerCase(); return domains.some(d => host === d || host.endsWith(`.${d}`)); } catch { return false; }
};
const istString = ms => new Date(ms + 330 * 60_000).toISOString().replace('Z', '+05:30');

async function collect({ symbol, extra, now, settings, schema, runner }) {
  const { researchModel, allowedDomains } = settings.expert;
  const nowMs = Date.parse(now), received = new Date(nowMs).toISOString();
  const out = await runner({
    model: researchModel, systemPrompt: SYSTEM_PROMPT, schema, maxTurns: 3, timeoutMs: 120000,
    tools: ['WebSearch', ...allowedDomains.map(d => `WebFetch(domain:${d})`)],
    input: JSON.stringify({ symbol, ...extra, nowIst: istString(nowMs), allowedDomains, window: WINDOW }),
  });
  const accepted = []; let dropped = 0;
  for (const r of out.value.records) {
    const candidate = { ...r, id: `${symbol}:${createHash('sha1').update(r.origin + r.publishedAt).digest('hex').slice(0, 12)}`, symbol,
      firstReceivedAt: received, analysisReadyAt: received, version: 1 };
    // One bad record (future publishedAt, status clash, duplicate id, off-list host) must not discard the batch.
    try {
      if (!onList(r.sourceUrl, allowedDomains)) throw new Error('off-list');
      validateIntelligence([...accepted, candidate]);
      accepted.push(candidate);
    } catch { dropped++; }
  }
  return { records: validateIntelligence(accepted), dropped, coverageNote: out.value.coverageNote, usage: out.usage, costUsd: out.costUsd };
}

export const researchSymbol = ({ symbol, companyName, now, settings, runner = runClaudeCode }) =>
  collect({ symbol, extra: { companyName }, now, settings, schema: RESEARCH_SCHEMA, runner });

export const researchMarket = ({ now, settings, runner = runClaudeCode }) =>
  collect({ symbol: 'MARKET', extra: {}, now, settings, schema: MARKET_SCHEMA, runner });

/** Range beyond 2 ATR, or volume beyond 3x the typical bar (20-day mean daily volume spread over the session's bars). False without enough history. */
export function isAnomaly(bar, history, dailyBars, barMinutes = 15) {
  if (history.length < WARMUP_BARS) return false;
  if (bar.high - bar.low > 2 * analyzeMarket(history).atr) return true;
  if (dailyBars.length < 20) return false;
  const mean = dailyBars.slice(-20).reduce((sum, day) => sum + day.volume, 0) / 20;
  return bar.volume > 3 * (mean / (SESSION_MINUTES / barMinutes));
}
