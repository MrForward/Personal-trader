import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BarBuilder } from './bars.mjs';
import { sessionFor } from './calendar.mjs';
import { redact } from './secrets.mjs';
import { SECTOR_INDEX } from './expert.mjs';
import { isAnomaly } from './research.mjs';
import { validateIntelligence } from './intelligence.mjs';
import { scanWatchlist } from './scan.mjs';

const WARMUP_BARS = 40, SKEW_MS = 5_000, SKEW_RUN = 3, CLEAN_BARS = 2, FLUSH_GRACE_MS = 30_000, MAX_BACKOFF_S = 300;
const fatal = error => ['PERSISTENCE_ERROR', 'STALE_STATE'].includes(error?.code);
const SCAN_AT = 8 * 60 + 15, RESEARCH_AT = 8 * 60 + 30, THESES_AT = 8 * 60 + 45, DAILY_BARS = 60, INDEX = 'NIFTY 50';
const istMinutes = ms => Math.floor((ms + 330 * 60_000) / 60_000) % 1440;

// Feeds live ticks into the engine one closed bar at a time. Every tick is captured before use so a day replays exactly.
// With `expert` (Phase 1b), a second engine gets the same bars after the rules engine; its failures never reach the rules book.
export class LiveRunner {
  constructor({ engine, session, captureDir, source = session.ticker(), calendar = sessionFor, now = Date.now, run = fn => fn(),
    onFatal = () => {}, intervalMs = 10_000, log = message => process.stderr.write(`${redact(message)}\n`), expert = null, scan = scanWatchlist }) {
    Object.assign(this, { engine, session, captureDir, source, calendar, now, run, onFatal, intervalMs, log, expert, scan });
    this.state = 'idle'; this.pending = Promise.resolve(); this.timers = []; this.expertTask = Promise.resolve(); this.expertHalted = null;
    this.resetDay(null);
  }
  resetDay(day) {
    this.day = day; this.builder = null; this.barsToday = 0; this.cleanBarsSinceGap = 0; this.lastTickAt = null;
    this.skewRun = 0; this.unskewRun = 0; this.skewed = false; this.gapBarEnd = null; this.reconnects = 0; this.nextAttemptAt = null; this.partial = false;
    this.counters = { ticks: 0, badTicks: 0, rejectedRows: 0, warmupFailed: 0, disconnects: 0, ...(this.expert && { expertRejectedRows: 0 }) };
    // shortcut: anomaly calls are counted in memory, so a restart mid-session resets the cap; dailyCallLimit still bounds spend.
    this.researchStarted = false; this.thesesStarted = false; this.researchDone = false; this.thesesDone = false; this.anomalyCalls = 0; this.coverageMissing = new Set();
    this.scanStarted = false; this.scanDone = false;
  }
  expertEngine() { return this.expert && !this.expertHalted ? this.expert.engine : null; }
  // True when the error was a storage fault: the expert book stops, the rules book carries on.
  expertFault(error) {
    if (!fatal(error)) return false;
    this.expertHalted ??= redact(error.message); this.log(`Expert book halted: ${error.message}`);
    return true;
  }
  // Every expert-side failure lands here, never in the rules book's counters.
  expertError(error, what) {
    if (this.expertFault(error)) return;
    this.counters.expertRejectedRows++; this.log(`${what}: ${error.message}`);
  }
  symbols() { return [...this.engine.state.settings.universe].sort(); }
  barMinutes() { return this.engine.state.settings.barMinutes; }
  async start() {
    this.stopTimers();
    const session = this.calendar(this.now());
    this.backfillReport(session);
    if (!session || this.now() >= session.closeMs) { this.state = 'idle'; return this.status(); }
    if (session.day !== this.day) this.resetDay(session.day);
    // A runner that missed part of the session cannot vouch for that day's data quality.
    if (this.now() > session.openMs) this.partial = true;
    this.sessionWindow = session; this.gapBarEnd = null; this.nextAttemptAt = null;
    if (this.intervalMs > 0) { const id = setInterval(() => this.poll(), this.intervalMs); id.unref?.(); this.timers.push(() => clearInterval(id)); }
    if (this.session.status().state !== 'valid') { this.state = 'login-needed'; return this.status(); }
    this.state = 'warming-up';
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
    this.rebuildBuilder();
    this.state = 'live';
    this.connect();
    this.scheduleMorning();
    return this.status();
  }
  isLive(engine = this.engine) {
    const s = engine.state;
    return s.mode === 'prospective-paper' && s.liveBarMinutes === this.barMinutes() && JSON.stringify(s.assets.map(a => a.symbol).sort()) === JSON.stringify(this.symbols());
  }
  rebuildBuilder() {
    this.builder = new BarBuilder({ barMinutes: this.barMinutes(), symbols: this.symbols(), session: this.sessionWindow });
    const last = this.engine.state.dataset.at(-1);
    for (const symbol of this.symbols()) if (last.bars[symbol]) this.builder.seed(symbol, last.bars[symbol].close);
  }
  async warmupRows(symbols, endMs) {
    const bySymbol = await Promise.all(symbols.map(symbol => this.session.historicalBars({ symbol, barMinutes: this.barMinutes(), count: WARMUP_BARS, endMs })));
    const stamps = bySymbol.map(bars => new Map(bars.map(bar => [bar.timestamp, bar])));
    return [...stamps[0].keys()].filter(stamp => stamps.every(map => map.has(stamp))).sort()
      .map(timestamp => ({ timestamp, bars: Object.fromEntries(symbols.map((symbol, i) => { const { timestamp: _t, ...bar } = stamps[i].get(timestamp); return [symbol, bar]; })) }));
  }
  async warmup() {
    const endMs = this.now(), symbols = this.symbols();
    const rows = await this.warmupRows(symbols, endMs);
    this.load(this.engine, rows, symbols);
    const expert = this.expertEngine();
    if (expert) { try { this.load(expert, rows, symbols); } catch (error) { if (!this.expertFault(error)) this.log(`Expert warmup failed: ${error.message}`); } }
    try { await this.markIndex(endMs); } catch (error) { if (fatal(error)) throw error; this.log(`${INDEX} benchmark mark unavailable: ${error.message}`); }
    if (!expert) return;
    try { await this.dailyWarmup(expert.store, symbols, endMs); } catch (error) { this.expertError(error, 'Expert daily warmup failed'); }
  }
  // Benchmark: the index's last daily close marks both books' buy-and-hold comparison once per warmup and relist.
  async markIndex(endMs) {
    const bar = (await this.session.historicalBars({ symbol: INDEX, barMinutes: 'day', count: 1, endMs })).at(-1);
    if (!bar) return;
    this.engine.markIndex({ name: INDEX, close: bar.close });
    const expert = this.expertEngine();
    if (expert) { try { expert.markIndex({ name: INDEX, close: bar.close }); } catch (error) { this.expertError(error, 'Expert index mark failed'); } }
  }
  // Pre-market scan (08:15 IST): held names keep their slot, the rest of the watchlist is refilled from the day's ranked candidates.
  async scanPass() {
    const engines = [this.engine, this.expertEngine()].filter(Boolean);
    try {
      const held = [...new Set(engines.flatMap(engine => engine.state.positions.map(p => p.symbol)))];
      const universe = await this.scan({ session: this.session, settings: this.engine.state.settings, held, endMs: this.now(), log: this.log });
      if (JSON.stringify(universe) !== JSON.stringify(this.symbols())) await this.relist(universe);
      this.scanDone = true;
    } catch (error) { if (fatal(error)) return this.die(error); this.log(`Watchlist scan failed; keeping ${this.symbols().join(', ')}: ${error.message}`); }
  }
  async relist(universe) {
    const endMs = this.now(), rows = await this.warmupRows(universe, endMs);
    await this.run(() => {
      this.engine.relist({ rows, universe });
      const expert = this.expertEngine();
      if (expert) { try { expert.relist({ rows, universe }); } catch (error) { this.expertError(error, 'Expert relist failed'); } }
    });
    this.log(`Watchlist: ${universe.join(', ')}`);
    // A bar in progress on the old symbol set is dropped; before the open there is none.
    this.rebuildBuilder();
    if (this.state === 'live') this.connect();
    const expert = this.expertEngine();
    if (expert) { try { await this.dailyWarmup(expert.store, this.symbols(), endMs); } catch (error) { this.expertError(error, 'Expert daily warmup failed'); } }
  }
  load(engine, rows, symbols) {
    if (!this.isLive(engine)) {
      return engine.beginLive({ rows, assets: symbols.map(symbol => ({ symbol, name: symbol, sector: 'NSE' })), source: 'Kite live NSE (prospective paper)' });
    }
    const lastMs = Date.parse(engine.state.dataset.at(-1).timestamp);
    for (const row of rows) if (Date.parse(row.timestamp) > lastMs) engine.appendBar({ ...row, source: 'historical' });
    engine.catchUp();
  }
  // Daily bars for the expert's context pack: each symbol, NIFTY 50 and each mapped sector index, fetched once per session day.
  async dailyWarmup(store, symbols, endMs) {
    const have = store.dailyFor(this.day);
    const names = [...new Set([...symbols, 'NIFTY 50', ...symbols.map(symbol => SECTOR_INDEX[symbol]).filter(Boolean)])].filter(name => !have[name]);
    for (const name of names) {
      try { store.saveDaily(this.day, name, await this.session.historicalBars({ symbol: name, barMinutes: 'day', count: DAILY_BARS, endMs })); }
      catch (error) { this.log(`Daily bars for ${name} unavailable: ${error.message}`); }
    }
  }
  connect() {
    this.source.start({ onTick: tick => this.onTick(tick), onClose: reason => this.onClose(reason), onError: error => this.log(`Feed error: ${error?.message ?? error}`) });
  }
  onTick(tick) {
    if (!this.builder || !['live', 'disconnected'].includes(this.state)) return;
    if (this.state === 'disconnected') { this.state = 'live'; this.reconnects = 0; this.gapBarEnd = null; this.nextAttemptAt = null; }
    mkdirSync(this.captureDir, { recursive: true });
    appendFileSync(join(this.captureDir, `ticks-${this.day}.jsonl`), `${JSON.stringify(tick)}\n`);
    this.counters.ticks++; this.lastTickAt = this.now();
    if (Math.abs(this.now() - tick.exchangeTime) > SKEW_MS) { this.unskewRun = 0; if (++this.skewRun >= SKEW_RUN) this.skewed = true; }
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
      let failure = null;
      try {
        this.engine.appendBar(row);
        await this.engine.step({ runId: this.engine.state.runId, expectedCursor: this.engine.state.cursor, ...(blockEntries ? { blockEntries } : {}) });
      } catch (error) { failure = error; }
      if (!fatal(failure)) await this.expertBar(row, blockEntries);
      if (failure) throw failure;
    })).catch(error => {
      if (fatal(error)) return this.die(error);
      this.counters.rejectedRows++; this.log(`Bar ${row.timestamp} not applied: ${error.message}`);
    });
  }
  async expertBar(row, blockEntries) {
    const engine = this.expertEngine();
    if (!engine) return;
    try {
      engine.appendBar(row);
      await engine.step({ runId: engine.state.runId, expectedCursor: engine.state.cursor, ...(blockEntries ? { blockEntries } : {}) });
    } catch (error) {
      if (this.expertFault(error)) return;
      this.expertError(error, `Expert bar ${row.timestamp} not applied`);
      // Keep the expert cursor on its own dataset so the next bar can step.
      try { engine.catchUp(); } catch (catchUpError) { if (!this.expertFault(catchUpError)) this.log(`Expert catch-up failed: ${catchUpError.message}`); }
      return;
    }
    try {
      const daily = engine.store.dailyFor(this.day), history = engine.state.dataset.slice(0, -1);
      for (const symbol of Object.keys(row.bars).sort()) {
        if (this.anomalyCalls >= engine.state.settings.expert.maxResearchPerSession) break;
        if (!isAnomaly(row.bars[symbol], history.map(prior => prior.bars[symbol]).filter(Boolean), daily[symbol] ?? [], this.barMinutes())) continue;
        this.anomalyCalls++;
        this.expertTask = this.expertTask.then(() => this.research([symbol]));
      }
    } catch (error) { this.expertError(error, `Anomaly scan after ${row.timestamp} failed`); }
  }
  // Scan at 08:15 IST, research at 08:30, theses at 08:45, each once per session day and in that order; a later start runs them at warmup.
  scheduleMorning() {
    if (!this.builder) return;
    const minutes = istMinutes(this.now());
    if (this.engine.state.settings.scan.enabled && !this.scanStarted && minutes >= SCAN_AT) { this.scanStarted = true; this.expertTask = this.expertTask.then(() => this.scanPass()); }
    if (!this.expertEngine()) return;
    if (!this.researchStarted && minutes >= RESEARCH_AT) { this.researchStarted = true; this.expertTask = this.expertTask.then(() => this.researchPass()); }
    if (!this.thesesStarted && minutes >= THESES_AT) { this.thesesStarted = true; this.expertTask = this.expertTask.then(() => this.thesesPass()); }
  }
  async researchPass() {
    const engine = this.expertEngine(), day = this.day;
    if (!engine) return;
    try {
      if (!engine.store.researchDone(day)) { await this.research([...this.symbols(), 'MARKET']); engine.store.markResearchDone(day); }
      this.researchDone = true;
    } catch (error) { this.log(`Research pass failed: ${error.message}`); }
  }
  async thesesPass() {
    const engine = this.expertEngine(), day = this.day, symbols = this.symbols();
    if (!engine) return;
    try {
      const stored = engine.store.thesesFor(day);
      // Pass start, not the prior session's last bar, so the morning's research is visible and citable; later bars see it via createdAt.
      const asOf = new Date(Math.max(Date.parse(engine.state.dataset.at(-1).timestamp), this.now())).toISOString();
      if (!symbols.every(symbol => stored[symbol])) await this.expert.theses({ symbols, day, asOf, state: engine.state });
      this.thesesDone = true;
    } catch (error) { if (!this.expertFault(error)) this.log(`Theses failed: ${error.message}`); }
  }
  // One call per target; a failure marks that target's coverage missing and never throws. Results reach only the expert book (the rules book stays Phase 1), through the serial queue.
  async research(targets) {
    const records = [];
    for (const symbol of targets) {
      try { records.push(...(await this.expert.research({ symbol, now: this.now })).records); this.coverageMissing.delete(symbol); }
      catch (error) { this.coverageMissing.add(symbol); this.log(`Research for ${symbol} failed; coverage missing: ${error.message}`); }
    }
    if (!records.length) return;
    this.pending = this.pending.then(() => this.run(() => { const expert = this.expertEngine(); if (expert) this.mergeIntelligence(expert, records); }))
      .catch(error => { if (!this.expertFault(error)) this.log(`Research not applied to the expert book: ${error.message}`); });
    return this.pending;
  }
  // Drops records whose id the engine already has, and any that would make its record set invalid (which would veto every entry).
  mergeIntelligence(engine, records) {
    const merged = [...(engine.state.intelligenceRecords ?? [])], ids = new Set(merged.map(item => item.id));
    for (const item of records) {
      if (ids.has(item.id)) continue;
      try { validateIntelligence([...merged, item]); merged.push(item); ids.add(item.id); } catch (error) { this.log(`Research record ${item.id} dropped: ${error.message}`); }
    }
    if (merged.length > (engine.state.intelligenceRecords ?? []).length) engine.setIntelligence(merged);
  }
  poll() {
    const now = this.now(), window = this.sessionWindow;
    if (!window || !['live', 'disconnected', 'login-needed'].includes(this.state)) return;
    this.scheduleMorning();
    if (this.state === 'live' && this.builder) {
      const row = this.builder.flush(now);
      if (row) this.handleRow(row);
    } else {
      // No prices means no protection: record each bar period that passed without data, up to the close, instead of fabricating a bar.
      const barMs = this.barMinutes() * 60_000;
      this.gapBarEnd ??= this.builder?.current?.end ?? Math.min(window.openMs + Math.ceil((Math.max(now, window.openMs + 1) - window.openMs) / barMs) * barMs, window.closeMs);
      while (this.gapBarEnd <= window.closeMs && now >= this.gapBarEnd + FLUSH_GRACE_MS) {
        const barEnd = new Date(this.gapBarEnd).toISOString();
        this.gapBarEnd = this.gapBarEnd < window.closeMs ? Math.min(this.gapBarEnd + barMs, window.closeMs) : Infinity;
        this.pending = this.pending.then(() => this.run(() => this.engine.store.append('protection-gap', { barEnd, positions: this.engine.state.positions.map(p => p.symbol) })))
          .catch(error => this.log(`Gap record failed: ${error.message}`));
      }
      // Retries are driven from here: after the first connection the SDK reports a failed attempt only as an error, never a close.
      if (this.state === 'disconnected' && now < window.closeMs && now >= this.nextAttemptAt) {
        this.nextAttemptAt = now + Math.min(2 ** this.reconnects++, MAX_BACKOFF_S) * 1000;
        this.connect();
      }
    }
    if (now >= window.closeMs + FLUSH_GRACE_MS && !(this.state === 'live' && this.builder?.current)) {
      this.state = 'closed'; this.stopTimers(); this.source.stop(); this.writeReport();
    }
  }
  onClose(reason) {
    this.cleanBarsSinceGap = 0; this.counters.disconnects++;
    if (reason === 'expired') { this.state = 'login-needed'; return; }
    if (this.state !== 'live') return;
    this.state = 'disconnected';
    this.nextAttemptAt = this.now() + Math.min(2 ** this.reconnects++, MAX_BACKOFF_S) * 1000;
  }
  // After a restart or a missed close, write the last live session's report if it is missing; its counters are incomplete.
  backfillReport(today) {
    if (!this.isLive()) return;
    const lastLive = this.engine.state.dataset.findLast(row => row.source === 'ticks' || row.source === 'thin');
    if (!lastLive) return;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(lastLive.timestamp));
    const sessionOver = !today || day < today.day || this.now() >= today.closeMs;
    if (!sessionOver || this.engine.store.hasDailyReport(day)) return;
    if (day !== this.day) this.resetDay(day);
    this.partial = true;
    this.writeReport();
  }
  writeReport() {
    const c = this.status().counters, day = this.day;
    const dataQuality = { ticks: c.ticks, dropped: c.dropped ?? 0, outsideSession: c.outsideSession ?? 0, thinBars: c.thinBars ?? 0, badTicks: c.badTicks,
      rejectedRows: c.rejectedRows, disconnects: c.disconnects, barsToday: this.barsToday, skewed: this.skewed, loginAt: this.session.status().issuedAt ?? null };
    dataQuality.partial = this.partial;
    dataQuality.flagged = dataQuality.partial || dataQuality.thinBars > 0.2 * this.barsToday || dataQuality.dropped > 0.01 * dataQuality.ticks || dataQuality.skewed || dataQuality.rejectedRows > 0;
    this.pending = this.pending.then(() => this.run(() => this.engine.dailyReport(day, dataQuality))).catch(error => this.log(`Daily report failed: ${error.message}`));
    if (!this.expertEngine()) return;
    this.pending = this.pending.then(() => this.run(() => this.expert.scoring(day, { ...dataQuality, expertRejectedRows: c.expertRejectedRows })))
      .catch(error => { if (!this.expertFault(error)) this.log(`Expert report failed: ${error.message}`); });
  }
  later(fn, ms) {
    if (this.intervalMs <= 0) return;
    const id = setTimeout(fn, ms); id.unref?.(); this.timers.push(() => clearTimeout(id));
  }
  die(error) { this.stop(); this.onFatal(error); return this.status(); }
  stopTimers() { for (const clear of this.timers.splice(0)) clear(); }
  stop() { this.stopTimers(); this.source.stop(); this.state = 'idle'; }
  async idle() { await this.expertTask; return this.pending; }
  status() {
    return { state: this.state, day: this.day, lastTickAt: this.lastTickAt ? new Date(this.lastTickAt).toISOString() : null, barsToday: this.barsToday, scanDone: this.scanDone,
      counters: { ...this.counters, ...(this.builder?.counters ?? {}) }, cleanBarsSinceGap: this.cleanBarsSinceGap, skewed: this.skewed,
      ...(this.expert && { expert: { enabled: true, researchDone: this.researchDone, thesesDone: this.thesesDone, anomalyCalls: this.anomalyCalls,
        limitUntil: this.expert.decider?.limitUntil ? new Date(this.expert.decider.limitUntil).toISOString() : null, coverageMissing: [...this.coverageMissing].sort(), halted: this.expertHalted } }) };
  }
}

export function replayCapture(path) {
  return {
    start: handlers => { for (const line of readFileSync(path, 'utf8').split('\n')) if (line) handlers.onTick(JSON.parse(line)); },
    stop: () => {},
  };
}
