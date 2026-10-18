# Phase 1 Live Paper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the existing paper engine on a VPS fed by live NSE prices from Kite Connect, with a real Zerodha cost model, exact tick replay and a daily report against buy-and-hold.

**Architecture:** One Node 24 process as today. Ticks from the Kite WebSocket are captured to a daily JSONL file, folded into closed 15‑minute bars, appended to the engine's dataset, and `engine.step()` runs once per closed bar (decision on bar N‑1, fill at bar N's open). Session, instruments and historical warmup live in `src/kite.mjs` behind an injectable client so tests never touch the network.

**Tech Stack:** Node 24 built-ins (`node:http`, `node:sqlite`, `node:test`), `kiteconnect` 5.3.0 (official SDK), systemd on Ubuntu 24.04.

**Spec:** `docs/superpowers/specs/2026-10-17-phase1-live-paper-design.md`

## Global Constraints

- Node `>=24`; ESM `.mjs`; tests are `node --test tests/*.test.mjs`; `npm test` must stay green after every task.
- Dashboard binds loopback only; `/kite/callback` is reached through the SSH tunnel. No new public port.
- Secrets (`KITE_API_KEY`, `KITE_API_SECRET`, access token) never appear in logs, errors, exports, snapshots or audit payloads.
- Session timezone `Asia/Kolkata`; NSE session 09:15–15:30 IST, Mon–Fri, excluding the holiday list.
- Bar size default 15 minutes; warmup fetches 40 historical bars (≥35 for `validateDataset`, > `INITIAL_CURSOR` 29).
- Cost schedule `zerodha-cnc-2026-10`: brokerage ₹0; STT 0.1% both; NSE 0.00297% both; SEBI ₹10/crore both; stamp 0.015% buy; GST 18% of (brokerage + exchange + SEBI); DP ₹15.34 per scrip per sell day. Check against Zerodha's charges page when written; record the check date in the file.
- Fixed costs default ₹1,100/month; spend cap ₹1,200/month; prorated over 21 trading days.
- Mode label for live paper state: `prospective-paper`. Trades carry `fill: 'observed-open' | 'assumed-open'`.
- Existing engine rules are untouched: stops only tighten, caps latch, unknown state blocks entries.

## Review Focus

1. Kite invalidates the token before 06:00 (the ticker closes with an auth error) — expected: status `expired`, panel shows **Login needed**, no crash. Test in Task 5.
2. A tick arrives with an exchange timestamp inside an already-closed bar — expected: dropped and counted, never reopens the bar. Test in Task 2.
3. Ticks after 15:30 (post-close prints) or before 09:15 — expected: ignored, not folded into a bar. Test in Task 2.
4. Restart mid-day: warmup returns bars that overlap rows already in state — expected: overlapping rows skipped, nothing appended twice, cursor unchanged. Test in Task 6.
5. Cumulative day volume resets at the next session — expected: first bar's volume equals the cumulative, not a negative difference. Test in Task 2.

---

### Task 1: Zerodha CNC cost model replaces `feeBps`

**Files:**
- Create: `src/costs.mjs`, `tests/costs.test.mjs`
- Modify: `src/config.mjs` (`simulation` group), `src/engine.mjs:229-317` (`sell`, `initializeBenchmarks`, entry sizing), `public/index.html:81`, `public/app.js` (settings form), `tests/config.test.mjs`, `tests/engine.test.mjs`, `tests/models.test.mjs` if they set `feeBps`

**Interfaces:**
- Produces: `export const COST_SCHEDULES = ['none', 'zerodha-cnc-2026-10']`
- Produces: `export function charges({ schedule, side, price, quantity, dpApplies }) → { stt, exchange, sebi, stamp, gst, dp, total }` — all numbers in INR rounded to 2 dp; `side` is `'BUY' | 'SELL'`; `dpApplies` is a boolean the caller decides.
- Produces: `export function perShareRate(schedule, side) → number` — fraction of price (STT + exchange + SEBI + stamp + GST on those), used only for sizing.

- [ ] **Step 1: Write the failing tests**

