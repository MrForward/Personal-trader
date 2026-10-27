import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, validateSettings } from '../src/config.mjs';

test('settings version validated partial updates and preserve unrelated settings', () => {
  const result = validateSettings({ version: 1, risk: { stopLossPct: 3 } });
  assert.equal(result.version, 2); assert.equal(result.risk.stopLossPct, 3); assert.equal(result.risk.maxDailyLossPct, 3);
  assert.deepEqual(result.model, DEFAULT_SETTINGS.model); assert.equal(DEFAULT_SETTINGS.risk.stopLossPct, 2);
  assert.throws(() => validateSettings({ version: 1 }, result), /stale/);
});
test('unknown fields, null/nonfinite values and wrong nested shapes are rejected', () => {
  for (const bad of [null, [], { surprise: 1 }, { risk: null }, { model: [] }, { simulation: 'wrong' }, { risk: { stopLossPct: null } },
    { risk: { maxDailyLossPct: NaN } }, { simulation: { costSchedule: 7 } }, { strategy: { enabled: null } },
    { model: { baseUrl: 'https://evil.example' } }, { risk: { unknown: 1 } }, { simulation: { unknown: 1 } },
    { strategy: { arbitrary: true } }, { model: { provider: null } }, { risk: { stopLossPct: undefined } }]) assert.throws(() => validateSettings(bad));
});
test('allocation and independent loss limits have explicit finite bounds', () => {
  assert.throws(() => validateSettings({ risk: { maxPositionPct: 70, maxExposurePct: 60 } }), /allocation/);
  assert.throws(() => validateSettings({ risk: { maxDailyLossPct: 0 } }), /maxDailyLossPct/);
  assert.throws(() => validateSettings({ risk: { maxDrawdownPct: 51 } }), /maxDrawdownPct/);
  assert.equal(validateSettings({ risk: { maxDailyLossPct: 0.1 } }).risk.maxDailyLossPct, 0.1);
});
test('cost schedule is validated and defaults to the Zerodha CNC schedule', () => {
  assert.equal(DEFAULT_SETTINGS.simulation.costSchedule, 'zerodha-cnc-2026-10');
  assert.equal(validateSettings({ simulation: { costSchedule: 'none' } }).simulation.costSchedule, 'none');
  assert.throws(() => validateSettings({ simulation: { costSchedule: 'x' } }), /costSchedule/);
  assert.throws(() => validateSettings({ simulation: { feeBps: 10 } }), /Unknown simulation setting/);
});
test('universe and bar size are validated', () => {
  assert.equal(DEFAULT_SETTINGS.universe.length, 10); assert.equal(DEFAULT_SETTINGS.barMinutes, 15);
  assert.deepEqual(validateSettings({ universe: ['INFY', 'ITC', 'INFY'] }).universe, ['INFY', 'ITC']);
  assert.equal(validateSettings({ barMinutes: 60 }).barMinutes, 60);
  for (const bad of [{ universe: [] }, { universe: ['bad symbol'] }, { universe: Array.from({ length: 21 }, (_, i) => `S${i}`) }, { universe: 'INFY' }, { barMinutes: 7 }])
    assert.throws(() => validateSettings(bad), /universe|barMinutes/);
});
test('fixed monthly costs and spend cap are validated', () => {
  assert.equal(DEFAULT_SETTINGS.simulation.fixedCostsPerMonthInr, 1100); assert.equal(DEFAULT_SETTINGS.simulation.spendCapPerMonthInr, 1200);
  assert.equal(validateSettings({ simulation: { fixedCostsPerMonthInr: 0 } }).simulation.fixedCostsPerMonthInr, 0);
  for (const bad of [-1, 100001, NaN]) assert.throws(() => validateSettings({ simulation: { spendCapPerMonthInr: bad } }), /spendCapPerMonthInr/);
});
test('expert settings default off and validate', () => {
  assert.equal(validateSettings({}).expert.enabled, false);
  // Probe 27 Oct 2026: WebSearch rejects the whole call when allowed_domains names a site that blocks Anthropic's crawler.
  for (const blocked of ['reuters.com', 'livemint.com', 'economictimes.indiatimes.com', 'moneycontrol.com']) assert.ok(!DEFAULT_SETTINGS.expert.allowedDomains.includes(blocked), blocked);
  for (const reachable of ['nseindia.com', 'bseindia.com', 'business-standard.com', 'businesstoday.in']) assert.ok(DEFAULT_SETTINGS.expert.allowedDomains.includes(reachable), reachable);
  assert.equal(DEFAULT_SETTINGS.model.dailyCallLimit, 60);
  assert.throws(() => validateSettings({ expert: { enabled: 'yes' } }));
  assert.throws(() => validateSettings({ expert: { allowedDomains: ['http://x'] } }));
  assert.throws(() => validateSettings({ expert: { surprise: 1 } }), /Unknown expert setting/);
  assert.throws(() => validateSettings({ expert: { maxResearchPerSession: 21 } }));
  assert.throws(() => validateSettings({ expert: { maxResearchPerSession: 1.5 } }));
  assert.throws(() => validateSettings({ expert: { thesisModel: '--flag injection' } }));
  assert.equal(validateSettings({ expert: { maxResearchPerSession: 3 } }).expert.maxResearchPerSession, 3);
});
test('partial expert updates merge over previous values and settings without expert still validate', () => {
  const first = validateSettings({ expert: { enabled: true, allowedDomains: ['nseindia.com'] } });
  const second = validateSettings({ expert: { maxResearchPerSession: 2 } }, first);
  assert.deepEqual(second.expert, { ...DEFAULT_SETTINGS.expert, enabled: true, allowedDomains: ['nseindia.com'], maxResearchPerSession: 2 });
  const { expert, ...legacy } = DEFAULT_SETTINGS;
  assert.deepEqual(validateSettings({}, legacy).expert, DEFAULT_SETTINGS.expert);
});
test('expert maxRiskPerTradePct defaults to 1 and is bounded', () => {
  assert.equal(DEFAULT_SETTINGS.expert.maxRiskPerTradePct, 1);
  assert.equal(validateSettings({ expert: { maxRiskPerTradePct: 2 } }).expert.maxRiskPerTradePct, 2);
  for (const bad of [0, 5.1, NaN, '1']) assert.throws(() => validateSettings({ expert: { maxRiskPerTradePct: bad } }), /maxRiskPerTradePct/);
});
