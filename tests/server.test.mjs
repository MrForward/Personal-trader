import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApplication } from '../src/server.mjs';
import { ACCESS_TOKEN, fakeClient, fakeTicker } from './kite-fakes.mjs';

async function workspace(t) {
  const app = createApplication({ dbPath: ':memory:', port: 0, autoStepMs: 0 });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (path, value, method = 'POST', headers = {}) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });
    return { status: response.status, body: await response.json() };
  };
  return { app, base, request };
}

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

test('reports route returns saved daily reports', async t => {
  const { app, base } = await workspace(t);
  assert.deepEqual(await (await fetch(base + '/api/reports')).json(), []);
  app.engine.dailyReport('2026-10-14', { ticks: 0, flagged: false });
  const reports = await (await fetch(base + '/api/reports')).json();
  assert.equal(reports.length, 1); assert.equal(reports[0].day, '2026-10-14');
});
