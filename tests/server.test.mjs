import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { TradingEngine } from '../src/engine.mjs';
import { ACCESS_TOKEN, fakeClient, fakeTicker } from './kite-fakes.mjs';

async function workspace(t, app = createApplication({ dbPath: ':memory:', port: 0, autoStepMs: 0 })) {
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (path, value, method = 'POST', headers = {}) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });
    return { status: response.status, body: await response.json() };
  };
  return { app, base, request };
}

// A file-backed workspace whose stored settings enable the expert book at startup.
function seededDb(t, settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'server-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'trading-lab.sqlite');
  const seed = new Store(dbPath); new TradingEngine(seed).settings({ expert: { enabled: true }, ...settings }); seed.close();
  return { dir, dbPath };
}
const expertWorkspace = (t, options = {}) => workspace(t, createApplication({ dbPath: seededDb(t).dbPath, port: 0, autoStepMs: 0, ...options }));

test('dashboard, API, paper ledger and export form a complete local flow', async t => {
  const { base, request } = await workspace(t);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /app\.js/);
  const initial = await (await fetch(base + '/api/state')).json();
  assert.equal(initial.currency, 'INR');
  assert.equal(initial.kite.liveTrading, false);
  assert.equal(initial.providerStatus.paidCallsEnabled, false);
  const stepped = await request('/api/control', { action: 'step', expectedCursor: initial.run.cursor, runId: initial.runId });
  assert.equal(stepped.status, 200);
  assert.equal(stepped.body.run.cursor, initial.run.cursor + 1);
  assert.ok(stepped.body.decisions.length);
  const exportResponse = await fetch(base + '/api/export');
  assert.match(exportResponse.headers.get('content-disposition'), /attachment/);
  const evidence = await exportResponse.json();
  assert.equal(evidence.cursor, stepped.body.run.cursor);
  assert.ok(evidence.audit.some(row => row.kind === 'step'));
});

test('a duplicate client step cannot advance replay twice', async t => {
  const { base, request } = await workspace(t);
  const initial = await (await fetch(base + '/api/state')).json();
  const input = { action: 'step', expectedCursor: initial.run.cursor, runId: initial.runId };
  const outcomes = await Promise.all([request('/api/control', input), request('/api/control', input)]);
  assert.deepEqual(outcomes.map(row => row.status).sort(), [200, 409]);
  const final = await (await fetch(base + '/api/state')).json();
  assert.equal(final.run.cursor, initial.run.cursor + 1);
});

