// Daily backup: a consistent SQLite copy plus the day's tick capture, keeping 30 days.
// Usage: node deploy/backup.mjs <dbPath> <backupDir>   (ticks are read from <dirname(dbPath)>/ticks)
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';

const KEEP_MS = 30 * 86_400_000;
const istDay = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));

export async function backup({ dbPath, backupDir, ticksDir = join(dirname(dbPath), 'ticks'), now = Date.now() }) {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const day = istDay(now), database = join(backupDir, `trading-lab-${day}.sqlite`);
  const source = new DatabaseSync(dbPath, { readOnly: true });
  try { await sqliteBackup(source, database); } finally { source.close(); }
  const tickFile = join(ticksDir, `ticks-${day}.jsonl`);
  const ticks = existsSync(tickFile) ? join(backupDir, `ticks-${day}.jsonl`) : null;
  if (ticks) copyFileSync(tickFile, ticks);
  // The expert book (Phase 1b) keeps its own database beside the rules book's.
  const expertPath = dbPath.replace(/(\.sqlite)?$/, '-expert$1');
  const expertDatabase = existsSync(expertPath) ? join(backupDir, `trading-lab-expert-${day}.sqlite`) : null;
  if (expertDatabase) {
    const expert = new DatabaseSync(expertPath, { readOnly: true });
    try { await sqliteBackup(expert, expertDatabase); } finally { expert.close(); }
  }
  const pruned = [];
  for (const name of readdirSync(backupDir)) {
    const path = join(backupDir, name);
    if (![database, ticks, expertDatabase].includes(path) && now - statSync(path).mtimeMs > KEEP_MS) { unlinkSync(path); pruned.push(path); }
  }
  return { day, database, ticks, pruned, ...(expertDatabase && { expertDatabase }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dbPath, backupDir] = process.argv.slice(2);
  if (!dbPath || !backupDir) { process.stderr.write('Usage: node deploy/backup.mjs <dbPath> <backupDir>\n'); process.exit(2); }
  const result = await backup({ dbPath: resolve(dbPath), backupDir: resolve(backupDir) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
