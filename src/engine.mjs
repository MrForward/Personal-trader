import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, validateSettings } from './config.mjs';
import { STRATEGIES, analyzeMarket, chooseStrategy, evaluateStrategy } from './strategies.mjs';
import { makeDemoSeries, DEMO_ASSETS } from './demo-data.mjs';
import { reviewMarket, providerStatus } from './models.mjs';
import { validateDataset, parseCsv, validateBar } from './dataset.mjs';
import { charges, perShareRate, INTRADAY_OF } from './costs.mjs';
import { redact } from './secrets.mjs';

const money = n => Math.round(n * 100) / 100;
const clone = value => structuredClone(value);
const SESSION_TIMEZONE = 'Asia/Kolkata';
const fillLabel = row => row.source === 'ticks' ? 'observed-open' : 'assumed-open';
const BAR_SOURCES = new Set(['ticks', 'thin', 'historical']);
const sessionDay = stamp => new Intl.DateTimeFormat('en-CA', { timeZone: SESSION_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(stamp));
export const INITIAL_CURSOR = 29;

function benchmark(capital, capped) {
  return { cash: capital, positions: [], fees: 0, pending: true, capped,
    label: capped ? 'Capped buy-and-hold comparison' : 'Fully allocated buy-and-hold comparison',
    note: 'Next-open entry; same fees/slippage as paper trades. Static buy-and-hold: no strategy exits, stops, rebalancing or model fees. Open holdings are marked without hypothetical liquidation costs.' };
}
function newState(settings, dataset, assets, source, records) {
  const capital = settings.simulation.startingCapital;
  return {
    mode: 'paper', currency: 'INR', dataSource: source, status: 'paused', runId: randomUUID(),
    settings: clone(settings), dataset, assets, cursor: INITIAL_CURSOR, cash: capital, peakEquity: capital,
    realizedPnl: 0, fees: 0, positions: [], decisions: [], trades: [], equityHistory: [],
    benchmark: benchmark(capital, false), cappedBenchmark: benchmark(capital, true),
    configHistory: [{ version: settings.version, timestamp: new Date().toISOString(), settings: clone(settings), note: 'Initial paper settings; examples, not a live loss mandate.' }],
    intelligenceRecords: records ?? null, riskLatched: false, maxDrawdownPct: 0, lastError: null,
    sessionDay: sessionDay(dataset[INITIAL_CURSOR].timestamp), sessionStartingEquity: capital,
  };
}
function mark(state, row, field = 'close') {
  let exposure = 0;
  for (const p of state.positions) {
    p.markPrice = row.bars[p.symbol][field];
    p.unrealizedPnl = (p.markPrice - p.entryPrice) * p.quantity - p.entryFee;
    exposure += p.quantity * p.markPrice;
  }
  const equity = state.cash + exposure;
  state.peakEquity = Math.max(state.peakEquity, equity);
  const drawdown = state.peakEquity ? 100 * (state.peakEquity - equity) / state.peakEquity : 0;
  state.maxDrawdownPct = Math.max(state.maxDrawdownPct, drawdown);
  const dailyLoss = state.sessionStartingEquity > 0 ? Math.max(0, 100 * (state.sessionStartingEquity - equity) / state.sessionStartingEquity) : 0;
  const bookValue = book => book.cash + book.positions.reduce((sum, p) => sum + p.quantity * row.bars[p.symbol][field], 0);
  state.metrics = {
    equity: money(equity), cash: money(state.cash), realizedPnl: money(state.realizedPnl),
    unrealizedPnl: money(state.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0)),
    netReturnPct: 100 * (equity / state.settings.simulation.startingCapital - 1), maxDrawdownPct: state.maxDrawdownPct,
    currentDrawdownPct: drawdown, dailyLossPct: dailyLoss, sessionDay: state.sessionDay, sessionTimezone: SESSION_TIMEZONE,
    sessionStartingEquity: money(state.sessionStartingEquity), exposurePct: equity > 0 ? 100 * exposure / equity : 0,
    tradeCount: state.trades.length, fees: money(state.fees), benchmarkEquity: money(bookValue(state.benchmark)),
    cappedBenchmarkEquity: money(bookValue(state.cappedBenchmark)),
  };
  return { equity, exposure, drawdown, dailyLoss };
}
function checkRisk(state, row, field = 'close') {
  const values = mark(state, row, field);
  if (values.drawdown >= state.settings.risk.maxDrawdownPct || values.dailyLoss >= state.settings.risk.maxDailyLossPct) {
    state.riskLatched = true;
    state.lastError = values.drawdown >= state.settings.risk.maxDrawdownPct ? 'Configured drawdown cap reached; new entries are blocked.' : 'Configured daily loss cap reached; new entries are blocked.';
  }
  if (state.riskLatched) state.status = 'risk-paused';
  return values;
}
const storageFailure = error => ['PERSISTENCE_ERROR', 'STALE_STATE'].includes(error?.code);
function safeMessage(error) {
  return redact(error instanceof Error ? error.message : 'Model review failed.').slice(0, 1000);
}