test('local API rejects foreign origins, rebinding hosts and source file access', async t => {
  const { base, request } = await workspace(t);
  assert.equal((await request('/api/control', { action: 'reset' }, 'POST', { origin: 'https://malicious.example' })).status, 403);
  const address = new URL(base);
  const reboundStatus = await new Promise((resolve, reject) => {
    const req = http.get({ host: address.hostname, port: address.port, path: '/api/state', headers: { host: 'malicious.example' } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await fetch(base + '/src/server.mjs')).status, 404);
  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.archivedRuns, 0);
});

test('model configuration does not enable provider spending', async t => {
  const { request } = await workspace(t);
  assert.equal((await request('/api/settings', { model: { provider: 'openai', model: 'test-model' } })).status, 200);
  const review = await request('/api/review', { symbol: 'DEMO-A' });
  assert.equal(review.status, 400);
  assert.match(review.body.error, /Paid model calls are disabled/);
});

test('reject remote binding before opening storage or network', () => {
  assert.throws(() => createApplication({ host: '0.0.0.0', dbPath: ':memory:' }), /loopback/);
});

async function kiteWorkspace(t, { client = fakeClient({ symbols: ['RELIANCE', 'INFY', 'HDFCBANK', 'ICICIBANK', 'ITC', 'SBIN', 'WIPRO', 'ONGC', 'COALINDIA', 'TATASTEEL'] }), ticker = fakeTicker() } = {}) {
  const app = createApplication({ dbPath: ':memory:', port: 0, autoStepMs: 0, kite: { apiKey: 'key', apiSecret: 'kite-api-secret' },
    makeClient: () => client, makeTicker: () => ticker, liveOptions: { intervalMs: 0, calendar: () => null } });
  const address = await app.listen(); t.after(() => app.close());
  return { app, base: `http://127.0.0.1:${address.port}`, client, ticker };
}
const get = (url, headers = {}) => fetch(url, { redirect: 'manual', headers });

test('kite status reports unconfigured without an api key', async t => {
  const { base } = await workspace(t);
  assert.deepEqual(await (await fetch(base + '/api/kite/status')).json(), { configured: false });
  assert.equal((await (await fetch(base + '/api/health')).json()).kite, 'unconfigured');
  assert.equal((await get(base + '/kite/login')).status, 404);
});

test('login redirects to the Kite login URL', async t => {
  const { base } = await kiteWorkspace(t);
  const response = await get(base + '/kite/login');
  assert.equal(response.status, 302); assert.equal(response.headers.get('location'), 'https://kite.example/connect/login?api_key=key');
});

test('callback completes the session, starts the runner and redirects home without leaking the token', async t => {
  const { base } = await kiteWorkspace(t);
  const response = await get(base + '/kite/callback?request_token=reqtoken123&action=login&status=success', { 'sec-fetch-site': 'cross-site' });
  assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/');
  const raw = await (await fetch(base + '/api/kite/status')).text();
  assert.equal(JSON.parse(raw).session.state, 'valid'); assert.equal(JSON.parse(raw).runner.state, 'idle');
  assert.doesNotMatch(raw, new RegExp(ACCESS_TOKEN));
  const state = await (await fetch(base + '/api/state')).text();
  assert.doesNotMatch(state, new RegExp(ACCESS_TOKEN)); assert.equal(JSON.parse(state).kite.session.state, 'valid');
  assert.doesNotMatch(await (await fetch(base + '/api/export')).text(), new RegExp(ACCESS_TOKEN));
});

test('callback with a bad or failed token returns 400 and leaves status none', async t => {
  const { base } = await kiteWorkspace(t);
  for (const query of ['request_token=badtoken000&status=success', 'request_token=reqtoken123&status=cancelled', 'request_token=has%20space&status=success']) {
    const response = await get(`${base}/kite/callback?${query}`);
    assert.equal(response.status, 400, query); assert.doesNotMatch(await response.text(), /kite-api-secret/);
  }
  assert.equal((await (await fetch(base + '/api/kite/status')).json()).session.state, 'none');
});

test('health reports mode and kite state', async t => {
  const { base } = await kiteWorkspace(t);
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.mode, 'paper'); assert.equal(health.kite, 'none'); assert.equal(health.liveTrading, false); assert.equal(health.lastTickAt, null);
});

test('reports route pairs rules and expert reports by day; scorecard route answers the exit bar', async t => {
  const { app, base } = await expertWorkspace(t);
  assert.deepEqual(await (await fetch(base + '/api/reports')).json(), []);
  app.engine.dailyReport('2026-10-14', { ticks: 0, flagged: false });
  app.engine.dailyReport('2026-10-15', { ticks: 0, flagged: false });
  app.expertEngine.dailyReport('2026-10-14', { ticks: 0, flagged: false }, { expert: { scores: [] } });
  const reports = await (await fetch(base + '/api/reports')).json();
  assert.deepEqual(reports.map(r => r.day), ['2026-10-14', '2026-10-15']);
  assert.equal(reports[0].rules.day, '2026-10-14'); assert.deepEqual(reports[0].expert.expert.scores, []); assert.equal(reports[1].expert, null);
  const card = await (await fetch(base + '/api/scorecard')).json();
  assert.equal(card.sessions, 1); assert.equal(card.exitBarMet, false);
});

test('with the expert book disabled nothing expert is built: no store file, no book, rules-only reports and scorecard', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'server-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { app, base, request } = await workspace(t, createApplication({ dbPath: join(dir, 'trading-lab.sqlite'), port: 0, autoStepMs: 0 }));
  const state = await (await fetch(base + '/api/state')).json();
  assert.deepEqual(state.expert, { enabled: false, book: null, theses: {}, runner: null });
  assert.equal(app.expertEngine, null); assert.equal(app.expertStore, null);
  assert.equal((await request('/api/settings', { risk: { maxPositionPct: 20 } })).status, 200);
  app.engine.dailyReport('2026-10-14', { ticks: 0, flagged: false });
  const reports = await (await fetch(base + '/api/reports')).json();
  assert.deepEqual(reports.map(r => [r.day, r.expert]), [['2026-10-14', null]]);
  const card = await fetch(base + '/api/scorecard');
  assert.equal(card.status, 200); assert.equal((await card.json()).sessions, 0);
  assert.ok(!readdirSync(dir).some(name => name.includes('-expert')), readdirSync(dir).join(', '));
  const kite = await kiteWorkspace(t);
  assert.equal(kite.app.runner.expert, null);
});