```js
// tests/costs.test.mjs
import test from 'node:test'; import assert from 'node:assert/strict';
import { charges, perShareRate, COST_SCHEDULES } from '../src/costs.mjs';
const Z = 'zerodha-cnc-2026-10';
test('none schedule charges nothing', () => assert.equal(charges({ schedule: 'none', side: 'BUY', price: 1000, quantity: 1, dpApplies: false }).total, 0));
test('buy of one ₹1000 share', () => {
  const c = charges({ schedule: Z, side: 'BUY', price: 1000, quantity: 1, dpApplies: false });
  assert.equal(c.stt, 1); assert.equal(c.stamp, 0.15); assert.equal(c.exchange, 0.03); assert.equal(c.dp, 0);
  assert.ok(Math.abs(c.total - 1.19) < 0.01);
});
test('sell of one ₹1000 share with DP', () => {
  const c = charges({ schedule: Z, side: 'SELL', price: 1000, quantity: 1, dpApplies: true });
  assert.equal(c.stt, 1); assert.equal(c.stamp, 0); assert.equal(c.dp, 15.34);
  assert.ok(Math.abs(c.total - 16.37) < 0.01);
});
test('second sell of same scrip same day: caller passes dpApplies false', () => assert.equal(charges({ schedule: Z, side: 'SELL', price: 1000, quantity: 1, dpApplies: false }).dp, 0));
test('per-share rates', () => { assert.ok(perShareRate(Z, 'BUY') > 0.00115 && perShareRate(Z, 'BUY') < 0.0012); assert.equal(perShareRate('none', 'SELL'), 0); });
test('unknown schedule throws', () => assert.throws(() => charges({ schedule: 'x', side: 'BUY', price: 1, quantity: 1, dpApplies: false })));
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/costs.test.mjs` → FAIL, module not found.
- [ ] **Step 3: Implement `src/costs.mjs`** with the rates in Global Constraints as a frozen table keyed by schedule; `gst = 0.18 * (exchange + sebi)`; `dp = dpApplies ? 15.34 : 0`. Comment the Zerodha page URL and check date.
- [ ] **Step 4: Run** — `node --test tests/costs.test.mjs` → PASS.
- [ ] **Step 5: Config:** in `DEFAULT_SETTINGS.simulation` replace `feeBps: 10` with `costSchedule: 'zerodha-cnc-2026-10'`; in `validateSettings` the simulation loop validates `startingCapital` and `slippageBps` as numbers and `costSchedule` as one of `COST_SCHEDULES` (error: `costSchedule must be one of: none, zerodha-cnc-2026-10.`).
- [ ] **Step 6: Engine:** replace every `feeBps` use.
  - `sell()`: `dpApplies = !state.trades.some(t => t.action === 'SELL' && t.symbol === position.symbol && sessionDay(t.timestamp) === sessionDay(timestamp))`; `fee = charges({ schedule, side: 'SELL', price: fill, quantity, dpApplies }).total`.
  - Entry: `feeRate = perShareRate(schedule, 'BUY')`, `sellRate = perShareRate(schedule, 'SELL')`; `plannedLoss = price - stopFill + price * feeRate + stopFill * sellRate`; after the existing `quantity` formula add `if (quantity && plannedLoss * quantity + dpCharge > values.equity * riskCap) quantity = Math.max(0, Math.floor((values.equity * riskCap - dpCharge) / plannedLoss))` where `dpCharge = charges({ schedule, side: 'SELL', price: 1, quantity: 1, dpApplies: true }).dp`. `fee = charges({ schedule, side: 'BUY', price, quantity, dpApplies: false }).total`.
  - `initializeBenchmarks`: same BUY charge per asset.
  - Trades gain `fill: next.source === 'ticks' ? 'observed-open' : 'assumed-open'` (buy) / same for sell using the row passed in; `sell()` gains a `row` parameter for this.
- [ ] **Step 7: Tests that set `feeBps: 0`** → `costSchedule: 'none'`. Add one engine test: `sell charges DP once per scrip per session day` — two positions in the same symbol are impossible, so: seed a position, step to a stop exit, then seed another position in the same symbol on the same session day, step to exit; assert the second SELL trade's fee is smaller than the first by exactly 15.34 (within 0.01).
- [ ] **Step 8: Dashboard:** replace the Fee input in `index.html:81` with `<select name="costSchedule">` holding the two schedules; `app.js` form read/write uses `costSchedule`.
- [ ] **Step 9: Run** — `npm test` → all pass. `npm run typecheck` if `node_modules` exists.
- [ ] **Step 10: Commit** — `feat: Zerodha CNC cost schedule replaces flat fee`

---

### Task 2: Tick → closed-bar builder

**Files:**
- Create: `src/bars.mjs`, `tests/bars.test.mjs`

**Interfaces:**
- Produces: `export class BarBuilder` with
  - `constructor({ barMinutes = 15, symbols, session })` — `session` is `{ openMs, closeMs }` for the current day (from Task 4; tests pass literals).
  - `seed(symbol, lastPrice)` — allows a symbol with no ticks yet to form thin bars.
  - `push(tick) → row | null` — `tick = { symbol, price, cumulativeVolume, exchangeTime }` (ms). Returns a closed row when `exchangeTime ≥` current bar end.
  - `flush(nowMs) → row | null` — closes the current bar if `nowMs ≥ barEnd + 30_000` and no tick has closed it.
  - `counters → { dropped, outsideSession, thinBars }`.
