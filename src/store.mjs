import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function failure(message, code = 'PERSISTENCE_ERROR') { const error = new Error(message); error.code = code; return error; }

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS archived_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, usage TEXT);
      CREATE TABLE IF NOT EXISTS daily_report (day TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kite_session (id INTEGER PRIMARY KEY CHECK(id=1), access_token TEXT NOT NULL, user_id TEXT NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, instruments TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS expert_thesis (symbol TEXT NOT NULL, day TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(symbol, day));
      CREATE TABLE IF NOT EXISTS expert_memory (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, reviewedAt TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS expert_memory_symbol ON expert_memory(symbol, reviewedAt);
      CREATE TABLE IF NOT EXISTS expert_daily (day TEXT NOT NULL, symbol TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(day, symbol));
      CREATE TABLE IF NOT EXISTS model_outputs (key TEXT PRIMARY KEY, engine TEXT NOT NULL, symbol TEXT, trigger TEXT NOT NULL, asOf TEXT NOT NULL, promptHash TEXT NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL, usage TEXT, costUsd REAL, createdAt TEXT NOT NULL);`);
    if (!this.db.prepare('PRAGMA table_info(state)').all().some(column => column.name === 'revision')) this.db.exec('ALTER TABLE state ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
    this.revision = this.db.prepare('SELECT revision FROM state WHERE id=1').get()?.revision ?? 0;
  }
  transaction(fn) {
    let begun = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); begun = true;
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (begun) { try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ } }
      if (['STALE_STATE', 'DAILY_CALL_LIMIT'].includes(error.code)) throw error;
      throw failure('Persistent storage operation failed; trading remains paused.');
    }
  }
  load() {
    const row = this.db.prepare('SELECT payload,revision FROM state WHERE id=1').get();
    this.revision = row?.revision ?? 0;
    return row ? JSON.parse(row.payload) : null;
  }
  append(kind, payload) {
    this.db.prepare('INSERT INTO audit(timestamp,kind,payload) VALUES(?,?,?)').run(new Date().toISOString(), kind, JSON.stringify(payload));
  }
  save(state, kind = 'step', detail = {}, { archive } = {}) {
    const revision = this.transaction(() => {
      const current = this.db.prepare('SELECT revision FROM state WHERE id=1').get()?.revision ?? 0;
      if (current !== this.revision) throw failure('State changed in another process; reload before proceeding.', 'STALE_STATE');
      if (archive) {
        this.db.prepare('INSERT INTO archived_runs(timestamp,payload) VALUES(?,?)').run(new Date().toISOString(), JSON.stringify(archive));
        this.append('run-archived', { runId: archive.runId });
      }
      this.db.prepare('INSERT INTO state(id,payload,revision) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision').run(JSON.stringify(state), current + 1);
      this.append(kind, detail);
      return current + 1;
    });
    this.revision = revision;
  }
  archiveAndSave(previous, state, kind, detail = {}) { this.save(state, kind, detail, { archive: previous }); }
  callCount(day = new Date().toISOString().slice(0, 10)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid call-budget day.');
    return this.db.prepare('SELECT COUNT(*) AS count FROM model_calls WHERE timestamp LIKE ?').get(`${day}%`).count;
  }
  reserveCall(config) {
    if (!Number.isInteger(config.dailyCallLimit) || config.dailyCallLimit < 0 || config.dailyCallLimit > 200 || !['openai', 'anthropic', 'claude-code'].includes(config.provider) || typeof config.model !== 'string') throw new Error('Invalid model call reservation.');
    return this.transaction(() => {
      if (this.callCount() >= config.dailyCallLimit) throw failure('Daily AI call limit reached. No provider request was sent.', 'DAILY_CALL_LIMIT');
      const result = this.db.prepare('INSERT INTO model_calls(timestamp,provider,model,status) VALUES(?,?,?,?)').run(new Date().toISOString(), config.provider, config.model, 'reserved');
      this.append('model-call-reserved', { provider: config.provider, model: config.model, callId: Number(result.lastInsertRowid) });
      return Number(result.lastInsertRowid);
    });
  }
  finishCall(id, status, usage = {}) {
    if (!['completed', 'failed'].includes(status)) throw new Error('Invalid model call outcome.');
    const sanitized = {};
    for (const key of ['inputTokens', 'outputTokens']) {
      if (usage[key] !== undefined && (!Number.isSafeInteger(usage[key]) || usage[key] < 0)) throw new Error('Invalid model usage.');
      if (usage[key] !== undefined) sanitized[key] = usage[key];
    }
    this.transaction(() => {
      const result = this.db.prepare("UPDATE model_calls SET status=?,usage=? WHERE id=? AND status='reserved'").run(status, JSON.stringify(sanitized), id);
      if (result.changes !== 1) throw new Error('Call reservation has already been completed or does not exist.');
      this.append('model-call-finished', { callId: id, status, usage: sanitized });
    });
  }
  saveKiteSession({ accessToken, userId, issuedAt, expiresAt, instruments }) {
    this.db.prepare(`INSERT INTO kite_session(id,access_token,user_id,issued_at,expires_at,instruments) VALUES(1,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET access_token=excluded.access_token,user_id=excluded.user_id,issued_at=excluded.issued_at,expires_at=excluded.expires_at,instruments=excluded.instruments`)
      .run(accessToken, userId, issuedAt, expiresAt, JSON.stringify(instruments));
  }
  loadKiteSession() {
    const row = this.db.prepare('SELECT * FROM kite_session WHERE id=1').get();
    return row ? { accessToken: row.access_token, userId: row.user_id, issuedAt: row.issued_at, expiresAt: row.expires_at, instruments: JSON.parse(row.instruments) } : null;
  }
  saveDailyReport(day, payload) {
    this.db.prepare('INSERT INTO daily_report(day,payload) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET payload=excluded.payload').run(day, JSON.stringify(payload));
  }
  dailyReports() { return this.db.prepare('SELECT day,payload FROM daily_report ORDER BY day').all().map(row => ({ ...JSON.parse(row.payload), day: row.day })); }
  hasDailyReport(day) { return Boolean(this.db.prepare('SELECT 1 FROM daily_report WHERE day=?').get(day)); }
  saveThesis(symbol, day, payload) {
    this.db.prepare('INSERT INTO expert_thesis(symbol,day,payload) VALUES(?,?,?) ON CONFLICT(symbol,day) DO UPDATE SET payload=excluded.payload').run(symbol, day, JSON.stringify(payload));
  }
  thesis(symbol, day) {
    const row = this.db.prepare('SELECT payload FROM expert_thesis WHERE symbol=? AND day=?').get(symbol, day);
    return row ? JSON.parse(row.payload) : null;
  }
  thesesFor(day) { return Object.fromEntries(this.db.prepare('SELECT symbol,payload FROM expert_thesis WHERE day=? ORDER BY symbol').all(day).map(row => [row.symbol, JSON.parse(row.payload)])); }
  saveMemory(symbol, reviewedAt, payload) {
    this.db.prepare('INSERT INTO expert_memory(symbol,reviewedAt,payload) VALUES(?,?,?)').run(symbol, new Date(reviewedAt).toISOString(), JSON.stringify(payload));
  }
  // Newest first; a lesson is invisible before the moment it was written, so replays cannot see hindsight.
  memoryFor(symbol, asOf, limit = 5) {
    return this.db.prepare('SELECT reviewedAt,payload FROM expert_memory WHERE symbol=? AND reviewedAt<=? ORDER BY reviewedAt DESC, id DESC LIMIT ?')
      .all(symbol, new Date(asOf).toISOString(), limit).map(row => ({ ...JSON.parse(row.payload), reviewedAt: row.reviewedAt }));
  }
  saveDaily(day, symbol, bars) {
    this.db.prepare('INSERT INTO expert_daily(day,symbol,payload) VALUES(?,?,?) ON CONFLICT(day,symbol) DO UPDATE SET payload=excluded.payload').run(day, symbol, JSON.stringify(bars));
  }
  dailyFor(day) { return Object.fromEntries(this.db.prepare('SELECT symbol,payload FROM expert_daily WHERE day=? ORDER BY symbol').all(day).map(row => [row.symbol, JSON.parse(row.payload)])); }
  // First write wins: replay must keep serving the output that was actually recorded.
  saveModelOutput({ key, engine, symbol = null, trigger, asOf, promptHash, request, response, usage = null, costUsd = null, createdAt = new Date().toISOString() }) {
    this.db.prepare('INSERT OR IGNORE INTO model_outputs(key,engine,symbol,trigger,asOf,promptHash,request,response,usage,costUsd,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(key, engine, symbol, trigger, asOf, promptHash, JSON.stringify(request), JSON.stringify(response), JSON.stringify(usage), costUsd, createdAt);
  }
  modelOutput(key) {
    const row = this.db.prepare('SELECT * FROM model_outputs WHERE key=?').get(key);
    return row ? { ...row, request: JSON.parse(row.request), response: JSON.parse(row.response), usage: JSON.parse(row.usage) } : null;
  }
  clearKiteSession() { this.db.prepare('DELETE FROM kite_session WHERE id=1').run(); }
  audit() { return this.db.prepare('SELECT * FROM audit ORDER BY id').all().map(row => ({ ...row, payload: JSON.parse(row.payload) })); }
  archiveCount() { return this.db.prepare('SELECT COUNT(*) AS count FROM archived_runs').get().count; }
  close() { this.db.close(); }
}
