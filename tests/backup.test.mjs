import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { backup } from '../deploy/backup.mjs';

test('backup copies the database and the day\'s ticks, and prunes files older than 30 days', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'trading-lab.sqlite'), backupDir = join(dir, 'backups'), ticksDir = join(dir, 'ticks');
  const store = new Store(dbPath); store.save({ marker: 'state-row' }, 'test'); store.close();
  mkdirSync(ticksDir); writeFileSync(join(ticksDir, 'ticks-2026-10-14.jsonl'), '{"symbol":"A"}\n');
  mkdirSync(backupDir); const old = join(backupDir, 'trading-lab-2026-09-01.sqlite'), recent = join(backupDir, 'trading-lab-2026-10-13.sqlite');
  writeFileSync(old, 'old'); writeFileSync(recent, 'recent');
  const now = Date.parse('2026-10-14T10:30:00Z');
  utimesSync(old, (now - 31 * 86_400_000) / 1000, (now - 31 * 86_400_000) / 1000);
  utimesSync(recent, (now - 86_400_000) / 1000, (now - 86_400_000) / 1000);
  const result = await backup({ dbPath, backupDir, ticksDir, now });
  assert.deepEqual(result, { day: '2026-10-14', database: join(backupDir, 'trading-lab-2026-10-14.sqlite'), ticks: join(backupDir, 'ticks-2026-10-14.jsonl'), pruned: [old] });
  const copy = new DatabaseSync(result.database, { readOnly: true });
  assert.equal(JSON.parse(copy.prepare('SELECT payload FROM state WHERE id=1').get().payload).marker, 'state-row'); copy.close();
  assert.equal(readFileSync(result.ticks, 'utf8'), '{"symbol":"A"}\n');
  assert.equal(existsSync(old), false); assert.equal(existsSync(recent), true);
});

test('backup without a tick file still copies the database', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'db.sqlite'); new Store(dbPath).close();
  const result = await backup({ dbPath, backupDir: join(dir, 'b'), ticksDir: join(dir, 'none'), now: Date.parse('2026-10-14T10:30:00Z') });
  assert.equal(result.ticks, null); assert.ok(existsSync(result.database));
});