- Row shape: `{ timestamp: ISO of bar END, closed: true, source: 'ticks' | 'thin', bars: { [symbol]: { open, high, low, close, volume, timestamp, closed: true } } }`. A row is `thin` if any symbol had no tick in the bar (its OHLC = last price, volume 0).

- [ ] **Step 1: Write the failing tests**

```js
// tests/bars.test.mjs
import test from 'node:test'; import assert from 'node:assert/strict';
import { BarBuilder } from '../src/bars.mjs';
const T = iso => Date.parse(iso);
const session = { openMs: T('2026-10-20T03:45:00Z'), closeMs: T('2026-10-20T10:00:00Z') }; // 09:15–15:30 IST
const make = () => new BarBuilder({ barMinutes: 15, symbols: ['A', 'B'], session });
test('ticks fold into a bar and the next-bar tick closes it', () => {
  const b = make();
  assert.equal(b.push({ symbol: 'A', price: 100, cumulativeVolume: 10, exchangeTime: T('2026-10-20T03:45:05Z') }), null);
  b.push({ symbol: 'A', price: 102, cumulativeVolume: 25, exchangeTime: T('2026-10-20T03:50:00Z') });
  b.push({ symbol: 'B', price: 50, cumulativeVolume: 5, exchangeTime: T('2026-10-20T03:51:00Z') });
  b.push({ symbol: 'A', price: 99, cumulativeVolume: 30, exchangeTime: T('2026-10-20T03:59:59Z') });
  const row = b.push({ symbol: 'A', price: 101, cumulativeVolume: 31, exchangeTime: T('2026-10-20T04:00:00Z') });
  assert.equal(row.timestamp, '2026-10-20T04:00:00.000Z'); assert.equal(row.source, 'ticks');
  assert.deepEqual(row.bars.A, { open: 100, high: 102, low: 99, close: 99, volume: 30, timestamp: '2026-10-20T04:00:00.000Z', closed: true });
  assert.equal(row.bars.B.volume, 5);
});
test('late tick inside a closed bar is dropped and counted', () => {
  const b = make(); b.seed('B', 50);
  b.push({ symbol: 'A', price: 100, cumulativeVolume: 1, exchangeTime: T('2026-10-20T03:45:05Z') });
  b.push({ symbol: 'A', price: 100, cumulativeVolume: 2, exchangeTime: T('2026-10-20T04:00:01Z') });
  assert.equal(b.push({ symbol: 'A', price: 1, cumulativeVolume: 3, exchangeTime: T('2026-10-20T03:59:00Z') }), null);
  assert.equal(b.counters.dropped, 1);
});
test('ticks outside the session are ignored', () => {
  const b = make();
  b.push({ symbol: 'A', price: 100, cumulativeVolume: 1, exchangeTime: T('2026-10-20T03:40:00Z') });
  b.push({ symbol: 'A', price: 100, cumulativeVolume: 1, exchangeTime: T('2026-10-20T10:00:30Z') });
  assert.equal(b.counters.outsideSession, 2);
});
test('symbol with no tick in the bar makes a thin row at its last price', () => {
  const b = make(); b.seed('B', 50);
  b.push({ symbol: 'A', price: 100, cumulativeVolume: 1, exchangeTime: T('2026-10-20T03:45:05Z') });
  const row = b.push({ symbol: 'A', price: 100, cumulativeVolume: 2, exchangeTime: T('2026-10-20T04:00:00Z') });
  assert.equal(row.source, 'thin'); assert.deepEqual([row.bars.B.open, row.bars.B.close, row.bars.B.volume], [50, 50, 0]);
  assert.equal(b.counters.thinBars, 1);
});
test('flush closes a bar 30 s after its end when no tick arrived; no row before that', () => {
  const b = make(); b.seed('B', 50);
  b.push({ symbol: 'A', price: 100, cumulativeVolume: 1, exchangeTime: T('2026-10-20T03:45:05Z') });
  assert.equal(b.flush(T('2026-10-20T04:00:10Z')), null);
  assert.equal(b.flush(T('2026-10-20T04:00:30Z')).timestamp, '2026-10-20T04:00:00.000Z');
});
test('no row until every symbol has a price', () => {
  const b = make();
  b.push({ symbol: 'A', price: 100, cumulativeVolume: 1, exchangeTime: T('2026-10-20T03:45:05Z') });
  assert.equal(b.push({ symbol: 'A', price: 100, cumulativeVolume: 2, exchangeTime: T('2026-10-20T04:00:00Z') }), null);
});
test('first bar volume after a day change uses the new cumulative', () => {
  const b = make(); b.seed('B', 50);
  b.push({ symbol: 'A', price: 100, cumulativeVolume: 5000, exchangeTime: T('2026-10-20T03:45:05Z') });
  const row = b.push({ symbol: 'A', price: 100, cumulativeVolume: 5100, exchangeTime: T('2026-10-20T04:00:00Z') });
  assert.equal(row.bars.A.volume, 5000);
});
```

