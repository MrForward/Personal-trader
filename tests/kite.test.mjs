import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { KiteSession } from '../src/kite.mjs';
import { redact, registerSecret } from '../src/secrets.mjs';
import { ACCESS_TOKEN, fakeClient, fakeTicker } from './kite-fakes.mjs';

const T = iso => Date.parse(iso);
function setup(t, { now = T('2026-10-27T04:00:00Z'), client = fakeClient(), ticker = fakeTicker(), universe } = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const clock = { now };
  const madeTickers = [];
  const session = new KiteSession({ apiKey: 'key', apiSecret: 'shh-secret-value', store, now: () => clock.now, ...(universe && { universe }),
    makeClient: () => client, makeTicker: (apiKey, token) => { madeTickers.push(token); ticker.access_token = token; return ticker; } });
  return { store, session, clock, client, ticker, madeTickers };
}

test('complete stores session, instruments and expiry at next 06:00 IST', async t => {
  const { session, client, store } = setup(t);
  assert.equal(session.status().state, 'none');
  const result = await session.complete('reqtoken123', ['A', 'B']);
  assert.deepEqual(result, { userId: 'AB1234', expiresAt: '2026-10-28T00:30:00.000Z' });
  assert.deepEqual(session.status(), { state: 'valid', userId: 'AB1234', issuedAt: '2026-10-27T04:00:00.000Z', expiresAt: '2026-10-28T00:30:00.000Z', instruments: { A: 1, B: 2 } });
  assert.equal(client.accessToken, ACCESS_TOKEN);
  assert.equal(store.loadKiteSession().accessToken, ACCESS_TOKEN);
});

test('complete before 06:00 IST expires the same morning, after 06:00 the next morning', async t => {
  const early = setup(t, { now: T('2026-10-27T00:00:00Z') }); // 05:30 IST
  assert.equal((await early.session.complete('reqtoken123', ['A'])).expiresAt, '2026-10-27T00:30:00.000Z');
  const late = setup(t, { now: T('2026-10-27T01:00:00Z') }); // 06:30 IST
  assert.equal((await late.session.complete('reqtoken123', ['A'])).expiresAt, '2026-10-28T00:30:00.000Z');
});

test('unknown universe symbol throws without saving', async t => {
  const { session, store } = setup(t);
  await assert.rejects(() => session.complete('reqtoken123', ['A', 'ZZZ', 'YYY']), /Unknown NSE symbols: ZZZ, YYY/);
  assert.equal(store.loadKiteSession(), null); assert.equal(session.status().state, 'none');
});

test('status is expired once now passes expiresAt, and a stored session survives restart', async t => {
  const { session, clock, store, client } = setup(t);
  await session.complete('reqtoken123', ['A']);
  clock.now = T('2026-10-28T00:30:00Z'); assert.equal(session.status().state, 'expired');
  const reopened = new KiteSession({ apiKey: 'key', apiSecret: 'x', store, now: () => T('2026-10-27T05:00:00Z'), makeClient: () => client, makeTicker: fakeTicker });
  assert.equal(reopened.status().state, 'valid');
});

test('ticker forwards mapped ticks, subscribes in full mode, and reuses one SDK ticker across starts', async t => {
  const { session, ticker, madeTickers } = setup(t);
  await session.complete('reqtoken123', ['A', 'B']);
  const ticks = [], closes = [];
  const source = session.ticker();
  source.start({ onTick: tick => ticks.push(tick), onClose: reason => closes.push(reason) });
  ticker.emit('connect');
  assert.deepEqual(ticker.subscribed, [1, 2]); assert.deepEqual(ticker.mode, ['full', [1, 2]]);
  ticker.emit('ticks', [{ instrument_token: 2, last_price: 50.5, volume_traded: 900, exchange_timestamp: new Date('2026-10-27T04:00:01Z') },
    { instrument_token: 1, last_price: 10, volume_traded: 1, exchange_timestamp: null }, { instrument_token: 99, last_price: 1, exchange_timestamp: new Date() }]);
  assert.deepEqual(ticks, [{ symbol: 'B', price: 50.5, cumulativeVolume: 900, exchangeTime: T('2026-10-27T04:00:01Z') }]);
  ticker.emit('disconnect'); assert.deepEqual(closes, ['socket']);
  source.start({ onTick: () => {}, onClose: () => {} });
  assert.equal(madeTickers.length, 1); assert.equal(ticker.handlerCount('ticks'), 1); assert.equal(ticker.connects, 2);
  source.stop(); assert.equal(ticker.disconnects, 1);
});

