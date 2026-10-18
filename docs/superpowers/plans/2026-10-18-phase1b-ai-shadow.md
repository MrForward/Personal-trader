# Phase 1b AI Shadow Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a second, isolated paper ledger in which Claude Haiku 5.5 picks the strategy on signal bars, fed the same live bars as the rules ledger, with a rupee spend cap and a daily AI-vs-rules comparison.

**Architecture:** A `ShadowRunner` owns a second `TradingEngine` and `Store` on `data/shadow.sqlite`. `LiveRunner` hands it every bar, catch-up and warmup after the main engine commits; the shadow works through its own queue, so a slow or failing model never delays or touches the main ledger. The engine calls the reviewer only on signal bars, and every paid call passes a monthly rupee cap stored in `model_calls`.

**Tech Stack:** Node 24 built-ins (`node:sqlite`, `node:test`), the existing fetch-based Anthropic adapter in `src/models.mjs`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-18-phase1b-ai-shadow-design.md`

## Global Constraints

- Node `>=24`, ESM `.mjs`; `npm test` (`node --test tests/*.test.mjs`) and `npm run typecheck` stay green after every task.
- No test makes a real API call; reviewers are injected.
- The main ledger's behaviour is identical with shadow on, off or stopped.
- Shadow is active only when `ANTHROPIC_API_KEY` is set **and** `TRADING_LAB_ALLOW_PAID_MODEL_CALLS=1` **and** `settings.shadow.enabled === true`.
- Defaults: `shadow: { enabled: false, model: 'claude-haiku-5-5', monthlySpendCapInr: 1000, usdInr: 88, dailyCallLimit: 40 }`. Bounds: cap 0–10000, usdInr 50–150, dailyCallLimit 0–200, model must match `/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/`.
- Price table: `claude-haiku-5-5` = $0.10 input / $0.50 output per million tokens (checked 18 Oct 2026). An unpriced model is refused for paid calls.
- Spend month is the IST calendar month (`YYYY-MM` in Asia/Kolkata).
- Shadow reviewer profile: `provider: 'anthropic'`, `maxOutputTokens: 4000`, `timeoutMs: 30000`; Anthropic requests carry `output_config.effort: 'low'`.
- Secrets never enter prompts, logs, audit rows or reports; use `redact()` from `src/secrets.mjs` for every logged error.

## Review Focus

1. Key present but `TRADING_LAB_ALLOW_PAID_MODEL_CALLS` not `1` → shadow `off` with reason "Paid model calls are disabled", zero requests. Test in Task 3.
2. IST month rollover (23:59 IST on the last day vs 00:01 IST on the 1st) → spend resets on the 1st. Test in Task 1.
3. Shadow enabled mid-day → starts at the next `beginLive`/warmup (needs warmup rows); disabled mid-day → no further calls from the next bar. Test in Task 3.
4. Model picks a strategy that is disabled in settings → treated as a failed review, pick `none`. Test in Task 2.
5. Restart mid-day with an existing live `shadow.sqlite` → shadow catches up on the same run, no new run. Test in Task 4.

---

### Task 1: Spend meter and shadow settings

**Files:**
- Modify: `src/costs.mjs`, `src/store.mjs`, `src/config.mjs`, `src/engine.mjs` (`callReviewer`, constructor defaults)
- Test: `tests/costs.test.mjs`, `tests/store.test.mjs`, `tests/config.test.mjs`, `tests/engine.test.mjs`

**Interfaces:**
- Produces: `MODEL_PRICES` (frozen) and `modelCostInr({ model, inputTokens, outputTokens, usdInr }) → number` (INR, 4 dp; throws `No price for model <id>; add it to MODEL_PRICES before paid use.`) in `src/costs.mjs`.
- Produces: `istMonth(ms) → 'YYYY-MM'` and `istDay(ms) → 'YYYY-MM-DD'` exported from `src/costs.mjs` (Asia/Kolkata).
- Produces: `Store#reserveCall(config, { monthlySpendCapInr, now = Date.now() } = {})` — throws code `MONTHLY_SPEND_CAP`, message `Monthly AI spend cap reached. No provider request was sent.` when `spendInr({ month: istMonth(now) }) >= monthlySpendCapInr`; `Store#transaction` rethrows `MONTHLY_SPEND_CAP` unchanged (add it next to `STALE_STATE`, `DAILY_CALL_LIMIT`).
- Produces: `Store#finishCall(id, status, usage = {}, costInr = 0)` stores `cost_inr`; `Store#spendInr({ month } | { day } | { since }) → number` sums `cost_inr` for rows whose IST month/day matches (convert the stored ISO timestamp, do not prefix-match UTC), or whose timestamp is at or after the ISO `since`.
- Produces: `DEFAULT_SETTINGS.shadow` and its validation in `validateSettings` (new top-level group `shadow`).
- Produces: `TradingEngine#callReviewer` passes `{ monthlySpendCapInr: state.settings.shadow.monthlySpendCapInr }` to `reserveCall` and `modelCostInr({ model: config.model, ...result.usage, usdInr: state.settings.shadow.usdInr })` to `finishCall`; it computes the price before reserving, so an unpriced model throws without a reservation.

- [ ] **Step 1: Write failing tests**

```js
// tests/costs.test.mjs
test('modelCostInr prices Haiku 5.5 tokens in rupees', () => {
  assert.equal(modelCostInr({ model: 'claude-haiku-5-5', inputTokens: 2_000_000, outputTokens: 1_000_000, usdInr: 88 }), 61.6);
  assert.throws(() => modelCostInr({ model: 'mystery-model', inputTokens: 1, outputTokens: 1, usdInr: 88 }), /No price for model mystery-model/);
});
test('istMonth rolls over at IST midnight, not UTC', () => {
  assert.equal(istMonth(Date.parse('2026-10-31T18:29:00Z')), '2026-10'); // 23:59 IST
  assert.equal(istMonth(Date.parse('2026-10-31T18:31:00Z')), '2026-11'); // 00:01 IST
});
// tests/store.test.mjs
test('monthly spend cap refuses a reservation without inserting a row', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const config = { provider: 'anthropic', model: 'claude-haiku-5-5', dailyCallLimit: 40 };
  const id = store.reserveCall(config, { monthlySpendCapInr: 1 }); store.finishCall(id, 'completed', { inputTokens: 1, outputTokens: 1 }, 1.5);
  assert.equal(store.spendInr({ month: istMonth(Date.now()) }), 1.5);
  assert.throws(() => store.reserveCall(config, { monthlySpendCapInr: 1 }), error => error.code === 'MONTHLY_SPEND_CAP');
  assert.equal(store.callCount(), 1);
});
test('an existing database gains the cost_inr column', t => { /* open a DB created with the old model_calls schema, then new Store(path); finishCall with cost works */ });
// tests/config.test.mjs
test('shadow settings default off and are bounded', () => {
  assert.deepEqual(DEFAULT_SETTINGS.shadow, { enabled: false, model: 'claude-haiku-5-5', monthlySpendCapInr: 1000, usdInr: 88, dailyCallLimit: 40 });
  for (const bad of [{ shadow: { monthlySpendCapInr: 10001 } }, { shadow: { usdInr: 10 } }, { shadow: { dailyCallLimit: 201 } }, { shadow: { model: 'bad model' } }, { shadow: { enabled: 'yes' } }, { shadow: { extra: 1 } }])
    assert.throws(() => validateSettings(bad), /shadow/);
});
// tests/engine.test.mjs
test('a paid review records its rupee cost and an unpriced model never reserves', async t => { /* engine with allowPaidCalls and a reviewer returning usage {inputTokens: 1000, outputTokens: 100}; after step, store row cost_inr === modelCostInr(...); switch model to 'mystery-model' → decision reason contains 'No price for model', callCount unchanged */ });
```

The two comment-bodied tests above are specified by their comments; write them in the file's existing style.

- [ ] **Step 2: Run** `npm test` — the new tests FAIL (missing exports/columns).
- [ ] **Step 3: Implement** the Produces items. Migration: on open, add `cost_inr REAL` to `model_calls` when `PRAGMA table_info(model_calls)` lacks it, as `src/store.mjs` already does for `state.revision`. Engine constructor backfills `this.state.settings.shadow ??= DEFAULT_SETTINGS.shadow` like the other `??=` defaults.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` — all pass.
- [ ] **Step 5: Commit** `feat: rupee spend meter and shadow settings`