test('an expert read that throws never fails or alters a rules response', async t => {
  const { app, base } = await expertWorkspace(t);
  const before = await (await fetch(base + '/api/state')).json();
  app.expertStore.thesesFor = () => { throw new Error('expert db locked'); };
  app.expertStore.dailyReports = () => { throw new Error('expert db locked'); };
  const state = await fetch(base + '/api/state');
  assert.equal(state.status, 200);
  const body = await state.json();
  assert.equal(body.expert.enabled, true); assert.match(body.expert.error, /expert db locked/); assert.equal(body.run.cursor, before.run.cursor);
  // A rules mutation (stop tighten) still answers 200.
  const s = app.engine.state, row = s.dataset[s.cursor], symbol = s.assets[0].symbol, close = row.bars[symbol].close;
  s.positions = [{ id: 'held-position', symbol, quantity: 1, entryPrice: close, markPrice: close, entryFee: 0, stopPrice: close * 0.5, takeProfitPrice: close * 2, trailingStopPct: 0,
    peakPrice: close, strategyId: 'momentum', configVersion: s.settings.version, openedAt: row.timestamp }];
  const tightened = await fetch(base + '/api/positions/held-position/stop', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stopPrice: close * 0.6 }) });
  assert.equal(tightened.status, 200);
  const result = await tightened.json();
  assert.equal(result.positions[0].stopPrice, close * 0.6); assert.match(result.expert.error, /expert db locked/);
  app.engine.dailyReport('2026-10-14', { ticks: 0, flagged: false });
  const logged = [], write = process.stderr.write;
  process.stderr.write = chunk => { logged.push(String(chunk)); return true; };
  let reports;
  try { reports = await fetch(base + '/api/reports'); } finally { process.stderr.write = write; }
  assert.equal(reports.status, 200); assert.deepEqual((await reports.json()).map(r => [r.day, r.expert]), [['2026-10-14', null]]);
  assert.match(logged.join(''), /Expert reports unavailable: expert db locked/);
});

test('expert enabled at startup wires the runner, guards research calls and mirrors expert settings', async t => {
  const { dbPath } = seededDb(t);
  let fail = false;
  const modelRunner = async () => { if (fail) throw new Error('claude -p failed'); return { value: { records: [], coverageNote: 'none' }, usage: { inputTokens: 1, outputTokens: 2 }, costUsd: 0 }; };
  const app = createApplication({ dbPath, port: 0, autoStepMs: 0, kite: { apiKey: 'key', apiSecret: 'kite-api-secret' }, modelRunner,
    makeClient: () => fakeClient(), makeTicker: () => fakeTicker(), liveOptions: { intervalMs: 0, calendar: () => null } });
  const address = await app.listen(); t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  assert.ok(app.runner.expert); assert.equal(app.expertEngine.state.settings.expert.enabled, true);
  assert.equal((await app.runner.expert.research({ symbol: 'MARKET', now: () => Date.parse('2026-10-14T03:00:00.000Z') })).coverageNote, 'none');
  fail = true;
  await assert.rejects(app.runner.expert.research({ symbol: 'INFY', now: () => Date.parse('2026-10-14T03:00:00.000Z') }), /claude -p failed/);
  const calls = app.expertStore.audit().filter(row => row.kind === 'model-call-finished').map(row => row.payload.status);
  assert.deepEqual(calls, ['completed', 'failed']); assert.equal(app.store.callCount(), 0);
  const response = await fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expert: { maxResearchPerSession: 3 } }) });
  const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.expertWarning, undefined); assert.equal(body.expert.enabled, true);
  assert.equal(app.engine.state.settings.expert.maxResearchPerSession, 3); assert.equal(app.expertEngine.state.settings.expert.maxResearchPerSession, 3);
  // A mirror failure is a warning; the rules book's update still stands.
  app.expertEngine.settings = () => { throw new Error('Engine is busy'); };
  const warned = await fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expert: { maxResearchPerSession: 4 } }) });
  assert.equal(warned.status, 200); assert.match((await warned.json()).expertWarning, /busy/);
  assert.equal(app.engine.state.settings.expert.maxResearchPerSession, 4);
});

test('fix #2: every setting is mirrored to the expert book', async t => {
  const { app, request } = await expertWorkspace(t);
  const response = await request('/api/settings', { risk: { maxPositionPct: 20 } });
  assert.equal(response.status, 200); assert.equal(response.body.expertWarning, undefined);
  assert.equal(app.engine.state.settings.risk.maxPositionPct, 20); assert.equal(app.expertEngine.state.settings.risk.maxPositionPct, 20);
});

