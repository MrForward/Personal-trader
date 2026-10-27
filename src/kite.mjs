import { KiteConnect, KiteTicker } from 'kiteconnect';
import { registerSecret } from './secrets.mjs';
import { sessionFor } from './calendar.mjs';

const INTERVALS = { 5: '5minute', 15: '15minute', 60: '60minute', day: 'day' };
const istDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
const DAY_MS = 86_400_000;

// Kite personal tokens expire at 06:00 IST; the next expiry strictly after `now`.
function nextSixAmIst(now) {
  const ist = new Date(now + 5.5 * 3_600_000);
  const sixToday = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 0, 30);
  return sixToday > now ? sixToday : sixToday + DAY_MS;
}

export class KiteSession {
  constructor({ apiKey, apiSecret, store, now = Date.now, universe = () => [],
    makeClient = key => new KiteConnect({ api_key: key }),
    // reconnect:false keeps the SDK off its own retry path, which calls process.exit when retries run out; LiveRunner reconnects.
    makeTicker = (key, token) => new KiteTicker({ api_key: key, access_token: token, reconnect: false }) }) {
    if (!apiKey || !apiSecret) throw new Error('Kite API key and secret are required.');
    this.apiKey = apiKey; this.apiSecret = apiSecret; this.store = store; this.now = now; this.universe = universe; this.makeTicker = makeTicker;
    this.client = makeClient(apiKey);
    this.sdkTicker = null; this.handlers = null; this.expiredSignalled = false;
    const saved = store.loadKiteSession();
    if (saved) { registerSecret(saved.accessToken); this.client.setAccessToken(saved.accessToken); }
  }
  loginUrl() { return this.client.getLoginURL(); }
  // Stores every NSE token (equities and indices) so the watchlist can change between logins; the ticker subscribes only to the universe.
  async complete(requestToken, universe) {
    const result = await this.client.generateSession(requestToken, this.apiSecret);
    registerSecret(result.access_token);
    this.client.setAccessToken(result.access_token);
    // The SDK parses Kite's instrument CSV, so tokens arrive as strings; the WebSocket only honours numeric tokens.
    const listed = Object.fromEntries((await this.client.getInstruments('NSE')).map(item => [item.tradingsymbol, Number(item.instrument_token)]));
    const missing = universe.filter(symbol => !listed[symbol]);
    if (missing.length) throw new Error(`Unknown NSE symbols: ${missing.join(', ')}`);
    const now = this.now(), expiresAt = new Date(nextSixAmIst(now)).toISOString();
    this.store.saveKiteSession({ accessToken: result.access_token, userId: result.user_id, issuedAt: new Date(now).toISOString(), expiresAt, instruments: listed });
    // shortcut: the SDK keeps its socket and handlers at module level, so one ticker per process gets the new token in place.
    if (this.sdkTicker) this.sdkTicker.access_token = result.access_token;
    this.expiredSignalled = false;
    return { userId: result.user_id, expiresAt };
  }
  status() {
    const saved = this.store.loadKiteSession();
    if (!saved) return { state: 'none', userId: null, issuedAt: null, expiresAt: null, instruments: {} };
    return { state: this.now() < Date.parse(saved.expiresAt) ? 'valid' : 'expired', userId: saved.userId, issuedAt: saved.issuedAt, expiresAt: saved.expiresAt, instruments: saved.instruments };
  }
  invalidate() {
    const saved = this.store.loadKiteSession();
    if (saved) this.store.saveKiteSession({ ...saved, expiresAt: new Date(this.now()).toISOString() });
  }
  tokenFor(symbol) { return this.status().instruments[symbol]; }
  // Listed equity symbols from the login's instrument map: plain series only, no '-BE'/'-SM' style suffixes.
  equities() { return Object.keys(this.status().instruments).filter(symbol => /^[A-Z0-9&]+$/.test(symbol)); }
  // Last price, last session volume and average price per symbol, fetched 500 at a time (Kite's quote limit).
  async quotes(symbols) {
    const out = {};
    for (let i = 0; i < symbols.length; i += 500) {
      const batch = symbols.slice(i, i + 500), data = await this.client.getQuote(batch.map(symbol => `NSE:${symbol}`));
      for (const symbol of batch) {
        const q = data[`NSE:${symbol}`];
        if (q) out[symbol] = { price: q.last_price, volume: q.volume ?? 0, averagePrice: q.average_price ?? q.last_price };
      }
    }
    return out;
  }
  async historicalBars({ symbol, barMinutes, count, endMs }) {
    const interval = INTERVALS[barMinutes];
    if (!interval) throw new Error(`Unsupported bar size: ${barMinutes} minutes.`);
    const token = this.tokenFor(symbol);
    if (!token) throw new Error(`No instrument token for ${symbol}; log in again.`);
    const daily = barMinutes === 'day';
    const candles = await this.client.getHistoricalData(token, interval, new Date(endMs - (daily ? 120 : 10) * DAY_MS), new Date(endMs));
    const bars = [];
    if (daily) {
      // A day candle is stamped with its session date; it is only final once that session has closed.
      for (const candle of candles) {
        const date = istDate.format(new Date(candle.date));
        if (Date.parse(`${date}T15:30:00+05:30`) > endMs) continue;
        bars.push({ date, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume });
      }
      return bars.slice(-count);
    }
    for (const candle of candles) {
      const start = new Date(candle.date).getTime(), session = sessionFor(start);
      const end = Math.min(start + barMinutes * 60_000, session?.closeMs ?? Infinity);
      if (!Number.isFinite(start) || end > endMs) continue;
      bars.push({ timestamp: new Date(end).toISOString(), open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume });
    }
    return bars.slice(-count);
  }
  ticker() {
    return {
      start: handlers => {
        this.handlers = handlers;
        if (!this.sdkTicker) this.bindTicker();
        // The SDK's connect() is a no-op on an open socket, so a re-login or universe change must re-subscribe itself.
        if (this.sdkTicker.connected()) this.subscribeAll(); else this.sdkTicker.connect();
      },
      stop: () => { this.handlers = null; this.sdkTicker?.disconnect(); },
    };
  }
  bindTicker() {
    const t = this.makeTicker(this.apiKey, this.store.loadKiteSession()?.accessToken);
    this.sdkTicker = t;
    const live = () => { const all = this.status().instruments; return Object.fromEntries(this.universe().filter(symbol => all[symbol]).map(symbol => [symbol, all[symbol]])); };
    let subscribed = [];
    this.subscribeAll = () => {
      const list = Object.values(live()), gone = subscribed.filter(token => !list.includes(token));
      if (gone.length) t.unsubscribe(gone);
      t.subscribe(list); t.setMode(t.modeFull, list); subscribed = list;
    };
    const symbolOf = () => new Map(Object.entries(live()).map(([symbol, token]) => [token, symbol]));
    t.on('connect', () => this.subscribeAll());
    t.on('ticks', ticks => {
      const symbols = symbolOf();
      for (const tick of ticks) {
        const symbol = symbols.get(tick.instrument_token), time = tick.exchange_timestamp ? new Date(tick.exchange_timestamp).getTime() : NaN;
        if (!symbol || !Number.isFinite(time)) continue;
        this.handlers?.onTick({ symbol, price: tick.last_price, cumulativeVolume: tick.volume_traded ?? 0, exchangeTime: time });
      }
    });
    t.on('error', error => {
      if (/\b403\b/.test(String(error?.message ?? error))) { this.invalidate(); this.expiredSignalled = true; this.handlers?.onClose('expired'); }
      else this.handlers?.onError?.(error);
    });
    t.on('disconnect', () => { if (!this.expiredSignalled) this.handlers?.onClose('socket'); });
  }
}
