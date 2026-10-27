import { validateModelConfig } from './models.mjs';
import { COST_SCHEDULES } from './costs.mjs';

export const DEFAULT_SETTINGS = {
  version: 1,
  model: { provider: 'rules', model: '', maxOutputTokens: 1000, timeoutMs: 15000, dailyCallLimit: 60 },
  strategy: { mode: 'auto', enabled: ['momentum', 'mean_reversion'] },
  risk: { stopLossPct: 2, takeProfitPct: 4, trailingStopPct: 0, maxPositionPct: 25, maxExposurePct: 60, maxDrawdownPct: 8, maxDailyLossPct: 3, riskPerTradePct: 0.5 },
  simulation: { startingCapital: 9000, slippageBps: 10, costSchedule: 'zerodha-cnc-2026-10', fixedCostsPerMonthInr: 1100, spendCapPerMonthInr: 1200 },
  // shortcut: placeholder universe of liquid NSE names, replace when the owner confirms the list (GOAL.md: under ₹1,500/share).
  universe: ['RELIANCE', 'INFY', 'HDFCBANK', 'ICICIBANK', 'ITC', 'SBIN', 'WIPRO', 'ONGC', 'COALINDIA', 'TATASTEEL'],
  barMinutes: 15,
  // shortcut: placeholder allow-list, the owner confirms it before research is enabled.
  expert: { enabled: false, thesisModel: 'claude-opus-5-5', decisionModel: 'claude-opus-5-5', researchModel: 'claude-sonnet-5-5', maxResearchPerSession: 5,
    // Reuters, Mint, ET, Moneycontrol and most Indian outlets block Anthropic's crawler, so WebSearch and WebFetch cannot reach them.
    allowedDomains: ['nseindia.com', 'bseindia.com', 'rbi.org.in', 'sebi.gov.in', 'business-standard.com', 'businesstoday.in', 'zeebiz.com', 'businessworld.in'], maxRiskPerTradePct: 1 },
};
const DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/, MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const SYMBOL = /^[A-Z0-9][A-Z0-9._&-]{0,24}$/;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const groups = {
  model: ['provider', 'model', 'maxOutputTokens', 'timeoutMs', 'dailyCallLimit'],
  strategy: ['mode', 'enabled'],
  risk: Object.keys(DEFAULT_SETTINGS.risk),
  simulation: Object.keys(DEFAULT_SETTINGS.simulation),
  expert: Object.keys(DEFAULT_SETTINGS.expert),
};

const bounds = {
  stopLossPct: [0.1, 30], takeProfitPct: [0.1, 100], trailingStopPct: [0, 30],
  maxPositionPct: [1, 100], maxExposurePct: [1, 100], maxDrawdownPct: [0.1, 50], maxDailyLossPct: [0.1, 50], riskPerTradePct: [0.01, 5],
};

export function validateSettings(input, previous = DEFAULT_SETTINGS) {
  if (!object(input)) throw new Error('Settings must be an object.');
  for (const key of Object.keys(input)) if (!['model', 'strategy', 'risk', 'simulation', 'universe', 'barMinutes', 'expert', 'version'].includes(key)) throw new Error(`Unknown setting: ${key}`);
  for (const [group, allowed] of Object.entries(groups)) {
    if (!Object.hasOwn(input, group)) continue;
    if (!object(input[group])) throw new Error(`${group} settings must be an object.`);
    for (const key of Object.keys(input[group])) if (!allowed.includes(key)) throw new Error(`Unknown ${group} setting: ${key}`);
    if (Object.values(input[group]).some(value => value === null || value === undefined)) throw new Error(`${group} settings cannot contain null or undefined.`);
  }
  if (Object.hasOwn(input, 'version') && (!Number.isSafeInteger(input.version) || input.version !== previous.version)) throw new Error('Settings version is stale or invalid.');
  const model = validateModelConfig({ ...previous.model, ...input.model });
  const strategy = { ...previous.strategy, ...input.strategy };
  if (!['auto', 'momentum', 'mean_reversion'].includes(strategy.mode)) throw new Error('Choose automatic, momentum or mean reversion.');
  if (!Array.isArray(strategy.enabled) || !strategy.enabled.length || strategy.enabled.some(id => !['momentum', 'mean_reversion'].includes(id))) throw new Error('Enable at least one supported strategy.');
  strategy.enabled = [...new Set(strategy.enabled)];
  if (strategy.mode !== 'auto' && !strategy.enabled.includes(strategy.mode)) throw new Error('The selected strategy must be enabled.');
  const risk = {};
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const value = input.risk?.[key] ?? previous.risk[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}.`);
    risk[key] = value;
  }
  if (risk.maxPositionPct > risk.maxExposurePct) throw new Error('Position allocation cannot exceed total exposure.');
  const simulation = {};
  for (const [key, min, max] of [['startingCapital', 100, 10000000], ['slippageBps', 0, 500], ['fixedCostsPerMonthInr', 0, 100000], ['spendCapPerMonthInr', 0, 100000]]) {
    const value = input.simulation?.[key] ?? previous.simulation[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}.`);
    simulation[key] = value;
  }
  simulation.costSchedule = input.simulation?.costSchedule ?? previous.simulation.costSchedule;
  if (!COST_SCHEDULES.includes(simulation.costSchedule)) throw new Error(`costSchedule must be one of: ${COST_SCHEDULES.join(', ')}.`);
  const universe = input.universe ?? previous.universe;
  if (!Array.isArray(universe) || !universe.length || universe.length > 20 || universe.some(symbol => typeof symbol !== 'string' || !SYMBOL.test(symbol))) throw new Error('universe must list 1–20 NSE trading symbols.');
  const barMinutes = input.barMinutes ?? previous.barMinutes;
  if (![5, 15, 60].includes(barMinutes)) throw new Error('barMinutes must be 5, 15 or 60.');
  const expert = { ...DEFAULT_SETTINGS.expert, ...previous.expert, ...input.expert };
  if (typeof expert.enabled !== 'boolean') throw new Error('expert.enabled must be true or false.');
  for (const key of ['thesisModel', 'decisionModel', 'researchModel']) if (typeof expert[key] !== 'string' || !MODEL_ID.test(expert[key])) throw new Error(`${key} must be a model id.`);
  if (!Number.isInteger(expert.maxResearchPerSession) || expert.maxResearchPerSession < 0 || expert.maxResearchPerSession > 20) throw new Error('maxResearchPerSession must be between 0 and 20.');
  if (!Array.isArray(expert.allowedDomains) || expert.allowedDomains.length > 50 || expert.allowedDomains.some(domain => typeof domain !== 'string' || !DOMAIN.test(domain))) throw new Error('allowedDomains must list up to 50 lowercase domain names.');
  if (typeof expert.maxRiskPerTradePct !== 'number' || !Number.isFinite(expert.maxRiskPerTradePct) || expert.maxRiskPerTradePct < 0.1 || expert.maxRiskPerTradePct > 5) throw new Error('maxRiskPerTradePct must be between 0.1 and 5.');
  expert.allowedDomains = [...new Set(expert.allowedDomains)];
  return { version: previous.version + 1, model, strategy, risk, simulation, universe: [...new Set(universe)], barMinutes, expert };
}