test('ticker 403 error invalidates the session and reports expired once', async t => {
  const { session, ticker } = setup(t);
  await session.complete('reqtoken123', ['A']);
  const closes = [];
  session.ticker().start({ onTick: () => {}, onClose: reason => closes.push(reason) });
  ticker.emit('error', new Error('Unexpected server response: 403'));
  ticker.emit('close'); ticker.emit('disconnect');
  assert.deepEqual(closes, ['expired']); assert.equal(session.status().state, 'expired');
});

test('a new login swaps the token on the existing SDK ticker', async t => {
  const { session, ticker, madeTickers, client } = setup(t);
  await session.complete('reqtoken123', ['A']);
  session.ticker().start({ onTick: () => {}, onClose: () => {} });
  client.generateSession = async () => ({ access_token: 'second-token-abcdef', user_id: 'AB1234' });
  await session.complete('reqtoken456', ['A']);
  assert.equal(madeTickers.length, 1); assert.equal(ticker.access_token, 'second-token-abcdef');
});

test('historicalBars stamps rows at bar end, keeps only closed candles and returns the last count', async t => {
  const candles = (token, interval) => {
    assert.equal(interval, '15minute');
    return ['2026-10-26T09:45:00Z', '2026-10-26T09:50:00Z', '2026-10-27T03:45:00Z', '2026-10-27T04:00:00Z'].map((iso, i) => ({ date: new Date(iso), open: 10 + i, high: 12 + i, low: 9 + i, close: 11 + i, volume: 100 }));
  };
  const { session } = setup(t, { client: fakeClient({ candles }) });
  await session.complete('reqtoken123', ['A']);
  const bars = await session.historicalBars({ symbol: 'A', barMinutes: 15, count: 2, endMs: T('2026-10-27T04:10:00Z') });
  // The 04:00 candle ends 04:15, after endMs, so it is still open and excluded; the 09:50 candle ends at the 10:00 close.
  assert.deepEqual(bars.map(bar => bar.timestamp), ['2026-10-26T10:00:00.000Z', '2026-10-27T04:00:00.000Z']);
  assert.deepEqual([bars[1].open, bars[1].close, bars[1].volume], [12, 13, 100]);
});

test('historicalBars rejects unsupported bar sizes', async t => {
  const { session } = setup(t);
  await session.complete('reqtoken123', ['A']);
  await assert.rejects(() => session.historicalBars({ symbol: 'A', barMinutes: 7, count: 1, endMs: Date.now() }), /bar size/);
});

test('redact removes registered tokens and env secrets from a message', () => {
  registerSecret('registered-token-xyz'); process.env.KITE_API_SECRET = 'env-secret-abc';
  assert.equal(redact('a registered-token-xyz b env-secret-abc c'), 'a [redacted] b [redacted] c');
  delete process.env.KITE_API_SECRET;
});

test('store kite session round-trips and clears', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const value = { accessToken: 't', userId: 'u', issuedAt: '2026-10-27T04:00:00.000Z', expiresAt: '2026-10-28T00:30:00.000Z', instruments: { A: 1 } };
  store.saveKiteSession(value); assert.deepEqual(store.loadKiteSession(), value);
  store.clearKiteSession(); assert.equal(store.loadKiteSession(), null);
});

test('historicalBars day interval returns one bar per completed session with IST dates', async t => {
  const calls = [];
  const candles = (token, interval, from, to) => { calls.push({ token, interval, days: Math.round((to - from) / 86_400_000) });
    return [{ date: new Date('2026-10-12T00:00:00+05:30'), open: 1, high: 3, low: 1, close: 2, volume: 10 }, { date: new Date('2026-10-13T00:00:00+05:30'), open: 2, high: 4, low: 2, close: 3, volume: 20 },
      { date: new Date('2026-10-14T00:00:00+05:30'), open: 3, high: 9, low: 1, close: 5, volume: 99 }]; };
  const { session } = setup(t, { client: fakeClient({ candles }) });
  await session.complete('reqtoken123', ['A', 'B']);
  const bars = await session.historicalBars({ symbol: 'A', barMinutes: 'day', count: 60, endMs: T('2026-10-14T05:00:00Z') }); // 10:30 IST: today's candle is still forming
  assert.deepEqual(calls, [{ token: 1, interval: 'day', days: 120 }]);
  assert.deepEqual(bars, [{ date: '2026-10-12', open: 1, high: 3, low: 1, close: 2, volume: 10 }, { date: '2026-10-13', open: 2, high: 4, low: 2, close: 3, volume: 20 }]);
  assert.equal((await session.historicalBars({ symbol: 'A', barMinutes: 'day', count: 1, endMs: T('2026-10-14T10:00:00Z') })).at(0).date, '2026-10-14');
});

