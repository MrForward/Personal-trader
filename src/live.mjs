import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BarBuilder } from './bars.mjs';
import { sessionFor } from './calendar.mjs';
import { redact } from './secrets.mjs';

const WARMUP_BARS = 40, SKEW_MS = 5_000, SKEW_RUN = 3, CLEAN_BARS = 2, FLUSH_GRACE_MS = 30_000, MAX_BACKOFF_S = 300;
const fatal = error => ['PERSISTENCE_ERROR', 'STALE_STATE'].includes(error?.code);

// Feeds live ticks into the engine one closed bar at a time. Every tick is captured before use so a day replays exactly.
export class LiveRunner {
  constructor({ engine, session, captureDir, source = session.ticker(), calendar = sessionFor, now = Date.now, run = fn => fn(),
    onFatal = () => {}, intervalMs = 10_000, log = message => process.stderr.write(`${redact(message)}\n`) }) {
    Object.assign(this, { engine, session, captureDir, source, calendar, now, run, onFatal, intervalMs, log });
    this.state = 'idle'; this.pending = Promise.resolve(); this.timers = [];
    this.resetDay(null);
  }
  resetDay(day) {
    this.day = day; this.builder = null; this.barsToday = 0; this.cleanBarsSinceGap = 0; this.lastTickAt = null;
    this.skewRun = 0; this.unskewRun = 0; this.skewed = false; this.gapBarEnd = null; this.reconnects = 0;
    this.counters = { ticks: 0, badTicks: 0, rejectedRows: 0, warmupFailed: 0, disconnects: 0 };
  }
  symbols() { return [...this.engine.state.settings.universe].sort(); }
  barMinutes() { return this.engine.state.settings.barMinutes; }
  async start() {
    this.stopTimers();
    const session = this.calendar(this.now());
    if (!session || this.now() >= session.closeMs) { this.state = 'idle'; return this.status(); }
    if (this.session.status().state !== 'valid') { this.state = 'login-needed'; return this.status(); }
    if (session.day !== this.day) this.resetDay(session.day);
    this.sessionWindow = session; this.state = 'warming-up';
    try { await this.run(() => this.warmup()); }
    catch (error) {
      if (fatal(error)) return this.die(error);
      if (!this.isLive()) {
        this.state = 'warmup-failed'; this.log(`Warmup failed; retrying: ${error.message}`);
        this.later(() => this.start(), 60_000);
        return this.status();
      }
      this.counters.warmupFailed++; this.log(`Warmup failed; continuing on ticks: ${error.message}`);
    }
    this.builder = new BarBuilder({ barMinutes: this.barMinutes(), symbols: this.symbols(), session });
    const last = this.engine.state.dataset.at(-1);
    for (const symbol of this.symbols()) if (last.bars[symbol]) this.builder.seed(symbol, last.bars[symbol].close);
    this.state = 'live';
    if (this.intervalMs > 0) { const id = setInterval(() => this.poll(), this.intervalMs); id.unref?.(); this.timers.push(() => clearInterval(id)); }
    this.connect();
    return this.status();
  }
  isLive() {
    const s = this.engine.state;
    return s.mode === 'prospective-paper' && JSON.stringify(s.assets.map(a => a.symbol).sort()) === JSON.stringify(this.symbols());
  }
  async warmup() {
    const endMs = this.now(), symbols = this.symbols();
    const bySymbol = await Promise.all(symbols.map(symbol => this.session.historicalBars({ symbol, barMinutes: this.barMinutes(), count: WARMUP_BARS, endMs })));
    const stamps = bySymbol.map(bars => new Map(bars.map(bar => [bar.timestamp, bar])));
    const rows = [...stamps[0].keys()].filter(stamp => stamps.every(map => map.has(stamp))).sort()
      .map(timestamp => ({ timestamp, bars: Object.fromEntries(symbols.map((symbol, i) => { const { timestamp: _t, ...bar } = stamps[i].get(timestamp); return [symbol, bar]; })) }));
    if (!this.isLive()) {
      return this.engine.beginLive({ rows, assets: symbols.map(symbol => ({ symbol, name: symbol, sector: 'NSE' })), source: 'Kite live NSE (prospective paper)' });
    }
    const lastMs = Date.parse(this.engine.state.dataset.at(-1).timestamp);
    for (const row of rows) if (Date.parse(row.timestamp) > lastMs) this.engine.appendBar({ ...row, source: 'historical' });
    this.engine.catchUp();
  }
  connect() {
    this.source.start({ onTick: tick => this.onTick(tick), onClose: reason => this.onClose(reason), onError: error => this.log(`Feed error: ${error?.message ?? error}`) });
  }
  onTick(tick) {
    if (!this.builder || !['live', 'disconnected'].includes(this.state)) return;
    if (this.state === 'disconnected') { this.state = 'live'; this.reconnects = 0; this.gapBarEnd = null; }
    mkdirSync(this.captureDir, { recursive: true });
    appendFileSync(join(this.captureDir, `ticks-${this.day}.jsonl`), `${JSON.stringify(tick)}\n`);
    this.counters.ticks++; this.lastTickAt = this.now();
    if (this.now() - tick.exchangeTime > SKEW_MS) { this.unskewRun = 0; if (++this.skewRun >= SKEW_RUN) this.skewed = true; }
    else { this.skewRun = 0; if (++this.unskewRun >= SKEW_RUN) this.skewed = false; }
    let row;
    try { row = this.builder.push(tick); } catch (error) { this.counters.badTicks++; this.log(`Tick rejected: ${error.message}`); return; }
    if (row) this.handleRow(row);
  }
  handleRow(row) {
    const blockEntries = this.skewed ? 'Clock skew over 5 s' : this.cleanBarsSinceGap < CLEAN_BARS ? 'Data gap: waiting for clean bars' : undefined;
    this.cleanBarsSinceGap = row.source === 'ticks' ? this.cleanBarsSinceGap + 1 : 0;
    this.barsToday++;
    this.pending = this.pending.then(() => this.run(async () => {
      this.engine.appendBar(row);
      await this.engine.step({ runId: this.engine.state.runId, expectedCursor: this.engine.state.cursor, ...(blockEntries ? { blockEntries } : {}) });
    })).catch(error => {
      if (fatal(error)) return this.die(error);
      this.counters.rejectedRows++; this.log(`Bar ${row.timestamp} not applied: ${error.message}`);
    });
  }
  poll() {
    const now = this.now();
    if (this.state === 'live' && this.builder) {
      const row = this.builder.flush(now);
      if (row) this.handleRow(row);
      if (!this.builder.current && now >= this.sessionWindow.closeMs + FLUSH_GRACE_MS) { this.state = 'closed'; this.stopTimers(); this.source.stop(); }
    } else if (this.state === 'disconnected' && this.builder) {
      // No prices means no protection: record each bar period that passed without data instead of fabricating a bar.
      this.gapBarEnd ??= this.builder.current?.end ?? now;
      if (now >= this.gapBarEnd + FLUSH_GRACE_MS) {
        const barEnd = new Date(this.gapBarEnd).toISOString();
        this.gapBarEnd += this.barMinutes() * 60_000;
        this.pending = this.pending.then(() => this.run(() => this.engine.store.append('protection-gap', { barEnd, positions: this.engine.state.positions.map(p => p.symbol) })))
          .catch(error => this.log(`Gap record failed: ${error.message}`));
      }
    }
  }
  onClose(reason) {
    this.cleanBarsSinceGap = 0; this.counters.disconnects++;
    if (reason === 'expired') { this.state = 'login-needed'; this.stopTimers(); return; }
    if (this.state !== 'live') return;
    this.state = 'disconnected';
    const delay = Math.min(2 ** this.reconnects++, MAX_BACKOFF_S) * 1000;
    this.later(() => { if (this.state === 'disconnected') this.connect(); }, delay);
  }
  later(fn, ms) {
    if (this.intervalMs <= 0) return;
    const id = setTimeout(fn, ms); id.unref?.(); this.timers.push(() => clearTimeout(id));
  }
  die(error) { this.stop(); this.onFatal(error); return this.status(); }
  stopTimers() { for (const clear of this.timers.splice(0)) clear(); }
  stop() { this.stopTimers(); this.source.stop(); this.state = 'idle'; }
  idle() { return this.pending; }
  status() {
    return { state: this.state, day: this.day, lastTickAt: this.lastTickAt ? new Date(this.lastTickAt).toISOString() : null, barsToday: this.barsToday,
      counters: { ...this.counters, ...(this.builder?.counters ?? {}) }, cleanBarsSinceGap: this.cleanBarsSinceGap, skewed: this.skewed };
  }
}

export function replayCapture(path) {
  return {
    start: handlers => { for (const line of readFileSync(path, 'utf8').split('\n')) if (line) handlers.onTick(JSON.parse(line)); },
    stop: () => {},
  };
}
