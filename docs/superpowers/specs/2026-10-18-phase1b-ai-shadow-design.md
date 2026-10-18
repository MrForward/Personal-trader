> **Superseded on 18 October 2026** by [the expert shadow design](2026-10-18-phase1b-expert-shadow-design.md); not to be implemented.

# Phase 1b — AI shadow mode

- **Date:** 18 October 2026, Asia/Kolkata
- **Status:** Design approved in conversation; written for owner review. Nothing in it is built.
- **Goal served:** [GOAL.md](../../GOAL.md) Phase 1b: "model profile runs in shadow (proposals recorded, not executed)… shadow proposals beat rules on the same period, after model cost".
- **Builds on:** [Phase 1 design](2026-10-17-phase1-live-paper-design.md) (live bars, LiveRunner, daily report).

## 1. What it answers

Does an AI's strategy choice beat the deterministic rules **after its own cost**, on the same live bars? The rules keep running the real paper ledger. The AI runs a second, separate paper ledger that is identical in every respect except who picks the strategy. Nothing the AI decides reaches the main ledger or the broker.

**Decided with the owner (18 Oct 2026):**

| Decision | Choice |
|---|---|
| AI's job | Pick `momentum`, `mean_reversion` or `none` for a stock, with thesis, evidence, counter-evidence, invalidation. Sizing, charges, stops and exits stay the engine's. |
| When it is asked | Signal bars only: the shadow book holds no position in that stock and at least one enabled strategy's rules say BUY. |
| Model | Anthropic, Claude Haiku 5.5 (`claude-haiku-5-5`), configurable model ID. Owner has a key. |
| Spend cap | ₹1,000 per calendar month (IST). |
| Approach | Second engine with its own database, fed the same bars (rejected: second book inside one engine; scoring picks offline). |

## 2. Cost

Claude Haiku 5.5: $0.10 per million input tokens, $0.50 per million output tokens (Anthropic API price list, checked 18 Oct 2026; prompts under 100K tokens). A signal-bar review is about 2.5K input and up to ~1K output tokens including thinking, so roughly $0.0008 a call. At ~20 calls a trading day that is about ₹30 a month. The ₹1,000 cap is a ceiling, not a forecast; the daily report shows actual spend.

**Proposed, for the owner to confirm in review:** raise GOAL.md's monthly spend cap from ₹1,200 to ₹2,500 (Kite data ₹500 + VPS ~₹600, credit-covered for now + AI ₹1,000 ceiling + margin). GOAL.md is changed only after that confirmation.

## 3. Architecture

```
LiveRunner ── closed bar ──▶ main engine: appendBar + step         (rules; data/trading-lab.sqlite; unchanged)
     │
     └─────── same bar, same blockEntries ──▶ ShadowRunner
                                               ├─ shadow engine: appendBar
                                               ├─ shadow engine: step  ── signal bar? ──▶ reviewer (Claude) ──▶ pick
                                               └─ errors caught and counted; never thrown to LiveRunner
                                               (data/shadow.sqlite)
```

### New: `src/shadow.mjs`

`ShadowRunner` owns a `Store` on `data/shadow.sqlite` (beside the main database, same directory as `TRADING_LAB_DB_PATH`) and a `TradingEngine` built with the real `reviewMarket` adapter and `allowPaidCalls` from the server. Its settings mirror the main engine's (universe, bar size, risk, costs, starting capital) with two overrides: `strategy.mode = 'auto'` and `model = { provider: 'anthropic', model: <shadow model id>, ... }`.

It exposes the calls LiveRunner already makes on the main engine and mirrors them:

| Main engine call | Shadow mirror |
|---|---|
| `beginLive({ rows, assets, source })` | Same rows and assets; also resyncs settings from the main engine. |
| `appendBar(row)` | Same row. |
| `catchUp()` | Same. |
| `step({ runId, expectedCursor, blockEntries })` | Its own `runId`/cursor, the same `blockEntries`. |
| `dailyReport(day, dataQuality)` | Shadow section built from its own ledger and spend (§6). |

Every mirror call is wrapped: an exception is logged (redacted), counted in `shadow.status().errors`, and the shadow is marked `stopped` for the rest of the IST day. A `stopped` shadow ignores further bars until the next `beginLive`/`start`. LiveRunner's own behaviour, timing and ledger are identical whether shadow is on, off or stopped.

Shadow is **off** (not constructed) unless all of these hold: `ANTHROPIC_API_KEY` set, `TRADING_LAB_ALLOW_PAID_MODEL_CALLS=1`, and `settings.shadow.enabled = true` (new setting, default `false`).

### Changed: `src/engine.mjs`

The reviewer is called only on a **signal bar**: no position in the stock, no risk latch, mode `auto`, provider not `rules`, **and** at least one enabled strategy's `evaluateStrategy(...)` returns `BUY` for this bar. Today it is called for every stock without a position. The main engine is unaffected (it runs `rules`). Decisions record `signalBar: true|false`.

### Changed: `src/models.mjs`

