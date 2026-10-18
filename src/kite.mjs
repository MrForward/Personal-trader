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
  constructor({ apiKey, apiSecret, store, now = Date.now,
    makeClient = key => new KiteConnect({ api_key: key }),
    // reconnect:false keeps the SDK off its own retry path, which calls process.exit when retries run out; LiveRunner reconnects.
    makeTicker = (key, token) => new KiteTicker({ api_key: key, access_token: token, reconnect: false }) }) {
    if (!apiKey || !apiSecret) throw new Error('Kite API key and secret are required.');
    this.apiKey = apiKey; this.apiSecret = apiSecret; this.store = store; this.now = now; this.makeTicker = makeTicker;
    this.client = makeClient(apiKey);
    this.sdkTicker = null; this.handlers = null; this.expiredSignalled = false;
    const saved = store.loadKiteSession();
    if (saved) { registerSecret(saved.accessToken); this.client.setAccessToken(saved.accessToken); }
  }
  loginUrl() { return this.client.getLoginURL(); }
  async complete(requestToken, universe) {
    const result = await this.client.generateSession(requestToken, this.apiSecret);
    registerSecret(result.access_token);
    this.client.setAccessToken(result.access_token);
    const listed = new Map((await this.client.getInstruments('NSE')).map(item => [item.tradingsymbol, item.instrument_token]));
    const missing = universe.filter(symbol => !listed.has(symbol));
    if (missing.length) throw new Error(`Unknown NSE symbols: ${missing.join(', ')}`);
    const now = this.now(), expiresAt = new Date(nextSixAmIst(now)).toISOString();
    this.store.saveKiteSession({ accessToken: result.access_token, userId: result.user_id, issuedAt: new Date(now).toISOString(), expiresAt,
      instruments: Object.fromEntries(universe.map(symbol => [symbol, listed.get(symbol)])) });
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
  // Universe tokens come from the stored map (the ticker subscribes to those). Anything else, such as an index, comes
  // from one NSE instrument list per process, which keeps index tokens out of the stored map and the live stream.
  async tokenFor(symbol) {
    const stored = this.status().instruments[symbol];
    if (stored || this.status().state === 'none') return stored;
    this.listed ??= this.client.getInstruments('NSE').then(list => new Map(list.map(item => [item.tradingsymbol, item.instrument_token])), error => { this.listed = null; throw error; });
    return (await this.listed).get(symbol);
  }
  async historicalBars({ symbol, barMinutes, count, endMs }) {
    const interval = INTERVALS[barMinutes];
    if (!interval) throw new Error(`Unsupported bar size: ${barMinutes} minutes.`);
    const token = await this.tokenFor(symbol);
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
        this.sdkTicker.connect();
      },
      stop: () => { this.handlers = null; this.sdkTicker?.disconnect(); },
    };
  }
  bindTicker() {
    const t = this.makeTicker(this.apiKey, this.store.loadKiteSession()?.accessToken);
    this.sdkTicker = t;
    const tokens = () => Object.values(this.status().instruments);
    const symbolOf = () => new Map(Object.entries(this.status().instruments).map(([symbol, token]) => [token, symbol]));
    t.on('connect', () => { const list = tokens(); t.subscribe(list); t.setMode(t.modeFull, list); });
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