---

### Task 2: Signal-bar reviews, settings override, low effort

**Files:**
- Modify: `src/engine.mjs` (`step` reviewer condition, decision fields, `beginLive`), `src/models.mjs` (Anthropic body)
- Test: `tests/engine.test.mjs`, `tests/models.test.mjs`

**Interfaces:**
- Consumes: Task 1 `callReviewer` behaviour.
- Produces: in `step`, the reviewer runs only when `!position && !s.riskLatched && mode === 'auto' && provider !== 'rules' && captured.candidates.some(c => c.action === 'BUY')`; every decision gains `signalBar: boolean` (the same `candidates.some(...)` test, computed for every stock without a position; `false` for held stocks).
- Produces: `beginLive({ rows, assets, source, settings })` — optional `settings` (a full settings object without `version`) is validated with `validateSettings(settings, this.state.settings)` and used for the fresh run instead of `this.state.settings`.
- Produces: Anthropic request body includes `output_config: { effort: 'low', format: { type: 'json_schema', schema } }`.

- [ ] **Step 1: Write failing tests**

```js
test('reviewer is called only on signal bars and never for held stocks', async t => {
  // auto mode, provider anthropic, allowPaidCalls, reviewer counts calls.
  // Bar where no candidate says BUY → 0 calls, decision.signalBar === false.
  // Bar where momentum says BUY → 1 call, decision.signalBar === true.
  // Held stock → 0 calls, decision.signalBar === false.
});
test('a review picking a disabled strategy is a failed review and opens nothing', async t => {
  // enabled ['momentum']; reviewer returns { strategyId: 'mean_reversion', ... } on a signal bar
  // → no position; decision.reason starts with 'AI unavailable: Reviewer selected an unsupported strategy.'
});
test('beginLive can start a run with overriding settings', t => {
  // engine.beginLive({ rows, assets, source: 'shadow', settings: { ...engine.state.settings, version: undefined, strategy: { mode: 'auto', enabled: ['momentum', 'mean_reversion'] } } })
  // → state.settings.strategy.mode === 'auto'; main settings object of the caller untouched.
});
// tests/models.test.mjs
test('Anthropic review requests low effort with the JSON schema format', async () => {
  // capture fetch body → body.output_config.effort === 'low' && body.output_config.format.type === 'json_schema'
});
```

