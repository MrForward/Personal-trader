// Folds live ticks into closed OHLCV bars aligned to the session open. One builder per session day.
const FLUSH_GRACE_MS = 30_000;

export class BarBuilder {
  constructor({ barMinutes = 15, symbols, session }) {
    if (!Array.isArray(symbols) || !symbols.length) throw new Error('BarBuilder needs symbols.');
    if (!session || !Number.isFinite(session.openMs) || !Number.isFinite(session.closeMs) || session.closeMs <= session.openMs) throw new Error('BarBuilder needs a session window.');
    this.barMs = barMinutes * 60_000; this.session = session;
    this.symbols = new Map(symbols.map(symbol => [symbol, { lastPrice: null, lastCumulative: 0, cumulativeAtBarStart: 0, ticked: false }]));
    this.current = null;
    this.counters = { ticks: 0, dropped: 0, outsideSession: 0, thinBars: 0, missingPrice: 0 };
  }
  seed(symbol, lastPrice) { this.symbols.get(symbol).lastPrice = lastPrice; }
  barAt(time) {
    const start = this.session.openMs + Math.floor((time - this.session.openMs) / this.barMs) * this.barMs;
    return { start, end: Math.min(start + this.barMs, this.session.closeMs) };
  }
  push({ symbol, price, cumulativeVolume, exchangeTime }) {
    const sym = this.symbols.get(symbol);
    if (!sym) throw new Error(`Unknown tick symbol: ${symbol}`);
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) throw new Error(`Invalid tick price for ${symbol}.`);
    if (typeof cumulativeVolume !== 'number' || !Number.isFinite(cumulativeVolume) || cumulativeVolume < 0) throw new Error(`Invalid tick volume for ${symbol}.`);
    if (!Number.isFinite(exchangeTime)) throw new Error(`Invalid tick time for ${symbol}.`);
    this.counters.ticks++;
    if (exchangeTime < this.session.openMs || exchangeTime >= this.session.closeMs) { this.counters.outsideSession++; return null; }
    let row = null;
    if (!this.current) this.current = this.barAt(exchangeTime);
    else if (exchangeTime < this.current.start) { this.counters.dropped++; return null; }
    else if (exchangeTime >= this.current.end) { row = this.close(); this.current = this.barAt(exchangeTime); }
    if (!sym.ticked) { sym.ticked = true; sym.open = sym.high = sym.low = price; }
    sym.high = Math.max(sym.high, price); sym.low = Math.min(sym.low, price); sym.close = price;
    sym.lastPrice = price; sym.lastCumulative = cumulativeVolume;
    return row;
  }
  flush(nowMs) {
    if (!this.current || nowMs < this.current.end + FLUSH_GRACE_MS) return null;
    const row = this.close();
    this.current = this.current.end < this.session.closeMs ? this.barAt(this.current.end) : null;
    return row;
  }
  close() {
    const timestamp = new Date(this.current.end).toISOString();
    let thin = false, missing = false;
    const bars = {};
    for (const [symbol, sym] of this.symbols) {
      if (sym.lastPrice === null) missing = true;
      else if (sym.ticked) bars[symbol] = { open: sym.open, high: sym.high, low: sym.low, close: sym.close, volume: sym.lastCumulative - sym.cumulativeAtBarStart, timestamp, closed: true };
      else { thin = true; bars[symbol] = { open: sym.lastPrice, high: sym.lastPrice, low: sym.lastPrice, close: sym.lastPrice, volume: 0, timestamp, closed: true }; }
      sym.ticked = false; sym.cumulativeAtBarStart = sym.lastCumulative;
    }
    if (missing) { this.counters.missingPrice++; return null; }
    if (thin) this.counters.thinBars++;
    return { timestamp, closed: true, source: thin ? 'thin' : 'ticks', bars };
  }
}