test('index bars resolve through one cached instrument lookup and are never stored as subscriptions', async t => {
  let lookups = 0;
  const client = fakeClient({ symbols: ['A', 'B', 'NIFTY 50'], candles: token => [{ date: new Date('2026-10-13T00:00:00+05:30'), open: 1, high: 1, low: 1, close: token, volume: 0 }] });
  const original = client.getInstruments; client.getInstruments = async (...args) => { lookups++; return original(...args); };
  const { session, store, ticker } = setup(t, { client });
  await session.complete('reqtoken123', ['A', 'B']);
  assert.deepEqual(store.loadKiteSession().instruments, { A: 1, B: 2 }); assert.equal(lookups, 1);
  const args = { symbol: 'NIFTY 50', barMinutes: 'day', count: 5, endMs: T('2026-10-14T05:00:00Z') };
  assert.equal((await session.historicalBars(args))[0].close, 3); await session.historicalBars(args);
  assert.equal(lookups, 2);
  session.ticker().start({ onTick() {}, onClose() {} }); ticker.emit('connect');
  assert.deepEqual(ticker.subscribed, [1, 2]);
  await assert.rejects(() => session.historicalBars({ ...args, symbol: 'NOPE' }), /No instrument token for NOPE/);
});

test('a universe symbol missing from the stored map still asks for a new login; only non-universe names use the instrument list', async t => {
  const client = fakeClient({ symbols: ['A', 'B', 'C', 'NIFTY 50'], candles: token => [{ date: new Date('2026-10-13T00:00:00+05:30'), open: 1, high: 1, low: 1, close: token, volume: 0 }] });
  const universe = ['A', 'B'];
  const { session } = setup(t, { client, universe: () => universe });
  await session.complete('reqtoken123', ['A', 'B']);
  universe.push('C'); // added to the universe after this login
  const args = { barMinutes: 'day', count: 5, endMs: T('2026-10-14T05:00:00Z') };
  await assert.rejects(() => session.historicalBars({ ...args, symbol: 'C' }), /No instrument token for C; log in again/);
  assert.equal((await session.historicalBars({ ...args, symbol: 'NIFTY 50' }))[0].close, 4);
});

test('instrument tokens from the CSV instrument list are stored and subscribed as numbers', async t => {
  // The real SDK parses Kite's instrument CSV, so instrument_token arrives as a string; the WebSocket ignores string tokens.
  const client = fakeClient();
  const list = await client.getInstruments();
  client.getInstruments = async () => list.map(item => ({ ...item, instrument_token: String(item.instrument_token) }));
  const { session, ticker } = setup(t, { client });
  await session.complete('reqtoken123', ['A', 'B']);
  assert.deepEqual(session.status().instruments, { A: 1, B: 2 });
  const ticks = [];
  session.ticker().start({ onTick: tick => ticks.push(tick), onClose: () => {} });
  ticker.emit('connect');
  assert.deepEqual(ticker.subscribed, [1, 2]);
  ticker.emit('ticks', [{ instrument_token: 2, last_price: 50, volume_traded: 1, exchange_timestamp: new Date('2026-10-27T04:00:01Z') }]);
  assert.equal(ticks.length, 1);
});

test('starting again on an open socket re-subscribes the current instruments', async t => {
  const { session, ticker, client } = setup(t);
  await session.complete('reqtoken123', ['A']);
  const source = session.ticker();
  source.start({ onTick: () => {}, onClose: () => {} });
  ticker.emit('connect');
  assert.deepEqual(ticker.subscribed, [1]);
  // A later login (or a universe change) while the socket stays open: the SDK skips connect(), so no 'connect' event fires.
  await session.complete('reqtoken456', ['A', 'B']);
  source.start({ onTick: () => {}, onClose: () => {} });
  assert.deepEqual(ticker.subscribed, [1, 2]); assert.deepEqual(ticker.mode, ['full', [1, 2]]);
  assert.equal(ticker.connects, 1);
});
