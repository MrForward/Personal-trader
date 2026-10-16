import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApplication } from '../src/server.mjs';

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