- [ ] **Step 2: Run** — `node --test tests/bars.test.mjs` → FAIL.
- [ ] **Step 3: Implement `BarBuilder`** — per-symbol `{ open, high, low, close, volume, lastCumulative, lastPrice, ticked }`; current bar `[start, end)` aligned to `session.openMs + k·barMinutes`; `push` first checks session window, then drops `exchangeTime < currentStart`, then closes if `≥ currentEnd` (emitting the row, then starting the new bar with this tick). Volume = `cumulativeVolume − cumulativeAtBarStart`, where at the session's first bar `cumulativeAtBarStart = 0`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat: tick to closed-bar builder`

---

### Task 3: Engine accepts live bars

**Files:**
- Modify: `src/engine.mjs` (`newState`, constructor, `step` options, new methods), `tests/engine.test.mjs`

**Interfaces:**
- Produces: `engine.beginLive({ rows, assets, source })` — `rows` already validated (≥35), `assets = [{ symbol, name, sector }]`; creates state with `mode: 'prospective-paper'`, `cursor: rows.length - 1`, archives the previous run. Historical rows get `source: 'historical'`.
- Produces: `engine.appendBar(row) → snapshot` — row from `BarBuilder` or warmup; rejects (throws, no state change) when `row.timestamp ≤ last row`, when `Object.keys(row.bars)` ≠ asset symbols, or OHLC invalid (reuse the field checks in `validateDataset` by extracting `validateBar(symbol, source, time)` from `src/dataset.mjs:38-49` and exporting it). Commits as kind `bar-append`.
- Produces: `engine.step({ runId, expectedCursor, blockEntries })` — `blockEntries` is an optional string; when set, every BUY proposal gets `decision.outcome = \`Rejected: ${blockEntries}\`` before sizing.
- `snapshot().mode` and `snapshot().run.lastBarSource` exposed; `health` in Task 7 reads `engine.state.mode`.

- [ ] **Step 1: Write the failing tests** in `tests/engine.test.mjs`:
  - `beginLive sets prospective-paper mode and makes no decisions on historical bars`: `beginLive({ rows: rows(['A'], 40), assets: [...], source: 'test live' })`; assert `state.mode === 'prospective-paper'`, `state.cursor === 39`, `state.decisions.length === 0`, archive count 1.
  - `appendBar then step decides once and fills at the appended bar open`: append row 40 with `source: 'ticks'`; `await step(engine)`; assert `cursor === 40`, one decision per asset, and if a trade exists its `fill === 'observed-open'`.
  - `appendBar rejects stale, duplicate, and missing-symbol rows without changing state`: three `assert.throws`, then `assert.equal(engine.state.dataset.length, 40)`.
  - `blockEntries rejects buys with the given reason`: seed momentum-favourable data; `engine.step({ runId, expectedCursor, blockEntries: 'Data gap: waiting for clean bars' })`; assert no position and the decision outcome string.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — `beginLive` builds `newState(...)` then sets `mode`, `cursor`, and `row.source ??= 'historical'`; `appendBar` validates, clones state, pushes, runs `checkRisk`, commits; `step` adds `'blockEntries'` to the allowed option keys and applies it in Phase 2 of the loop before `riskLatched`. `newState` keeps `mode: 'paper'` for the replay path.
- [ ] **Step 4: Run** — `npm test` → PASS.
- [ ] **Step 5: Commit** — `feat: engine accepts appended live bars`

---

### Task 4: NSE session calendar

**Files:**
- Create: `src/calendar.mjs`, `tests/calendar.test.mjs`

**Interfaces:**
- Produces: `export function sessionFor(dateMs) → { day: 'YYYY-MM-DD', openMs, closeMs } | null` — null on weekends and holidays. `openMs` = 09:15 IST, `closeMs` = 15:30 IST of that IST day.
- Produces: `export const HOLIDAYS_2026 = [...]` — copy the NSE equity trading-holiday list from `https://www.nseindia.com/resources/exchange-communication-holidays` at implementation time; comment the fetch date. Do not invent dates.