- [ ] **Step 2: Run** `npm test` — new tests FAIL.
- [ ] **Step 3: Implement** the Produces items.
- [ ] **Step 4: Run** `npm test` — all pass, including the existing held-position and model-failure tests unchanged.
- [ ] **Step 5: Commit** `feat: review only on signal bars; low-effort Anthropic reviews`

---

### Task 3: ShadowRunner

**Files:**
- Create: `src/shadow.mjs`, `tests/shadow.test.mjs`

**Interfaces:**
- Consumes: Task 2 `beginLive({ ..., settings })`, `decision.signalBar`; Task 1 `Store#spendInr`, `istDay`, `istMonth`.
- Produces: `export class ShadowRunner`
  - `constructor({ mainEngine, store, reviewer = reviewMarket, allowPaidCalls, hasKey = Boolean(process.env.ANTHROPIC_API_KEY), log })` — builds `this.engine = new TradingEngine(store, { reviewer, allowPaidCalls })`.
  - `active() → { on: boolean, reason: string|null }` — reasons, first that applies: `'Anthropic API key not configured'`, `'Paid model calls are disabled'`, `'AI shadow is turned off in settings'`, `'AI shadow stopped: <redacted message>'`.
  - `settingsFor(main) → settings` — main settings with `strategy.mode = 'auto'` and `model = { provider: 'anthropic', model: main.shadow.model, maxOutputTokens: 4000, timeoutMs: 30000, dailyCallLimit: main.shadow.dailyCallLimit }`, `version` removed.
  - Mirror methods, each enqueued on the runner's own promise chain and returning immediately: `beginLive({ rows, assets, source })`, `appendBar(row)`, `catchUp()`, `step({ blockEntries })`. Each is a no-op while `active().on` is false, except that `beginLive` is the only call that starts a shadow run (an `appendBar`/`step` before any shadow live run is skipped). Any thrown error sets `stopped = redact(message)` until the next `beginLive` on a new IST day.
  - `idle() → Promise` resolving when the queue is drained (for tests and shutdown).
  - `status() → { state: 'off'|'on'|'stopped', reason, callsToday, failedCallsToday, spendInrToday, spendInrMonth }`.
  - `report(day, mainEngine) → section` (synchronous): `{ state, reason, equity, realizedPnl, fees, netAfterFixedCosts, aiSpendInrToday, aiSpendInrMonthToDate, netAfterAiSpend, calls, failedCalls, signalBars, disagreements }`, with `netAfterFixedCosts` computed as in `TradingEngine#dailyReport` and `netAfterAiSpend = netAfterFixedCosts − spendInr for all months of this shadow run` (`store.spendInr({ since: <ISO time of this shadow run's beginLive> })`).
