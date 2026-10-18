import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { KiteSession } from '../src/kite.mjs';
import { redact, registerSecret } from '../src/secrets.mjs';
import { ACCESS_TOKEN, fakeClient, fakeTicker } from './kite-fakes.mjs';

const T = iso => Date.parse(iso);
function setup(t, { now = T('2026-10-27T04:00:00Z'), client = fakeClient(), ticker = fakeTicker() } = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const clock = { now };
  const madeTickers = [];
  const session = new KiteSession({ apiKey: 'key', apiSecret: 'shh-secret-value', store, now: () => clock.now,
    makeClient: () => client, makeTicker: (apiKey, token) => { madeTickers.push(token); ticker.access_token = token; return ticker; } });
  return { store, session, clock, client, ticker, madeTickers };
}

test('complete stores session, instruments and expiry at next 06:00 IST', async t => {
  const { session, client, store } = setup(t);
  assert.equal(session.status().state, 'none');
  const result = await session.complete('reqtoken123', ['A', 'B']);
  assert.deepEqual(result, { userId: 'AB1234', expiresAt: '2026-10-28T00:30:00.000Z' });
  assert.deepEqual(session.status(), { state: 'valid', userId: 'AB1234', expiresAt: '2026-10-28T00:30:00.000Z', instruments: { A: 1, B: 2 } });
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
