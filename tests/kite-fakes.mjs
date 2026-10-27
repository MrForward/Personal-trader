// Shared fakes for the Kite SDK; not a test file (no .test suffix).
export const ACCESS_TOKEN = 'tok-secret-0123456789';

export function fakeClient({ symbols = ['A', 'B'], candles = () => [], failSession = false, quote = symbol => ({ last_price: 100, volume: 1000, average_price: 100 }) } = {}) {
  const client = {
    accessToken: null,
    getLoginURL: () => 'https://kite.example/connect/login?api_key=key',
    generateSession: async requestToken => {
      if (failSession || requestToken === 'badtoken000') throw new Error(`Token is invalid or has expired (${requestToken}).`);
      return { access_token: ACCESS_TOKEN, user_id: 'AB1234' };
    },
    setAccessToken: token => { client.accessToken = token; },
    getInstruments: async () => symbols.map((tradingsymbol, index) => ({ tradingsymbol, instrument_token: index + 1, segment: 'NSE' })),
    getHistoricalData: async (token, interval, from, to) => candles(token, interval, from, to),
    quoteCalls: [],
    getQuote: async instruments => { client.quoteCalls.push(instruments.length); return Object.fromEntries(instruments.map(key => [key, quote(key.slice(4))])); },
  };
  return client;
}

export function fakeTicker() {
  const handlers = {};
  const ticker = {
    access_token: null, subscribed: [], mode: null, connects: 0, disconnects: 0, modeFull: 'full',
    on: (event, callback) => { (handlers[event] ??= []).push(callback); },
    open: false,
    connected: () => ticker.open,
    emit: (event, ...args) => { if (event === 'connect') ticker.open = true; if (event === 'disconnect') ticker.open = false; for (const callback of handlers[event] ?? []) callback(...args); },
    connect: () => { ticker.connects++; },
    disconnect: () => { ticker.disconnects++; },
    unsubscribed: [],
    subscribe: tokens => { ticker.subscribed = tokens; },
    unsubscribe: tokens => { ticker.unsubscribed.push(...tokens); },
    setMode: (mode, tokens) => { ticker.mode = [mode, tokens]; },
    handlerCount: event => (handlers[event] ?? []).length,
  };
  return ticker;
}