- Disagreements: for each shadow decision with `signalBar` on `day` (IST), find the main-engine decision with the same `symbol` and `timestamp`; a disagreement when `shadowDecision.strategyId !== mainDecision.strategyId`. `closeAtSignal` is the close of the bar at `timestamp`; `closeAfter1/4/8` are closes 1, 4 and 8 rows later in the shadow dataset, `null` if not yet present.

- [ ] **Step 1: Write failing tests** (scripted reviewer returns picks from a queue; in-memory stores; fixture rows from `tests/live.test.mjs`'s `warmupBars` helper copied locally)

```js
test('off with the right reason and zero reviewer calls', ...);           // no key → 'Anthropic API key not configured'; key but allowPaidCalls false → 'Paid model calls are disabled' (Review Focus 1); settings off → 'AI shadow is turned off in settings'
test('mirrors bars and blockEntries; picks change only the shadow book', ...); // main and shadow get the same rows; shadow reviewer picks 'none' on a signal bar where rules buy → main has a position, shadow has none; disagreement listed with rulesPick 'momentum', aiPick 'none'
test('a throwing reviewer leaves shadow on with pick none; a failing store stops it', ...); // reviewer throws → decision reason 'AI unavailable: ...', state 'on'; shadow store save throws → state 'stopped', later bars ignored
test('enabling mid-day waits for beginLive; disabling stops calls at the next bar', ...);   // Review Focus 3
test('report computes spend, net after AI spend and later closes', ...);   // seed model_calls costs; assert netAfterAiSpend arithmetic and closeAfter1/4/8 with nulls at the end of the day
test('two runs with the same scripted picks give identical shadow ledgers', ...);
```

- [ ] **Step 2: Run** `node --test tests/shadow.test.mjs` — FAIL (module missing).
- [ ] **Step 3: Implement** `src/shadow.mjs` per the Interfaces block.
- [ ] **Step 4: Run** `npm test` — all pass.
- [ ] **Step 5: Commit** `feat: isolated AI shadow runner`

---

### Task 4: Wire into LiveRunner, server, reports and backups

**Files:**
- Modify: `src/live.mjs`, `src/server.mjs`, `src/engine.mjs` (`dailyReport` accepts `shadow`), `deploy/backup.mjs`
- Test: `tests/live.test.mjs`, `tests/server.test.mjs`, `tests/backup.test.mjs`

**Interfaces:**
- Consumes: Task 3 `ShadowRunner` (mirror methods, `status`, `report`, `idle`).
- Produces: `LiveRunner` constructor option `shadow` (default `null`). After `engine.beginLive(...)` succeeds in `warmup` → `shadow?.beginLive(sameArgs)`; after each `engine.appendBar(row)` in `warmup` → `shadow?.appendBar(...)`; after `engine.catchUp()` → `shadow?.catchUp()`; in `handleRow`, after the main `step` resolves → `shadow?.appendBar(row)` then `shadow?.step({ blockEntries })`. `runner.status().shadow = shadow?.status() ?? { state: 'off', reason: 'Not configured' }`. `idle()` also awaits `shadow?.idle()`.
- Produces: `TradingEngine#dailyReport(day, dataQuality, shadow = null)` stores `shadow` in the payload; `LiveRunner#writeReport` passes `this.shadow?.report(day, this.engine) ?? null` after `await this.shadow?.idle()`.
- Produces: `createApplication` builds `new ShadowRunner({ mainEngine: engine, store: new Store(shadowDbPath), allowPaidCalls: allowPaidModelCalls })` whenever Kite is configured, where `shadowDbPath = dbPath === ':memory:' ? ':memory:' : resolve(dirname(dbPath), 'shadow.sqlite')`; options `shadowReviewer` (tests) and `shadowHasKey` override. `close()` awaits `shadow.idle()` then closes its store. `kiteStatus()` includes `shadow: shadow.status()`.
- Produces: `backup({ ... })` also copies `shadow.sqlite` from the same directory when it exists, as `shadow-YYYY-MM-DD.sqlite`; result gains `shadow` (path or `null`).

- [ ] **Step 1: Write failing tests**

```js
// tests/live.test.mjs
test('shadow on or off leaves the main ledger identical on the tick fixture', ...);   // run fixture twice: no shadow, and shadow with a reviewer that throws + one that picks 'none'; compare ledger() strings
test('the daily report carries the shadow section', ...);                            // closing the session → store.dailyReports()[0].shadow.state === 'on' and has netAfterAiSpend
test('restart mid-day continues the same shadow run', ...);                          // Review Focus 5: first runner live with shadow; second runner on the same stores catches up; shadow runId unchanged
// tests/server.test.mjs
test('kite status reports shadow off with its reason', ...);                         // no key → status.shadow.reason === 'Anthropic API key not configured'
// tests/backup.test.mjs
test('backup also copies shadow.sqlite when present', ...);
```

- [ ] **Step 2: Run** `npm test` — new tests FAIL.
- [ ] **Step 3: Implement** the Produces items.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` — all pass.
- [ ] **Step 5: Commit** `feat: wire AI shadow into the live runner, server, reports and backups`

---

### Task 5: Dashboard and docs

**Files:**
- Modify: `public/index.html`, `public/app.js`, `deploy/README.md`, `docs/RESUME-PLAN.md`, `.env.example`

**Interfaces:**
- Consumes: `snapshot.kite.shadow` (Task 4), `settings.shadow` (Task 1), report `shadow` section (Task 4).
- Produces (UI copy is fixed here):
  - Configuration form, new fieldset "AI shadow": checkbox `shadowEnabled` "Run AI shadow ledger", text `shadowModel`, numbers `shadowMonthlySpendCapInr` "Monthly AI spend cap (INR)", `shadowUsdInr` "USD→INR rate", `shadowDailyCallLimit` "Daily AI call limit". Saved as `settings.shadow`.
  - Broker panel line `#shadow-state`: `AI shadow off · <reason>` / `AI shadow on · <calls> calls today · ₹<spend> this month` / `AI shadow stopped · <reason>`.
  - Reports table: two columns after "Net after fixed costs": "AI net" (`shadow.netAfterAiSpend`, `—` when absent) and "AI spend" (`shadow.aiSpendInrToday`).
  - Reports view panel "AI vs rules" listing the latest 20 disagreements across reports: time, symbol, rules pick, AI pick, AI summary, close at signal → after 1/4/8 bars.
  - `.env.example`: comment above `ANTHROPIC_API_KEY` — "Used only by AI shadow mode; also set TRADING_LAB_ALLOW_PAID_MODEL_CALLS=1 and turn on AI shadow in Configuration."
  - `deploy/README.md`: a short "AI shadow mode" section (enable steps, spend cap, `shadow.sqlite` path and backup); `docs/RESUME-PLAN.md`: Phase 1b build entry.

- [ ] **Step 1:** Implement the UI pieces; `node --check public/app.js`.
- [ ] **Step 2:** Browser check on a scratch database: shadow line reads "AI shadow off · Anthropic API key not configured"; the form saves `shadow.enabled`; a scratch report with a `shadow` section shows AI net/spend and one disagreement row; no console errors.
- [ ] **Step 3:** Update the docs listed above.
- [ ] **Step 4: Run** `npm test` — all pass.
- [ ] **Step 5: Commit** `feat: AI shadow dashboard and docs`
