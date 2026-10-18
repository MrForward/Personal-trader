import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';

function store(t) { const value = new Store(':memory:'); t.after(() => value.close()); return value; }
const call = { provider: 'openai', model: 'mock-model', dailyCallLimit: 1 };
test('state and audit commit together, including atomic archive/reset', t => {
  const s = store(t); s.save({ runId: 'old', cursor: 29 }, 'initial');
  s.archiveAndSave(s.load(), { runId: 'new', cursor: 29 }, 'reset');
  assert.equal(s.archiveCount(), 1); assert.equal(s.load().runId, 'new');
  assert.deepEqual(s.audit().map(event => event.kind), ['initial', 'run-archived', 'reset']);
});
test('failed audit insert rolls back state, archive and revision', t => {
  const s = store(t); s.save({ runId: 'old', cursor: 29 }); const revision = s.revision;
  s.db.exec("CREATE TRIGGER fail_reset BEFORE INSERT ON audit WHEN NEW.kind='reset' BEGIN SELECT RAISE(ABORT,'injected'); END;");
  assert.throws(() => s.archiveAndSave(s.load(), { runId: 'new', cursor: 29 }, 'reset'), /storage/);
  assert.equal(s.load().runId, 'old'); assert.equal(s.archiveCount(), 0); assert.equal(s.revision, revision); assert.equal(s.audit().length, 1);
});
test('reservation counts actual attempts, is atomic, and cannot be completed twice', t => {
  const s = store(t); const id = s.reserveCall(call); assert.equal(s.callCount(), 1);
  assert.throws(() => s.reserveCall(call), /Daily AI call limit/);
  s.finishCall(id, 'failed'); assert.equal(s.callCount(), 1);
  assert.throws(() => s.finishCall(id, 'completed', { inputTokens: 1, outputTokens: 1 }));
  assert.equal(s.db.prepare('SELECT status FROM model_calls WHERE id=?').get(id).status, 'failed');
});
test('reservation audit failure rolls back the call without consuming budget', t => {
  const s = store(t); s.db.exec("CREATE TRIGGER fail_call BEFORE INSERT ON audit WHEN NEW.kind='model-call-reserved' BEGIN SELECT RAISE(ABORT,'injected'); END;");
  assert.throws(() => s.reserveCall(call), /storage/); assert.equal(s.callCount(), 0);
});
test('separate connections enforce shared call budget and reject stale state writers', t => {
  const directory = mkdtempSync(join(tmpdir(), 'trading-lab-store-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const a = new Store(join(directory, 'state.sqlite')), b = new Store(join(directory, 'state.sqlite'));
  t.after(() => { a.close(); b.close(); });
  a.save({ cursor: 29 }); a.reserveCall(call); assert.throws(() => b.reserveCall(call), /Daily AI call limit/);
  assert.throws(() => b.save({ cursor: 99 }), /another process/); assert.equal(a.load().cursor, 29);
});
test('memoryFor filters by reviewedAt and limits to 5, newest first', t => {
  const s = store(t);
  for (let hour = 1; hour <= 7; hour++) s.saveMemory('INFY', `2026-10-14T0${hour}:00:00Z`, { lesson: `L${hour}` });
  s.saveMemory('SBIN', '2026-10-14T01:00:00Z', { lesson: 'other' });
  const rows = s.memoryFor('INFY', '2026-10-14T06:30:00Z');
  assert.deepEqual(rows.map(row => row.lesson), ['L6', 'L5', 'L4', 'L3', 'L2']);
  assert.ok(rows.every(row => row.reviewedAt <= '2026-10-14T06:30:00.000Z'));
  assert.equal(s.memoryFor('INFY', '2026-10-14T00:30:00Z').length, 0);
});
test('thesis, daily bars and model outputs round-trip', t => {
  const s = store(t);
  s.saveThesis('INFY', '2026-10-14', { stance: 'watch' }); s.saveThesis('INFY', '2026-10-14', { stance: 'candidate' }); s.saveThesis('SBIN', '2026-10-14', { stance: 'avoid' });
  assert.deepEqual(s.thesis('INFY', '2026-10-14'), { stance: 'candidate' }); assert.equal(s.thesis('INFY', '2026-10-15'), null);
  assert.deepEqual(s.thesesFor('2026-10-14'), { INFY: { stance: 'candidate' }, SBIN: { stance: 'avoid' } });
  const bars = [{ date: '2026-10-13', open: 1, high: 2, low: 1, close: 2, volume: 5 }];
  s.saveDaily('2026-10-14', 'NIFTY 50', bars); s.saveDaily('2026-10-14', 'INFY', bars); s.saveDaily('2026-10-14', 'INFY', bars);
  assert.deepEqual(s.dailyFor('2026-10-14'), { 'NIFTY 50': bars, INFY: bars }); assert.deepEqual(s.dailyFor('2026-10-15'), {});
  const row = { key: 'k1', engine: 'B', symbol: 'INFY', trigger: 'thesis', asOf: '2026-10-14T03:15:00Z', promptHash: 'h', request: { a: 1 }, response: { b: 2 }, usage: { inputTokens: 3 }, costUsd: 0.12 };
  s.saveModelOutput(row); s.saveModelOutput({ ...row, response: { b: 'changed' } });
  assert.deepEqual({ ...s.modelOutput('k1'), createdAt: undefined }, { ...row, createdAt: undefined });
  assert.equal(typeof s.modelOutput('k1').createdAt, 'string'); assert.equal(s.modelOutput('missing'), null);
});