async function drifted(t, prepareExpert) {
  const { dir, dbPath } = seededDb(t, { risk: { maxPositionPct: 20 }, simulation: { startingCapital: 12000 } });
  const expert = new Store(join(dir, 'trading-lab-expert.sqlite')); await prepareExpert(new TradingEngine(expert)); expert.close();
  const warnings = [], write = process.stderr.write;
  process.stderr.write = chunk => { warnings.push(String(chunk)); return true; };
  let app;
  try { app = createApplication({ dbPath, port: 0, autoStepMs: 0 }); } finally { process.stderr.write = write; }
  await app.listen(); t.after(() => app.close());
  return { app, warnings };
}

test('fix #2: startup re-syncs drifted expert settings to the rules book', async t => {
  const { app, warnings } = await drifted(t, engine => engine.settings({ risk: { maxPositionPct: 10 } }));
  const { version: _a, ...rules } = app.engine.state.settings, { version: _b, ...expert } = app.expertEngine.state.settings;
  assert.deepEqual(expert, rules); assert.equal(expert.risk.maxPositionPct, 20); assert.deepEqual(warnings, []);
});

test('fix #2: a startup re-sync the expert book refuses is a warning and the server still starts', async t => {
  // The expert book has stepped, so its starting capital can no longer change.
  const { app, warnings } = await drifted(t, engine => engine.step());
  assert.equal(app.server.listening, true);
  assert.equal(app.expertEngine.state.settings.simulation.startingCapital, 9000);
  assert.match(warnings.join(''), /Warning: expert settings not synced.*starting capital/);
});

test('POST /api/settings accepts expert settings; the page ships the Expert panel and settings fields', async t => {
  const { base, request } = await workspace(t);
  const saved = await request('/api/settings', { expert: { enabled: true, maxResearchPerSession: 2, allowedDomains: ['nseindia.com'] } });
  assert.equal(saved.status, 200); assert.equal(saved.body.expertWarning, undefined);
  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.settings.expert.enabled, true); assert.equal(state.settings.expert.maxResearchPerSession, 2);
  assert.deepEqual(state.settings.expert.allowedDomains, ['nseindia.com']);
  // The running flag follows the startup value, so the panel must say a restart is needed.
  assert.equal(state.expert.enabled, false);
  const html = await (await fetch(base + '/')).text(), script = await (await fetch(base + '/app.js')).text();
  for (const id of ['expert-panel', 'expert-enabled', 'expert-thesis-model', 'expert-decision-model', 'expert-research-model', 'expert-max-research', 'expert-domains']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /next service restart/); assert.match(script, /function renderExpert/);
});

test('close() aborts a hanging claude call, finishes within its timeout and writes nothing after it starts', async t => {
  const { dbPath } = seededDb(t);
  let signal, settle;
  // Hangs and ignores the abort, like a child that will not die.
  const modelRunner = input => { signal = input.signal; return new Promise(resolve => { settle = resolve; }); };
  const app = createApplication({ dbPath, port: 0, autoStepMs: 0, kite: { apiKey: 'key', apiSecret: 'kite-api-secret' }, modelRunner,
    makeClient: () => fakeClient(), makeTicker: () => fakeTicker(), liveOptions: { intervalMs: 0, calendar: () => null } });
  await app.listen();
  // Queued the way an anomaly scan queues it, so close() has to wait on it.
  const research = app.runner.expertTask = app.runner.research(['INFY']);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(signal && !signal.aborted);
  const expertDb = dbPath.replace(/\.sqlite$/, '-expert.sqlite'), before = [app.store.audit().length, app.expertStore.audit().length];
  const started = Date.now();
  const logged = [], write = process.stderr.write;
  process.stderr.write = chunk => { logged.push(String(chunk)); return true; };
  try {
    await app.close({ timeoutMs: 200 });
    assert.ok(Date.now() - started < 1500); assert.equal(signal.aborted, true);
    // The call answers after shutdown; nothing may reach either database.
    settle({ value: { records: [], coverageNote: 'late' }, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });
    await research;
  } finally { process.stderr.write = write; }
  assert.match(logged.join(''), /Shutdown timed out/);
  const rules = new Store(dbPath), expert = new Store(expertDb);
  try { assert.deepEqual([rules.audit().length, expert.audit().length], before); } finally { rules.close(); expert.close(); }
});