- [ ] **Step 1: Tests** — a Tuesday returns 03:45Z/10:00Z; a Saturday returns null; the first entry of `HOLIDAYS_2026` returns null; a time at 02:00 IST still maps to that IST day (not the previous UTC day).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** using `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })` for the day and a fixed `+05:30` offset for open/close. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat: NSE session calendar`

---

### Task 5: Kite session, instruments, warmup, ticker

**Files:**
- Create: `src/secrets.mjs`, `src/kite.mjs`, `tests/kite.test.mjs`
- Modify: `src/store.mjs` (new table + 3 methods), `src/engine.mjs:65-69` and `src/server.mjs:20-24` (use `redact`), `package.json` (`"kiteconnect": "5.3.0"`), `.env.example`

**Interfaces:**
- `src/secrets.mjs`: `registerSecret(value)`, `redact(message) → string` — replaces every registered non-empty value and `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`KITE_API_SECRET` from env with `[redacted]`.
- `Store`: table `kite_session(id INTEGER PRIMARY KEY CHECK(id=1), access_token TEXT, user_id TEXT, issued_at TEXT, expires_at TEXT, instruments TEXT)`; `saveKiteSession({ accessToken, userId, issuedAt, expiresAt, instruments })`, `loadKiteSession() → same | null`, `clearKiteSession()`.
- `src/kite.mjs`: `export class KiteSession`
  - `constructor({ apiKey, apiSecret, store, makeClient = apiKey => new KiteConnect({ api_key: apiKey }), makeTicker = (apiKey, token) => new KiteTicker({ api_key: apiKey, access_token: token }), now = Date.now })`
  - `loginUrl() → string`
  - `async complete(requestToken, universe) → { userId, expiresAt }` — `client.generateSession(requestToken, apiSecret)`; `expiresAt` = next 06:00 IST strictly after `now()`; fetches `client.getInstruments('NSE')`, keeps `{ [symbol]: instrument_token }` for `universe`, throws `Unknown NSE symbols: X, Y` if any missing; saves to store; `registerSecret(accessToken)`.
  - `status() → { state: 'none' | 'valid' | 'expired', userId, expiresAt, instruments }`
  - `invalidate(reason)` — marks expired (keeps the row, sets `expires_at = now`), used when the ticker reports an auth error.
  - `async historicalBars({ symbol, barMinutes, count, endMs }) → bar[]` — `client.getHistoricalData(token, '15minute', from, to)`; maps Kite candles `{date, open, high, low, close, volume}` to `{ timestamp: ISO(start + barMinutes), open, high, low, close, volume }`, last `count`.
  - `ticker({ onTick, onClose, onError }) → { start(), stop() }` — subscribes all instrument tokens in full mode; `onTick({ symbol, price, cumulativeVolume, exchangeTime })` per tick (Kite fields `last_price`, `volume_traded`, `exchange_timestamp`); on `error` with HTTP 403 calls `invalidate('token rejected')` then `onClose('expired')`.
- `.env.example` gains `KITE_API_KEY=` and `KITE_API_SECRET=`.

- [ ] **Step 1: Tests** (`tests/kite.test.mjs`) with a fake client `{ getLoginURL: () => 'https://kite.example/login', generateSession: async () => ({ access_token: 'tok-secret', user_id: 'AB1234' }), getInstruments: async () => [{ tradingsymbol: 'A', instrument_token: 1 }, { tradingsymbol: 'B', instrument_token: 2 }], getHistoricalData: async () => [...] }` and a fake ticker emitting events:
  - `complete stores session, instruments and expiry at next 06:00 IST`: `now = 2026-10-20T04:00:00Z` → `expiresAt === '2026-10-21T00:30:00.000Z'`; `status().state === 'valid'`.
  - `complete after 06:00 IST expires the following day`: `now = 2026-10-20T01:00:00Z` (06:30 IST) → `2026-10-21T00:30:00.000Z`.
  - `unknown universe symbol throws without saving`.
  - `status is expired once now passes expiresAt`.
  - `ticker 403 error invalidates the session and reports expired` (Review Focus 1).
  - `redact removes the access token and env secrets from a message`.
  - `historicalBars stamps rows at bar end and returns the last count`.
  - Store: `saveKiteSession/loadKiteSession round-trip; clearKiteSession → null`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** the interfaces above; `npm install kiteconnect@5.3.0 --save-exact`. **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** — `feat: Kite session, instruments and warmup client`

---

### Task 6: Live runner with tick capture and replay

**Files:**
- Create: `src/live.mjs`, `tests/live.test.mjs`, `tests/fixtures/ticks-2026-10-20.jsonl` (synthetic symbols `DEMO1`, `DEMO2`; ~200 lines covering 3 bars incl. one thin bar)