For the Anthropic provider the request adds `output_config.effort = 'low'` alongside the existing `output_config.format` JSON schema, and the shadow profile uses `maxOutputTokens: 4000` (the existing validated maximum) so adaptive thinking cannot truncate the answer. A response with `stop_reason` other than `end_turn` is already rejected as a failed review; that stays. The adapter keeps its raw `fetch` call to `POST /v1/messages` with `anthropic-version: 2023-06-01` — it is existing, tested code with no SDK dependency, and replacing it is out of scope.

### Changed: `src/live.mjs`

`LiveRunner` accepts an optional `shadow` and calls the mirror after each main-engine call, inside the same serial queue, after the main call has committed. `shadow.status()` is included in `runner.status()`.

## 4. Spend meter

- `model_calls` gains `cost_inr REAL` (nullable, `ALTER TABLE ... ADD COLUMN` on open, like the existing `revision` migration).
- `src/costs.mjs` gains `MODEL_PRICES = { 'claude-haiku-5-5': { inputPerMTokUsd: 0.10, outputPerMTokUsd: 0.50 } }` with the check date in a comment, and `modelCostInr({ model, inputTokens, outputTokens, usdInr })`. An unknown model ID is refused for shadow use until its price is added (no silent zero-cost calls).
- Settings gain `shadow: { enabled: false, model: 'claude-haiku-5-5', monthlySpendCapInr: 1000, usdInr: 88, dailyCallLimit: 40 }`, validated like other settings (cap 0–10,000; usdInr 50–150; daily limit 0–200).
- Before each call the shadow checks, in order: month-to-date `SUM(cost_inr)` for the current IST month < cap; today's call count < daily limit. Either failing → no request; the decision's pick is `none` with reason `AI spend cap reached` or `AI daily call limit reached`.
- `finishCall` stores `cost_inr` computed from the response's reported usage. A failed call with no usage stores `0` and status `failed`.

## 5. Failure behaviour

| Situation | Shadow behaviour | Main bot |
|---|---|---|
| Timeout, HTTP error, refusal, schema-invalid or truncated answer | Pick `none`, reason `AI unavailable: <redacted reason>`; call logged failed. Shadow positions keep their stops and exits. | Unaffected |
| Spend cap or daily limit reached | Pick `none`, reason states which; no request sent | Unaffected |
| Shadow database/store error, or any thrown error in a mirror call | Shadow `stopped` for the day; dashboard shows "AI shadow stopped: <reason>" | Unaffected |
| Universe or bar size change | Shadow starts a new run when the main engine does | — |
| Paid calls disabled or key missing at start | Shadow off; dashboard shows why | Unaffected |

Secrets (Anthropic key, Kite token, Kite secret) never enter a prompt, log, audit row or report; the adapter's existing secret check and `redact()` cover it.

## 6. Reports

**Daily report** gains `shadow`:

- `equity`, `realizedPnl`, `fees`, `netAfterFixedCosts` (same formula as the main report), `aiSpendInrToday`, `aiSpendInrMonthToDate`, `netAfterAiSpend` = shadow net after fixed costs − AI spend to date.
- `calls`, `failedCalls`, `signalBars`.
- `disagreements`: for each signal bar today where the shadow pick differs from what the main engine's rules chose for the same symbol and bar — `{ timestamp, symbol, rulesPick, aiPick, aiSummary, closeAtSignal, closeAfter1, closeAfter4, closeAfter8 }` (later closes filled when available within the day, else `null`).

**Dashboard:** the Reports table gains "AI net" and "AI spend" columns. A new "AI vs rules" panel on the Reports view lists recent disagreements with the AI's thesis, evidence, counter-evidence and invalidation. The Kite/broker panel shows shadow state: off (why), on (calls today, spend this month), or stopped (why).

## 7. Phase 1b scorecard (added to GOAL.md)

Over the same 40 clean sessions as Phase 1 (data-quality-flagged days excluded):

1. Shadow book `netAfterAiSpend` > main book `netAfterFixedCosts` on the same days.
2. At least 20 disagreements in total; fewer means too little evidence to decide either way.

Passing does not switch anything. Letting the AI pick for the main paper ledger is a separate owner decision.

## 8. Testing

No test makes a real API call; the reviewer is injected.

- Signal bar: reviewer called only with no position, no latch, `auto`, and a BUY candidate; never for a held stock; decision carries `signalBar`.
- Spend meter: `modelCostInr` math; refusal at the cap with no request; month rollover by IST; daily limit; unknown model refused.
- Isolation: with a reviewer that throws, one that times out, and a shadow store whose `save` throws, the main ledger after the recorded tick fixture is byte-identical (same `trades`, `decisions` outcomes, equity) to a run with shadow off; shadow ends `stopped` only for the store failure.
- Mirror: the shadow sees the same bars and `blockEntries` as the main engine; restart/catch-up mirrored.
- Determinism: fixture + scripted AI picks → identical shadow ledger twice.
- Report: disagreements and later closes computed; `netAfterAiSpend` arithmetic.
- Adapter: Anthropic request body contains `output_config.effort: 'low'` and the JSON-schema format.

## 9. Out of scope

News or filings in the AI's context (market-intelligence piece), several models side by side, Jev AI, the AI sizing or exiting trades, the Anthropic TypeScript SDK migration, and any path from the shadow book to real orders.