export class TradingEngine {
  constructor(store, { reviewer = reviewMarket, allowPaidCalls = false, intelligenceProvider = null } = {}) {
    this.store = store; this.reviewer = reviewer; this.allowPaidCalls = allowPaidCalls === true; this.intelligenceProvider = intelligenceProvider; this.busy = false;
    this.state = store.load() ?? newState(DEFAULT_SETTINGS, makeDemoSeries(), DEMO_ASSETS, 'synthetic demo');
    // Compatible with paused draft state: new fields are explicit paper defaults.
    this.state.settings.risk.maxDailyLossPct ??= DEFAULT_SETTINGS.risk.maxDailyLossPct;
    this.state.settings.universe ??= DEFAULT_SETTINGS.universe; this.state.settings.barMinutes ??= DEFAULT_SETTINGS.barMinutes;
    this.state.settings.simulation.costSchedule ??= DEFAULT_SETTINGS.simulation.costSchedule; delete this.state.settings.simulation.feeBps;
    this.state.settings.simulation.fixedCostsPerMonthInr ??= DEFAULT_SETTINGS.simulation.fixedCostsPerMonthInr; this.state.settings.simulation.spendCapPerMonthInr ??= DEFAULT_SETTINGS.simulation.spendCapPerMonthInr;
    this.state.settings.expert ??= clone(DEFAULT_SETTINGS.expert);
    this.state.cappedBenchmark ??= benchmark(this.state.settings.simulation.startingCapital, true);
    this.state.riskLatched ??= this.state.status === 'risk-paused';
    this.state.sessionDay ??= sessionDay(this.state.dataset[this.state.cursor].timestamp);
    this.state.sessionStartingEquity ??= this.state.cash + this.state.positions.reduce((sum, p) => sum + p.quantity * this.state.dataset[this.state.cursor].bars[p.symbol].close, 0);
    if (this.state.status === 'running' || this.state.status === 'error-paused') this.state.status = 'paused';
    delete this.state.persistenceFault;
    this.updateMetrics();
    this.store.save(this.state, 'startup', { mode: 'paper', status: this.state.status, cursor: this.state.cursor });
  }
  histories(symbol, cursor = this.state.cursor, state = this.state) { return state.dataset.slice(0, cursor + 1).map(row => row.bars[symbol]); }
  updateMetrics() { return checkRisk(this.state, this.state.dataset[this.state.cursor]); }
  assertMutable() {
    if (this.busy) throw new Error('Engine is busy; wait for the current mutation to finish.');
  }
  exclusive(fn) { this.assertMutable(); this.busy = true; try { return fn(); } finally { this.busy = false; } }
  async exclusiveAsync(fn) { this.assertMutable(); this.busy = true; try { return await fn(); } finally { this.busy = false; } }
  commit(next, kind, detail = {}, { archive } = {}) {
    const previous = this.state;
    checkRisk(next, next.dataset[next.cursor]);
    try {
      if (archive) this.store.archiveAndSave(archive, next, kind, detail);
      else this.store.save(next, kind, detail);
    } catch (error) {
      this.state = clone(previous);
      this.state.status = 'error-paused'; this.state.persistenceFault = true;
      this.state.lastError = 'Persistence failed. No in-memory trade or cursor advance was retained. Reload or reset before resuming.';
      throw error;
    }
    this.state = next;
    return { ...this.snapshot(), busy: false };
  }
  intelligence(symbol, state = this.state) {
    if (!this.intelligenceProvider) return { records: [], entryBlocked: false, blockReasons: [], coverage: 'No intelligence provider connected.' };
    try {
      const result = this.intelligenceProvider({ symbol, asOf: state.dataset[state.cursor].timestamp, records: state.intelligenceRecords, state });
      if (!result || typeof result.entryBlocked !== 'boolean' || !Array.isArray(result.blockReasons)) throw new Error('Invalid intelligence context.');
      return result;
    } catch (error) {
      return { records: [], entryBlocked: true, blockReasons: ['Intelligence context is unavailable; new entries are blocked.'], limitations: [safeMessage(error)] };
    }
  }
  context(symbol, state = this.state) {
    const history = this.histories(symbol, state.cursor, state), features = analyzeMarket(history);
    const candidates = state.settings.strategy.enabled.map(id => evaluateStrategy(id, history, state.positions.some(p => p.symbol === symbol)));
    return { symbol, asOf: state.dataset[state.cursor].timestamp, source: state.dataSource, features,
      portfolio: { cash: money(state.cash), equity: state.metrics.equity, position: clone(state.positions.find(p => p.symbol === symbol) ?? null) },
      enabledStrategies: state.settings.strategy.enabled, rulesChoice: chooseStrategy(features, state.settings.strategy.enabled), candidates,
      risk: clone(state.settings.risk), intelligence: clone(this.intelligence(symbol, state)) };
  }
  snapshot() {
    const s = this.state, row = s.dataset[s.cursor];
    const { dataset, benchmark: full, cappedBenchmark: capped, intelligenceRecords, ...publicState } = s;
    const compare = book => ({ label: book.label, note: book.note, fees: money(book.fees ?? 0),
      exposurePct: s.metrics.equity > 0 ? 100 * book.positions.reduce((sum, p) => sum + p.quantity * row.bars[p.symbol].close, 0) / (book.cash + book.positions.reduce((sum, p) => sum + p.quantity * row.bars[p.symbol].close, 0)) : 0 });
    return clone({ ...publicState, busy: this.busy,
      decisions: s.decisions.slice(-300).reverse(), trades: s.trades.slice(-300).reverse(), strategies: STRATEGIES, providerStatus: providerStatus(),
      market: s.assets.map(asset => ({ ...asset, price: row.bars[asset.symbol].close,
        changePct: 100 * (row.bars[asset.symbol].close / s.dataset[s.cursor - 1].bars[asset.symbol].close - 1), regime: analyzeMarket(this.histories(asset.symbol)).regime })),
      run: { cursor: s.cursor, total: s.dataset.length, timestamp: row.timestamp, lastBarSource: s.dataset.at(-1).source ?? null },
      modelUsage: { callsToday: this.store.callCount(), limit: s.settings.model.dailyCallLimit, resetTimezone: 'UTC', paidCallsEnabled: this.allowPaidCalls },
      intelligence: { contexts: s.assets.map(asset => ({ symbol: asset.symbol, ...this.intelligence(asset.symbol) })), mode: 'captured fixtures / imported evidence', networkConnected: false },
      benchmarks: { full: compare(full), capped: compare(capped) }, archivedRuns: this.store.archiveCount(),
      kite: { connected: false, liveTrading: false, requirements: ['Kite API app authorization', 'Daily broker login', 'Whitelisted static IP for future live orders', 'Explicit live capital and loss mandate'] },
    });
  }
  settings(input) { return this.exclusive(() => {
    if (this.state.persistenceFault) throw new Error('Reload or reset after the storage failure before changing settings.');
    const nextSettings = validateSettings(input, this.state.settings);
    const next = clone(this.state);
    if ((JSON.stringify(nextSettings.universe) !== JSON.stringify(next.settings.universe) || nextSettings.barMinutes !== next.settings.barMinutes) && next.positions.length) throw new Error('Close open positions before changing the universe or bar size.');
    if (nextSettings.simulation.startingCapital !== next.settings.simulation.startingCapital) {
      if (next.cursor > INITIAL_CURSOR || next.trades.length || next.positions.length) throw new Error('Reset the paper run before changing starting capital.');
      const fresh = newState(nextSettings, next.dataset, next.assets, next.dataSource, next.intelligenceRecords);
      fresh.configHistory = next.configHistory;
      Object.assign(next, fresh);
    }
    next.settings = nextSettings;
    next.configHistory.push({ version: nextSettings.version, timestamp: new Date().toISOString(), settings: clone(nextSettings), note: 'Entry settings apply to new positions. Existing positions retain entry strategy/stops; portfolio loss caps are checked immediately and cannot clear a latched breach.' });
    checkRisk(next, next.dataset[next.cursor]);
    return this.commit(next, 'settings', { version: nextSettings.version });
  }); }
  control(action) { return this.exclusive(() => {
    const next = clone(this.state);
    if (action === 'reset') {
      const fresh = newState(next.settings, next.dataset, next.assets, next.dataSource, next.intelligenceRecords);
      return this.commit(fresh, 'reset', { runId: fresh.runId }, { archive: this.state });
    }
    if (next.persistenceFault) throw new Error('Reload or reset after the storage failure before resuming.');
    if (next.mode === 'prospective-paper' && (action === 'start' || action === 'pause')) throw new Error('This run is driven by the live feed; reset to return to replay.');
    if (action === 'start') {
      checkRisk(next, next.dataset[next.cursor]);
      if (next.riskLatched) throw new Error('Loss cap is latched. Protective steps remain available; reset before a new experiment.');
      if (next.cursor >= next.dataset.length - 1) throw new Error('Replay is complete. Reset to run it again.');
      next.status = 'running';
    } else if (action === 'pause') next.status = next.riskLatched ? 'risk-paused' : 'paused';
    else throw new Error('Unknown control action.');
    return this.commit(next, action, { runId: next.runId });
  }); }
  importDataset(input) { return this.exclusive(() => {
    if (this.state.status === 'running') throw new Error('Pause replay before importing data.');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['rows', 'csv', 'name'].includes(key)) || (Object.hasOwn(input, 'csv') === Object.hasOwn(input, 'rows'))) throw new Error('Provide one dataset as rows or CSV.');
    const parsed = Object.hasOwn(input, 'csv') ? parseCsv(input.csv) : validateDataset(input.rows);
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 100) : 'User dataset';
    const fresh = newState(this.state.settings, parsed.rows, parsed.symbols.map(symbol => ({ symbol, name: symbol, sector: 'Imported' })), `imported historical data: ${name}`, []);
    return this.commit(fresh, 'dataset-import', { name, timestamps: parsed.rows.length, symbols: parsed.symbols }, { archive: this.state });
  }); }
  beginLive({ rows, assets, source }) { return this.exclusive(() => {
    if (!Array.isArray(rows) || rows.length <= INITIAL_CURSOR || !Array.isArray(assets) || !assets.length || typeof source !== 'string') throw new Error('Live start needs warmup rows, assets and a source label.');
    // Warmup rows come from the broker; validate them like an import. Every warmup row is historical by definition.
    const dataset = validateDataset(rows.map(({ source: _source, ...row }) => row)).rows.map(row => ({ ...row, source: 'historical' }));
    const fresh = newState(this.state.settings, dataset, assets, source, []);
    fresh.mode = 'prospective-paper'; fresh.status = 'live'; fresh.liveBarMinutes = this.state.settings.barMinutes; fresh.cursor = dataset.length - 1;
    fresh.sessionDay = sessionDay(dataset[fresh.cursor].timestamp);
    return this.commit(fresh, 'live-begin', { runId: fresh.runId, source, rows: dataset.length, symbols: assets.map(asset => asset.symbol) }, { archive: this.state });
  }); }
  appendBar(row) { return this.exclusive(() => {
    if (this.state.persistenceFault) throw new Error('Reload or reset after the storage failure.');
    const last = this.state.dataset.at(-1);
    if (!row || typeof row !== 'object' || typeof row.timestamp !== 'string' || !(Date.parse(row.timestamp) > Date.parse(last.timestamp))) throw new Error('Bar timestamp must follow the last bar.');
    const symbols = this.state.assets.map(asset => asset.symbol).sort();
    if (!row.bars || typeof row.bars !== 'object' || JSON.stringify(Object.keys(row.bars).sort()) !== JSON.stringify(symbols)) throw new Error('Bar must contain every universe symbol.');
    const time = Date.parse(row.timestamp), timestamp = new Date(time).toISOString();
    const bars = Object.fromEntries(symbols.map(symbol => [symbol, validateBar(symbol, row.bars[symbol], time)]));
    const next = clone(this.state);
    next.dataset.push({ timestamp, closed: true, source: BAR_SOURCES.has(row.source) ? row.source : 'assumed', bars });
    return this.commit(next, 'bar-append', { timestamp, source: next.dataset.at(-1).source, total: next.dataset.length });
  }); }
  catchUp() { return this.exclusive(() => {
    if (this.state.persistenceFault) throw new Error('Reload or reset after the storage failure.');
    const skipped = this.state.dataset.length - 1 - this.state.cursor;
    if (skipped <= 0) return { ...this.snapshot(), busy: false };
    const next = clone(this.state), previous = next.dataset[next.cursor], latest = next.dataset.at(-1);
    const day = sessionDay(latest.timestamp);
    if (day !== next.sessionDay) { next.sessionDay = day; next.sessionStartingEquity = mark(next, previous).equity; }
    next.cursor = next.dataset.length - 1;
    // No decisions on bars nobody watched; held positions meet their stops at the next observed open.
    return this.commit(next, 'catch-up', { skipped, from: previous.timestamp, to: latest.timestamp, positions: next.positions.map(p => p.symbol) });
  }); }
  setIntelligence(records) { return this.exclusive(() => {
    if (!Array.isArray(records)) throw new Error('Intelligence records must be a validated array.');
    if (this.state.persistenceFault) throw new Error('Reload or reset after the storage failure.');
    const next = clone(this.state); next.intelligenceRecords = clone(records);
    return this.commit(next, 'intelligence-import', { records: records.length });
  }); }
  tightenStop(id, input) { return this.exclusive(() => {
    if (this.state.persistenceFault) throw new Error('Reload or reset after the storage failure.');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'stopPrice')) throw new Error('Provide only stopPrice.');
    const next = clone(this.state), p = next.positions.find(position => position.id === id);
    if (!p) throw new Error('Position not found.');
    const stop = input.stopPrice;
    if (typeof stop !== 'number' || !Number.isFinite(stop) || stop <= 0 || stop >= p.markPrice) throw new Error('Stop must be positive and below the current mark price.');
    if (stop < p.stopPrice) throw new Error('Existing stops may only be tightened.');
    const previous = p.stopPrice; p.stopPrice = stop; p.stopRevisions ??= [];
    p.stopRevisions.push({ timestamp: new Date().toISOString(), previous, next: stop, source: 'user' });
    return this.commit(next, 'stop-change', { positionId: id, previous, next: stop });
  }); }
  async callReviewer(symbol, state, capturedContext = this.context(symbol, state)) {
    const config = state.settings.model;
    if (config.provider !== 'rules' && !this.allowPaidCalls) throw new Error('Paid model calls are disabled for this local paper phase.');
    let callId;
    if (config.provider !== 'rules') callId = this.store.reserveCall(config);
    let result;
    try {
      result = await this.reviewer({ model: clone(config), context: capturedContext });
      if (!result || !['none', ...state.settings.strategy.enabled].includes(result.strategyId)) throw new Error('Reviewer selected an unsupported strategy.');
    }
    catch (error) { if (callId) this.store.finishCall(callId, 'failed'); throw error; }
    if (callId) this.store.finishCall(callId, 'completed', result.usage);
    return result;
  }
  async review(symbol) { return this.exclusiveAsync(async () => {
    if (this.state.persistenceFault) throw new Error('Reload or reset after the storage failure.');
    if (!this.state.assets.some(asset => asset.symbol === symbol)) throw new Error('Unknown symbol.');
    try {
      const captured = this.context(symbol), result = await this.callReviewer(symbol, this.state, captured);
      this.commit(clone(this.state), 'model-review', { symbol, ...result, inputSnapshot: captured });
      return result;
    } catch (error) {
      if (storageFailure(error) || this.state.persistenceFault) {
        this.state.status = 'error-paused'; this.state.persistenceFault = true; this.state.lastError = 'Storage failure; reload or reset before proceeding.';
        throw error;
      }
      this.commit(clone(this.state), 'model-error', { symbol, reason: safeMessage(error) });
      throw error;
    }
  }); }
  sell(state, position, price, row, reason, phase) {
    const timestamp = row.timestamp, fill = price * (1 - state.settings.simulation.slippageBps / 10000);
    const schedule = state.settings.simulation.costSchedule, quantity = position.quantity;
    let cost;
    if (sessionDay(position.openedAt) === sessionDay(timestamp)) {
      // Same-session round trip: Zerodha charges intraday rates on both legs. The buy was charged delivery rates when it
      // happened, so the sell carries the difference; total fees then equal the intraday buy plus intraday sell.
      const intraday = INTRADAY_OF[schedule];
      const sellLeg = charges({ schedule: intraday, side: 'SELL', price: fill, quantity, dpApplies: false });
      const buyAdjustment = money(charges({ schedule: intraday, side: 'BUY', price: position.entryPrice, quantity, dpApplies: false }).total - position.entryFee);
      cost = { ...sellLeg, buyAdjustment, total: money(sellLeg.total + buyAdjustment) };
    } else {
      const dpApplies = !state.trades.some(t => t.action === 'SELL' && t.symbol === position.symbol && sessionDay(t.timestamp) === sessionDay(timestamp));
      cost = charges({ schedule, side: 'SELL', price: fill, quantity, dpApplies });
    }
    const fee = cost.total;
    const pnl = (fill - position.entryPrice) * position.quantity - fee - position.entryFee;
    state.cash += fill * position.quantity - fee; state.fees += fee; state.realizedPnl += pnl;
    state.trades.push({ id: randomUUID(), timestamp, phase, symbol: position.symbol, action: 'SELL', quantity: position.quantity, price: fill, fee, charges: cost, fill: fillLabel(row),
      realizedPnl: pnl, reason, strategyId: position.strategyId, configVersion: position.configVersion });
    state.positions = state.positions.filter(p => p.id !== position.id);
  }
  initializeBenchmarks(state, row) {
    for (const book of [state.benchmark, state.cappedBenchmark]) {
      if (!book.pending) continue;
      const capital = state.settings.simulation.startingCapital;
      const fraction = book.capped ? Math.min(state.settings.risk.maxExposurePct / 100 / state.assets.length, state.settings.risk.maxPositionPct / 100) : 1 / state.assets.length;
      for (const asset of state.assets) {
        const price = row.bars[asset.symbol].open * (1 + state.settings.simulation.slippageBps / 10000), schedule = state.settings.simulation.costSchedule;
        const quantity = Math.floor(capital * fraction / (price * (1 + perShareRate(schedule, 'BUY'))));
        const fee = charges({ schedule, side: 'BUY', price, quantity, dpApplies: false }).total;
        book.positions.push({ symbol: asset.symbol, quantity, entryPrice: price });
        book.cash -= quantity * price + fee; book.fees += fee;
      }
      book.pending = false; book.entryTimestamp = row.timestamp; book.configVersion = state.settings.version;
    }
  }
  async step(options = {}) { return this.exclusiveAsync(async () => {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['runId', 'expectedCursor', 'blockEntries'].includes(key))
      || options.blockEntries !== undefined && (typeof options.blockEntries !== 'string' || !options.blockEntries)
      || options.expectedCursor !== undefined && (!Number.isInteger(options.expectedCursor) || options.expectedCursor < INITIAL_CURSOR)
      || options.runId !== undefined && typeof options.runId !== 'string') throw new Error('Invalid replay step identity.');
    if (this.state.persistenceFault) throw new Error('Reload or reset after the storage failure before stepping.');
    if (options.runId !== undefined && options.runId !== this.state.runId || options.expectedCursor !== undefined && options.expectedCursor !== this.state.cursor) throw new Error('Stale replay step; the run or cursor has changed.');
    if (this.state.cursor >= this.state.dataset.length - 1) return { ...this.snapshot(), busy: false };
    const s = clone(this.state), next = s.dataset[s.cursor + 1], previous = s.dataset[s.cursor];
    try {
      checkRisk(s, previous);
      const proposals = [];
      for (const asset of s.assets) {
        const position = s.positions.find(p => p.symbol === asset.symbol);
        const captured = this.context(asset.symbol, s);
        let selected = position?.strategyId ?? (s.settings.strategy.mode === 'auto' ? captured.rulesChoice : s.settings.strategy.mode);
        let review, modelError;
        if (!position && !s.riskLatched && s.settings.strategy.mode === 'auto' && s.settings.model.provider !== 'rules') {
          try { review = await this.callReviewer(asset.symbol, s, captured); selected = review.strategyId; }
          catch (error) { if (storageFailure(error)) throw error; selected = 'none'; modelError = safeMessage(error); }
        }
        const candidate = evaluateStrategy(selected, this.histories(asset.symbol, s.cursor, s), Boolean(position));
        const decision = { id: randomUUID(), timestamp: previous.timestamp, executionTimestamp: next.timestamp, symbol: asset.symbol,
          action: candidate.action, strategyId: candidate.strategyId, reason: modelError ? `AI unavailable: ${modelError}. No new trade.` : candidate.reason,
          evidence: [...candidate.evidence, ...(review?.evidence ?? [])], counterEvidence: [...candidate.counterEvidence, ...(review?.counterEvidence ?? [])],
          provider: position ? 'rules' : s.settings.model.provider, model: position ? 'held entry-strategy rules' : s.settings.model.model || 'deterministic rules',
          configVersion: s.settings.version, positionConfigVersion: position?.configVersion ?? null, outcome: 'No order', modelSummary: review?.summary ?? null, inputSnapshot: captured };
        proposals.push({ asset, candidate, decision });
      }
      const day = sessionDay(next.timestamp);
      if (day !== s.sessionDay) { s.sessionDay = day; s.sessionStartingEquity = mark(s, previous).equity; }
      // Phase 1: all prices at the next open are observable; latch gap losses before exits/entries.
      checkRisk(s, next, 'open');
      this.initializeBenchmarks(s, next);
      for (const p of [...s.positions]) {
        const bar = next.bars[p.symbol], proposal = proposals.find(item => item.asset.symbol === p.symbol);
        if (bar.open <= p.stopPrice) { this.sell(s, p, bar.open, next, 'Gap protective stop', 'open'); proposal.decision.outcome = 'Gap stop filled'; }
        else if (bar.open >= p.takeProfitPrice) { this.sell(s, p, bar.open, next, 'Gap profit target', 'open'); proposal.decision.outcome = 'Gap target filled'; }
        else if (proposal.candidate.action === 'SELL') { this.sell(s, p, bar.open, next, proposal.candidate.reason, 'open'); proposal.decision.outcome = 'Paper strategy sell filled'; }
      }
      // Phase 2: every next-open entry precedes every intrabar exit. Later cash is unavailable here.
      for (const { asset, candidate, decision } of proposals) {
        const values = checkRisk(s, next, 'open');
        if (candidate.action !== 'BUY' || s.positions.some(p => p.symbol === asset.symbol)) continue;
        const intel = decision.inputSnapshot.intelligence;
        if (options.blockEntries) { decision.outcome = `Rejected: ${options.blockEntries}`; continue; }
        if (s.riskLatched) { decision.outcome = 'Rejected: latched portfolio loss cap'; continue; }
        if (intel?.entryBlocked) { decision.outcome = `Rejected: intelligence veto (${(intel.blockReasons ?? intel.entryBlockReasons ?? ['entry blocked']).join('; ')})`; continue; }
        const bar = next.bars[asset.symbol], price = bar.open * (1 + s.settings.simulation.slippageBps / 10000), risk = s.settings.risk, schedule = s.settings.simulation.costSchedule;
        const feeRate = perShareRate(schedule, 'BUY'), sellRate = perShareRate(schedule, 'SELL'), cashCost = price * (1 + feeRate), equityCost = cashCost - bar.open;
        const stopPrice = price * (1 - risk.stopLossPct / 100), stopFill = stopPrice * (1 - s.settings.simulation.slippageBps / 10000);
        const plannedLoss = price - stopFill + price * feeRate + stopFill * sellRate, dpCharge = charges({ schedule, side: 'SELL', price: 1, quantity: 1, dpApplies: true }).dp;
        const positionCap = risk.maxPositionPct / 100, exposureCap = risk.maxExposurePct / 100, riskCap = risk.riskPerTradePct / 100;
        let quantity = Math.max(0, Math.floor(Math.min(Number.MAX_SAFE_INTEGER, s.cash / cashCost,
          values.equity * positionCap / (price + positionCap * equityCost),
          (values.equity * exposureCap - values.exposure) / (bar.open + exposureCap * equityCost),
          values.equity * riskCap / (plannedLoss + riskCap * equityCost))));
        // The flat DP charge on the eventual sell is part of the planned loss; shrink the size if it breaks the risk budget.
        if (quantity && plannedLoss * quantity + dpCharge > values.equity * riskCap) quantity = Math.max(0, Math.floor((values.equity * riskCap - dpCharge) / plannedLoss));
        if (!quantity) { decision.outcome = 'Rejected: cash, allocation, exposure or planned risk limit'; continue; }
        const cost = charges({ schedule, side: 'BUY', price, quantity, dpApplies: false }), fee = cost.total;
        const p = { id: randomUUID(), symbol: asset.symbol, quantity, entryPrice: price, markPrice: bar.open, entryFee: fee, stopPrice,
          takeProfitPrice: price * (1 + risk.takeProfitPct / 100), trailingStopPct: risk.trailingStopPct, peakPrice: price,
          strategyId: candidate.strategyId, configVersion: s.settings.version, openedAt: next.timestamp };
        s.positions.push(p); s.cash -= quantity * price + fee; s.fees += fee;
        s.trades.push({ id: randomUUID(), timestamp: next.timestamp, phase: 'open', symbol: asset.symbol, action: 'BUY', quantity, price, fee, charges: cost, fill: fillLabel(next), realizedPnl: 0,
          strategyId: candidate.strategyId, configVersion: s.settings.version, reason: candidate.reason });
        decision.outcome = 'Paper buy filled';
      }
      // Phase 3: use the stop fixed at the bar open. If both levels touch, stop is first.
      for (const p of [...s.positions]) {
        const bar = next.bars[p.symbol];
        if (bar.low <= p.stopPrice) this.sell(s, p, p.stopPrice, next, 'Intrabar protective stop (stop first if both levels touch)', 'intrabar');
        else if (bar.high >= p.takeProfitPrice) this.sell(s, p, p.takeProfitPrice, next, 'Intrabar profit target', 'intrabar');
        else if (p.trailingStopPct > 0) {
          p.peakPrice = Math.max(p.peakPrice, bar.high);
          p.stopPrice = Math.max(p.stopPrice, p.peakPrice * (1 - p.trailingStopPct / 100));
          // The new trailing level becomes active only on the following bar.
        }
      }
      for (const { decision } of proposals) s.decisions.push(decision);
      s.cursor += 1; checkRisk(s, next);
      s.equityHistory.push({ timestamp: next.timestamp, equity: s.metrics.equity, benchmarkEquity: s.metrics.benchmarkEquity, cappedBenchmarkEquity: s.metrics.cappedBenchmarkEquity });
      if (!s.riskLatched && s.mode !== 'prospective-paper' && s.cursor >= s.dataset.length - 1) s.status = 'complete';
      return this.commit(s, 'step', { runId: s.runId, fromCursor: this.state.cursor, cursor: s.cursor, decisions: proposals.map(p => p.decision.id), phases: ['open exits', 'all open entries', 'intrabar exits', 'next-bar trailing update'] });
    } catch (error) {
      if (storageFailure(error) && !this.state.persistenceFault) { this.state.status = 'error-paused'; this.state.persistenceFault = true; this.state.lastError = 'Persistent storage failed; no paper step was retained. Reload or reset before continuing.'; }
      throw error;
    }
  }); }
  // shortcut: fixed costs prorated over 21 trading days a month; use actual invoices if a month's count matters.
  dailyReport(day, dataQuality = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Report day must be YYYY-MM-DD.');
    const s = this.state, sim = s.settings.simulation, perDay = sim.fixedCostsPerMonthInr / 21;
    const liveDays = [...new Set(s.dataset.filter(row => row.source === 'ticks' || row.source === 'thin').map(row => sessionDay(row.timestamp)))].filter(d => d <= day);
    const fixedCostsToDate = money(perDay * liveDays.length), monthToDateFixedCosts = money(perDay * liveDays.filter(d => d.slice(0, 7) === day.slice(0, 7)).length);
    const m = s.metrics;
    const payload = { day, mode: s.mode, runId: s.runId, configVersion: s.settings.version,
      equity: m.equity, cash: m.cash, realizedPnl: m.realizedPnl, unrealizedPnl: m.unrealizedPnl, fees: m.fees,
      positions: s.positions.map(p => ({ symbol: p.symbol, quantity: p.quantity, stopPrice: p.stopPrice, markPrice: p.markPrice })),
      tradesToday: s.trades.filter(trade => sessionDay(trade.timestamp) === day),
      benchmarkEquity: m.benchmarkEquity, cappedBenchmarkEquity: m.cappedBenchmarkEquity,
      tradingDays: liveDays.length, fixedCostsToDate, monthToDateFixedCosts, spendCap: sim.spendCapPerMonthInr,
      netAfterFixedCosts: money(m.equity - sim.startingCapital - fixedCostsToDate), dataQuality: clone(dataQuality) };
    this.store.saveDailyReport(day, payload);
    return payload;
  }
  export() { return clone({ exportedAt: new Date().toISOString(), ...this.state, audit: this.store.audit(), archivedRuns: this.store.archiveCount(), disclaimer: 'Paper execution only. OHLC fills are modeled, not live exchange fills; results are not a profitability claim.' }); }
}