**Interfaces:**
- `export class LiveRunner`
  - `constructor({ engine, session, settings: () => engine.state.settings, captureDir, calendar = sessionFor, now = Date.now, run = fn => fn(), source })` — `source` is `{ start({ onTick, onClose, onError }), stop() }`; production passes `session.ticker`, tests pass a file replayer. `run` is the server's `serial`.
  - `async start()` — if `calendar(now()) === null` → `state = 'idle'` (holiday/weekend; re-check at next 09:00 IST), return. If `session.status().state !== 'valid'` → `state = 'login-needed'`, return. Else `warmup()` then `source.start(...)`; schedules `flush` every 10 s and the 15:45 IST report hook (Task 8) via `setTimeout` computed from `calendar`.
  - `async warmup()` — for each universe symbol `session.historicalBars({ count: 40 })`; builds rows; if `engine.state.mode !== 'prospective-paper'` or the universe differs → `engine.beginLive(...)`; else append only rows with `timestamp > last row` (Review Focus 4). Seeds the `BarBuilder` with each symbol's last close. If the historical call throws: with an existing live state continue on ticks alone (`counters.warmupFailed++`); with no live state → `state = 'warmup-failed'`, retry every 60 s. (The engine needs ≥35 rows, so there is no "start empty".)
  - `onTick(tick)` — append one JSON line to `${captureDir}/ticks-${day}.jsonl` **before** `builder.push`; track skew `now() − exchangeTime`: three consecutive ticks over 5 000 ms set `skewed = true` (cleared by three under); if a row closes → `run(async () => { engine.appendBar(row); await engine.step({ runId, expectedCursor, blockEntries }); })` where `blockEntries` is the first that applies: `'Clock skew over 5 s'` when `skewed`, `'Data gap: waiting for clean bars'` when `cleanBarsSinceGap < 2`, else `undefined`. `cleanBarsSinceGap` resets to 0 on `onClose` and on a `thin` row, increments on a `ticks` row.
  - While `state === 'disconnected'` the 10 s timer does **not** flush bars (no fabricated prices); instead, each time a bar end passes it calls `engine.store.append('protection-gap', { barEnd, positions: engine.state.positions.map(p => p.symbol) })` so the ledger shows `protection: no data` for that period.
  - On a `PERSISTENCE_ERROR` from `appendBar`/`step` → `stop()` then `onFatal(error)` (constructor option, default `() => {}`; the server passes `error => { process.exitCode = 1; app.close() }` so systemd restarts the service paused).
  - `status() → { state: 'idle' | 'login-needed' | 'warming-up' | 'warmup-failed' | 'live' | 'disconnected' | 'closed', lastTickAt, barsToday, counters, cleanBarsSinceGap, skewed }`
  - `stop()`
- `export function replayCapture(path) → source` — reads JSONL, emits ticks in file order with no delay; `exchangeTime` from each line.
- Reconnect: on `onClose(reason)` with `reason !== 'expired'` → `state = 'disconnected'`, `source.start` again after `min(2^n, 300)` seconds; on `'expired'` → `state = 'login-needed'`.

- [ ] **Step 1: Tests** (`tests/live.test.mjs`, in-memory store, fake `session` whose `historicalBars` returns 40 synthetic bars ending just before the fixture's first tick, `captureDir` = temp dir):
  - `replaying the fixture produces three bars and three steps, and the capture file equals the fixture byte-for-byte`.
  - `replaying twice from a fresh store yields identical ledgers` (compare `JSON.stringify` of `trades`, `decisions.map(d => d.outcome)`, `metrics.equity`).
  - `restart after the first bar skips overlapping warmup rows and continues` — run fixture to bar 1, create a new `LiveRunner` on the same store with `historicalBars` now returning bars overlapping rows already in state; assert `dataset.length` grows by exactly the new bars (Review Focus 4).
  - `first two bars after start block entries with the data-gap reason`.
  - `login-needed when the session is not valid; no warmup call made`.
  - `idle on a holiday; no warmup or source start` (calendar stub returns null).
  - `warmup failure with no live state retries; with live state continues on ticks` (historicalBars throws once).
  - `three skewed ticks block entries with the clock-skew reason` (`now` 10 s ahead of tick times).
  - `disconnect writes a protection-gap audit row per missed bar and emits no bar` (source calls `onClose('socket')`, advance `now` past a bar end, assert `store.audit()` has `protection-gap` and `dataset.length` unchanged).
  - `persistence error stops the runner and calls onFatal` (store `save` stubbed to throw `PERSISTENCE_ERROR`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** — `feat: live runner with tick capture and replay`

---

### Task 7: Server routes, health and the Kite panel

**Files:**
- Modify: `src/server.mjs` (routes, health, wiring), `public/index.html` (Kite panel near line 71), `public/app.js` (render + Login button), `tests/server.test.mjs`

**Interfaces:**
- `createApplication({ ..., kite = { apiKey: process.env.KITE_API_KEY, apiSecret: process.env.KITE_API_SECRET }, captureDir = resolve(dirname(dbPath), 'ticks'), makeClient, makeTicker })` — when `apiKey` is empty, no `KiteSession`/`LiveRunner` is created and `/api/kite/status` returns `{ configured: false }`.
- Routes: `GET /kite/login` → 302 to `session.loginUrl()`; `GET /kite/callback?request_token=…&status=success` → `await serial(() => session.complete(token, settings.universe))`, then `runner.start()`, then 302 to `/`; on error 400 with redacted message. `GET /api/kite/status` → `{ configured: true, session: session.status(), runner: runner.status() }` (no token).
- `GET /api/health` → `{ ok, mode: engine.state.mode, liveTrading: false, kite: session?.status().state ?? 'unconfigured', lastTickAt }`.
- Startup: if a stored session is valid, `runner.start()` after `listen()`. Runner gets `run: serial` and `onFatal: error => { process.stderr.write(redact(error.message)); process.exitCode = 1; void app.close(); }`.
- Panel copy: heading **Kite**; states shown as `Not configured` / `Login needed` / `Valid until 06:00 IST tomorrow` / `Live · last tick HH:MM:SS · N bars today` / `Disconnected, reconnecting`. One button **Login** that navigates to `/kite/login`, hidden unless state is `login-needed` or `expired`.

- [ ] **Step 1: Tests** (`tests/server.test.mjs`, inject fake `makeClient`/`makeTicker` from Task 5's test helpers):
  - `kite status reports unconfigured without an api key`.
  - `login redirects to the Kite login URL` (302, `location` header).
  - `callback completes the session, starts the runner and redirects home`; then `/api/kite/status` → `session.state === 'valid'`, and the response body never contains `tok-secret`.
  - `callback with a bad token returns 400 and leaves status none`.
  - `health reports mode and kite state`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** routes before the `isMutation` check (they are GETs); the callback is the one GET that mutates, so it goes through `serial` and checks `sec-fetch-site !== 'cross-site'` is **not** required (Kite redirects cross-site by design); it validates `status === 'success'` and `request_token` matches `/^[A-Za-z0-9]{10,64}$/`.
- [ ] **Step 4: Panel** in `index.html`/`app.js`; poll `/api/kite/status` every 5 s alongside the existing state refresh.
- [ ] **Step 5: Run** `npm test` → PASS. Manual: `npm run dev`, open the page, confirm the panel shows `Not configured`.
- [ ] **Step 6: Commit** — `feat: Kite login routes and dashboard panel`

---

### Task 8: Daily report with fixed costs and buy-and-hold

**Files:**
- Modify: `src/config.mjs` (`simulation.fixedCostsPerMonthInr`, `simulation.spendCapPerMonthInr`, `universe`, `barMinutes`), `src/store.mjs` (`daily_report` table), `src/engine.mjs` (`dailyReport(day, dataQuality)`), `src/live.mjs` (15:45 hook), `src/server.mjs` (`GET /api/reports`), `public/index.html` + `app.js` (Reports view), `tests/config.test.mjs`, `tests/engine.test.mjs`, `tests/server.test.mjs`

**Interfaces:**
- Config: `universe: string[]` (1–20, `/^[A-Z0-9][A-Z0-9._-]{0,24}$/`, default the 10 symbols the owner confirms — until then `['RELIANCE','TCS','INFY','HDFCBANK','ICICIBANK','ITC','SBIN','TATAMOTORS','ONGC','COALINDIA']` with a comment `shortcut: placeholder universe, replace when the owner confirms the list`), `barMinutes: 15` (allowed `5 | 15 | 60`), `fixedCostsPerMonthInr: 1100` (0–100000), `spendCapPerMonthInr: 1200` (0–100000). Changing `universe` or `barMinutes` is rejected unless the run is at its initial state, like `startingCapital`.
- `Store`: `daily_report(day TEXT PRIMARY KEY, payload TEXT NOT NULL)`; `saveDailyReport(day, payload)`, `dailyReports() → [{ day, ...payload }]` ordered by day.
- `engine.dailyReport(day, dataQuality) → payload` — `{ day, mode, equity, cash, realizedPnl, unrealizedPnl, positions: [{symbol, quantity, stopPrice, markPrice}], tradesToday: [...trades with charges and fill], benchmarkEquity, cappedBenchmarkEquity, fixedCostsToDate, netAfterFixedCosts, spendCap, monthToDateFixedCosts, dataQuality }` where `fixedCostsToDate = fixedCostsPerMonthInr / 21 × tradingDaysSinceRunStart` and `netAfterFixedCosts = equity − startingCapital − fixedCostsToDate`. Saves via store.
- `dataQuality` from `runner.status()`: `{ ticks, dropped, outsideSession, thinBars, disconnects, loginAt, flagged: thinBars > 0.2 × barsToday || dropped > 0.01 × ticks }`.
- `GET /api/reports` → `store.dailyReports()`.

- [ ] **Step 1: Tests** — config: universe/barMinutes/fixed-cost validation and the "reset before changing universe" rule; engine: `dailyReport computes fixed costs per trading day and net after fixed costs` with `fixedCostsPerMonthInr: 2100` and 2 trading days → `fixedCostsToDate === 200`; server: `/api/reports` returns the saved row after calling `engine.dailyReport` directly.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; the runner's 15:45 IST timer calls `run(() => engine.dailyReport(day, dataQuality))` and on process start, if today's session has closed and no report exists for today, writes it once.
- [ ] **Step 4: Reports view** — a table of days with equity, net after fixed costs, benchmark, trades, data-quality flag; the settings form gains the four new fields.
- [ ] **Step 5: Run** `npm test` → PASS. **Step 6: Commit** — `feat: daily report with fixed costs and benchmarks`

---

### Task 9: VPS deployment, backups and docs

**Files:**
- Create: `deploy/deploy.sh`, `deploy/backup.mjs`, `deploy/trading-lab-backup.service`, `deploy/trading-lab-backup.timer`
- Modify: `deploy/trading-lab.service` (nothing new needed: `EnvironmentFile` already carries the Kite keys; add `ReadWritePaths` unchanged), `deploy/README.md` (rewrite per spec §2 and §7), `docs/RESUME-PLAN.md` (checkpoint 17 Oct: GitHub remote exists, branch `phase1-live-paper`, Phase 1 build state), `docs/README.md` (link the plan)

**Interfaces:**
- `deploy/deploy.sh <user@host>`: `rsync -a --delete src public package.json package-lock.json deploy` to `/opt/trading-lab`, `ssh … 'cd /opt/trading-lab && npm ci --omit=dev && sudo systemctl restart trading-lab && systemctl is-active trading-lab'`. Exits non-zero if the service is not active.
- `deploy/backup.mjs`: `node deploy/backup.mjs <dbPath> <backupDir>` — uses `node:sqlite`'s `backup(db, dest)` to write `trading-lab-YYYY-MM-DD.sqlite`, copies `ticks/ticks-YYYY-MM-DD.jsonl` if present, deletes files older than 30 days. Timer: `OnCalendar=Mon..Fri 16:00 Asia/Kolkata`.

- [ ] **Step 1: Write `backup.mjs` and a test** `tests/backup.test.mjs`: create a temp store with one state row, run backup, open the copy read-only and assert the row exists; create a 31-day-old file and assert it is deleted.
- [ ] **Step 2: Run** → PASS.
- [ ] **Step 3: Write `deploy.sh`, the timer/service units and the README** with the exact owner steps from spec §2 (Kite app, Lightsail 1 GB Mumbai, `ufw allow 22`, env file with `KITE_API_KEY`/`KITE_API_SECRET`/`TRADING_LAB_DB_PATH`), the daily login steps from §4, restore steps (`systemctl stop`, copy backup over the db, `systemctl start`), and the pre-Phase-1 manual check list from §10.
- [ ] **Step 4: Update `docs/RESUME-PLAN.md`** header to 17 October 2026 and replace the "Repository status" paragraph; add a "Phase 1 build" paragraph listing the new modules and that no VPS deploy has been verified yet. Add the plan link to `docs/README.md`.
- [ ] **Step 5: Run** `npm test` → PASS. **Step 6: Commit** — `chore: VPS deploy, backup timer and Phase 1 docs`

---

### Task 10: First deploy and manual check (needs the owner's VPS and Kite key)

- [ ] On the VPS: follow `deploy/README.md` through `systemctl status trading-lab` active.
- [ ] From the laptop: `ssh -L 3000:127.0.0.1:3000 ubuntu@<vps>`; open `http://127.0.0.1:3000`; panel shows **Login needed**; click **Login**; complete Zerodha login; panel shows **Valid until 06:00 IST tomorrow**.
- [ ] During a session: panel shows **Live**, last tick updating; after 15 minutes `run.cursor` increments and a decision appears in the journal.
- [ ] `sudo systemctl restart trading-lab`; reload; state restored, panel back to **Live** without a new login.
- [ ] `ls /var/lib/trading-lab/ticks/` shows today's file; `node deploy/backup.mjs` run by hand writes a backup.
- [ ] Record the check in `docs/RESUME-PLAN.md`, commit `docs: Phase 1 deploy verified`, and note the Phase 1 start date in `docs/GOAL.md`.
