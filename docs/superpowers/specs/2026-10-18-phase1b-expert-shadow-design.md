# Phase 1b — Expert decision layer in shadow, on the Phase 1 live stream

- **Date:** 18 October 2026, Asia/Kolkata
- **Status:** Design for owner review. Nothing in it is built. Phase 1 code is not changed by this design except where §4 and §7 say so.
- **Goal served:** [GOAL.md](../../GOAL.md) Phase 1b: "model profile runs in shadow; news/evidence capture. Exit bar: shadow proposals beat rules on the same period, after model cost."
- **Requirements served:** PRD R-017 (domain context), R-018 (decision procedure), R-019 (learning memory), R-020–R-022 (sources, available time, bounded intelligence), R-015 (comparable reports), R-011 (isolated agent permissions).
- **Owner decisions taken on 18 October 2026:** expert decisions run in a second paper book; the expert may enter, tighten a stop and exit early, never size or widen; Phase 1b runs alongside Phase 1 on the same sessions once the feed is stable; model calls use the owner's Claude Max subscription through the unmodified Claude Code binary, with no API key on the VPS.
- **Owner decision, 27 October 2026 (paper only):** reversing "never size", the expert's decision now carries a `confidence` (0–1) that scales its risk per trade from 0.25× to 2× of the base, capped at `expert.maxRiskPerTradePct` (default 1%); the cap limits only the scale-up. Every other limit (position, exposure, daily loss, drawdown, tighten-only stops) stays deterministic, and the rules book keeps fixed sizing. Calibration (win rate and average result by confidence bucket) is in the expert daily report.

## 1. Why this design and not a selector

The existing reviewer in `src/models.mjs` picks momentum, mean reversion or none from 15-minute price features. That measures nothing the goal asks for: an experienced trader reads context, forms a thesis, decides whether to act, manages the position and learns from the outcome. Phase 1b builds that loop, bounded, and scores it against the rules on identical data. A rules selector remains available as the `rules` provider for comparison; it is not the Phase 1b experiment.

## 2. Shape: two paper books on the same ticks

```
Kite ticks ─▶ bars.mjs ─▶ LiveRunner ─┬─▶ Engine A (rules book)   ─▶ trading-lab.sqlite
                                      └─▶ Engine B (expert book)  ─▶ trading-lab-expert.sqlite
                                                 ▲
             research.mjs (08:30 + anomaly) ─▶ intelligence records (both engines read them)
             expert.mjs (context pack, thesis, decision, scoring) ◀─▶ claude -p
```

- Engine A is Phase 1 unchanged. Engine B is a second `Engine` instance over its own `Store`, with the same settings, cost schedule, sizing, protective stops and risk caps. The only difference is the decider (§4). No ledger refactor; Phase 1 verification stands.
- Both engines receive every closed bar in the same `LiveRunner` turn, A first. A thrown error in B never blocks A.
- Both books start on the same session with the same starting capital. The daily report carries both, plus buy-and-hold (§6).

## 3. Context pack (R-017)

`expert.mjs` builds a deterministic, versioned context pack per symbol at decision time. Target 6K tokens; hard cap 60K characters, enforced before the call. Fields:

| Block | Content | Source |
|---|---|---|
| `price` | Existing 15-minute features (`analyzeMarket`), last 60 daily bars (OHLCV), today's range and volume vs 20-day average, NIFTY 50 and the stock's sector index daily closes over the same 60 days | Kite historical API at warmup (daily, cached per day), live bars |
| `evidence` | The symbol's intelligence claims as `intelligenceContext()` returns them at `asOf`: content, verification status, published/first-received/analysis-ready times, stale and disputed flags, coverage summary | `src/intelligence.mjs`, fed by §5 |
| `calendar` | Next results date if known, corporate actions, macro releases this week (RBI policy, CPI, GDP), NSE holidays | Research records of kind `calendar`; `src/calendar.mjs` |
| `portfolio` | Cash, equity, exposure, held position with stop and target, open thesis on this symbol | Engine B state |
| `memory` | Last five decision records on this symbol with their scored outcomes and lessons (§6) | `expert_memory` table |
| `limits` | Risk settings, that sizing and protection are deterministic, remaining daily call budget | settings |

Index and sector series are new Kite historical fetches (symbols `NIFTY 50` and the sector index per universe symbol, mapped in a hand-maintained table in `expert.mjs`). Fetched once per session day at warmup and stored with the day; a fetch failure leaves the block `unavailable` and is reported, it does not block decisions.

Everything in the pack is labelled with its own timestamp. Nothing in it may postdate `asOf` (R-020). A unit test appends later bars and later evidence and asserts the pack for an earlier `asOf` is byte-identical.

## 4. Expert decisions (R-018)

### Calls

Two call types, both through the runner in §7 with a strict JSON schema and no tools.

**Pre-open thesis**, one per universe symbol at 08:45 IST after research (§5) has finished, or at warmup if the process starts later. Output:

```
stance: avoid | watch | candidate
thesis: text ≤ 1500
mechanism: text ≤ 500            (what would make the move happen)
counterEvidence: string[] ≤ 8
evidenceIds: string[]            (intelligence record ids cited; validated to exist)
entryCondition: { type: 'rulesSignal' | 'priceAbove' | 'priceBelow', level?: number }
invalidation: { priceBelow: number, note: text ≤ 300 }
expectedHoldSessions: 1..5
expiresAt: ISO time ≤ end of session + expectedHoldSessions
eventAssessment: { novelty, materiality, surprise, reaction }  each 'unknown' | text ≤ 200
```

**Decision call**, only when a trigger fires for a symbol:

| Trigger | Condition |
|---|---|
| Entry | stance `candidate`, no position, and the entry condition is met on the closed bar (rules BUY signal, or price crossed the level) |
| Invalidation | held expert position and the bar's low ≤ the thesis invalidation level |
| New evidence | held expert position and a new intelligence record for the symbol became analysis-ready since the last call |
| Stale review | held expert position and two sessions since the last decision call on it |

Output:

```
action: enter | hold | exit | abstain
reason: text ≤ 1000
counterEvidence: string[] ≤ 8
evidenceIds: string[]
tightenStopTo: number | null     (accepted only if above the current stop)
invalidation: { priceBelow, note }  (may only move up for a held position)
```

Expected volume: 10 theses plus 5–15 decisions per session.

### What the engine enforces

Engine gains one optional constructor option, `decider`. When present, `step()` calls it instead of the reviewer/`evaluateStrategy` path for every symbol; every position Engine B opens carries `strategyId: expert`. Everything else in `step()` is unchanged:

- **Sizing** is the existing deterministic code. The decider never supplies a quantity.
- **Stops**: initial stop and target come from risk settings exactly as today. `tightenStopTo` is applied only if it is higher than the current stop, through the existing logged stop-update path with prior/new values and reason (R-005). A lower value is rejected and recorded as `Rejected: stop widening`.
- **Protective exits** (gap stop, stop, target, trailing) run on price before any decider output is considered, as today.
- **Risk caps** (daily loss, drawdown, exposure, intelligence veto, `blockEntries`) reject an `enter` exactly as they reject a rules BUY.
- **Model failure** (timeout, limit hit, schema violation, subprocess error): the decision is recorded with `outcome: 'Suppressed: <reason>'`, no new entry, held positions keep mechanical rules. A failure on a held position's call does not exit it.
- **Expiry**: a thesis past `expiresAt` reverts the stance to `watch`; an `enter` against an expired thesis is rejected.

Every decision record stores the full context pack, the raw structured output, the runner's usage and estimated cost, model id, prompt version and the trigger. Prompt text and rubric are versioned files in `src/prompts/`; their hash is in the record.

## 5. Research worker (R-020 to R-022)

`research.mjs` runs off the price path, in the same process but never inside a bar step.

- **Pre-session pass**, 08:30 IST on trading days: one call per universe symbol and one market call, model Sonnet 5.5, tools WebSearch and WebFetch only, at most 4 fetches per call, 3 turns, 120 s timeout.
- **Anomaly pass**, during the session: when a universe symbol's closed bar has range > 2 × ATR or volume > 3 × its 20-day average bar volume, one research call for that symbol; at most 5 per session.
- **Allow-list** (owner confirms before Task 3): `nseindia.com`, `bseindia.com`, `rbi.org.in`, `sebi.gov.in`, each universe company's investor-relations domain, and four publishers: `reuters.com`, `livemint.com`, `business-standard.com`, `economictimes.indiatimes.com`. Enforced twice: as `WebFetch(domain:…)` permission rules on the call, and in code, where any record whose `sourceUrl` host is not on the list is dropped and counted.
- **Output**: records in the existing intelligence schema (`validateIntelligence`), with `firstReceivedAt` and `analysisReadyAt` set by the worker at capture, `publishedAt` as the source states it, `verificationStatus` as the model labels it from the explicit states, `origin` keyed to the underlying report so syndicated copies merge, `sourceKind` from the list. Calendar items are records of kind `calendar` with `eventAt`.
- **Policy**: retrieved text is evidence, never instruction; the system prompt says so and the schema admits no free-form fields beyond `content`. The model cannot see portfolio state. Rumour-only claims stay `unverified` and the existing `intelligenceContext()` veto applies to both books.
- **Failure**: a failed or empty pass logs coverage as missing for that symbol; theses still run with `evidence.coverage` saying so. No price-only silent fallback: the thesis output must set `eventAssessment` fields to `unknown` when evidence is missing, and the scorecard counts sessions by coverage.

## 6. Scoring and memory (R-019, R-015)

Fixed before the first 1b session; changing it is a new experiment version.

**Nightly, deterministic**, after the daily report: for each decision record of the day and each open thesis:
- `invalidationHit`: did price touch the invalidation level within the expected hold?
- `mfe`, `mae`: best and worst excursion from the decision bar's next open within the expected hold, in %.
- `realised`: P&L of the resulting position if any, after costs.
- `rulesSameWindow`: what Engine A did on the same symbol over the same window (entered, result), for both actions and abstentions.
- `thesisScore`: `held` (invalidation never hit and the position or thesis reached expiry or target), `invalidated`, `expired`.

**Nightly review call**, Sonnet 5.5, one per expert position closed that day: input is the decision record chain and scored outcomes; output `{ lesson ≤ 500, decisionQuality: good | poor | lucky | unlucky, note }`. Stored in `expert_memory` with the review timestamp; the context pack includes a lesson only when `asOf` ≥ that timestamp, so replay cannot see hindsight.

**Daily report** adds: expert book equity, open theses, decisions and suppressions with causes, calls and estimated cost, coverage, and a three-line comparison: rules book, expert book, buy-and-hold, all after costs, with model cost as a separate line (₹0 marginal under the subscription; the estimated API-equivalent is shown for information).

**40-session scorecard**: expert net vs rules net vs buy-and-hold; thesis accuracy (`held` / all); abstention value (rules P&L on trades the expert declined); suppressed-call count; sessions with missing coverage; the Phase 1b exit bar from GOAL.md answered yes or no.

## 7. Model runner: Claude Max subscription via Claude Code

The owner's decision is to use the subscription, not an API key. Documented path (code.claude.com/docs/en/authentication, /headless, /cli-reference, checked 18 October 2026):

- `claude setup-token` on the owner's Mac issues a one-year OAuth token for the Max plan. It goes into `/etc/trading-lab.env` as `CLAUDE_CODE_OAUTH_TOKEN`, mode 600, never logged or exported. **No `ANTHROPIC_API_KEY` may exist on the VPS**: in print mode a key silently takes precedence.
- The VPS gets the unmodified Claude Code binary (`npm i -g @anthropic-ai/claude-code`), pinned to the tested version in `deploy/README.md`.
- `models.mjs` gains provider `claude-code`. A call spawns `claude -p` with: `--output-format json`, `--json-schema <schema>`, `--model <id>`, `--system-prompt-file <versioned prompt>`, `--max-turns` (1 for decisions, 3 for research), `--max-budget-usd 0.50` as a runaway stop, and `--allowedTools` (empty for decisions; `WebSearch,WebFetch(domain:…)` for research). The context pack is the prompt on stdin. The result's `structured_output` is validated by the same schema validators as today; `usage` and `total_cost_usd` are recorded in `model_calls` (estimates, not billing). Exact flag spellings are confirmed against the installed CLI in Task 1 and recorded there.
- Models: Opus 5.5 (`claude-opus-5-5`) for theses and decisions; Sonnet 5.5 (`claude-sonnet-5-5`) for research and reviews. Owner-changeable in settings.
- **Limits**: the plan's 5-hour and weekly limits are shared with the owner's own Claude Code use. A limit hit returns a non-zero exit with a "hit your limit, resets at" message; the runner records it as `Suppressed: subscription limit until <time>` and makes no further calls until that time. Daily call cap (existing `dailyCallLimit`, default raised to 60) stays as the second guard.
- **Terms**: the Claude Code docs describe setup-token for "CI pipelines, scripts"; the consumer terms bar automated access in general. The owner accepts this on 18 October 2026 as a personal, non-intermediated use of the unmodified binary. Revocation pauses the expert layer only; protective exits and the rules book never depend on it.
- **Isolation** (R-011): the subprocess runs as the service user with `--allowedTools` restricted as above, no filesystem or shell tools, working directory an empty scratch dir, and no access to the Kite token or the database. Research calls never see portfolio state.

## 8. Replay and recovery (R-009)

- Every call's prompt, context pack, structured output and usage are stored in `model_calls` keyed by `(engine, symbol, trigger, asOf, promptHash)`. Replay mode (`replayCapture`) serves recorded outputs from that key and makes no subprocess call; a missing key is a replay error, never a live call. Replaying a day reproduces both ledgers exactly; `live.test.mjs` gains this assertion with a committed fixture of recorded outputs.
- Restart: Engine B loads from its own store like A. Open theses and today's research records are in the store, so a restart at 11:00 continues without re-running research. The 08:30 and 08:45 passes are idempotent per session day.
- Clock skew, feed gaps and `blockEntries` apply to both engines through the same `LiveRunner` call.

## 9. Operations and dashboard

- Settings gain `expert: { enabled, thesisModel, decisionModel, researchModel, maxResearchPerSession: 5, allowedDomains: [...] }`, versioned like the rest. `enabled: false` leaves Engine B idle and makes no calls.
- Dashboard gains one **Expert** panel: stance per symbol with expiry, open theses with invalidation levels, today's calls, suppressions and estimated cost, last research time and coverage, and the two-book equity line in the Reports view. Plain tables; no new styling.
- Backup timer includes `trading-lab-expert.sqlite`.
- Phase 1b starts after the owner sees three clean Phase 1 sessions (no data-quality flag) and confirms the universe and allow-list.

## 10. Testing

- `expert.test.mjs`: context pack determinism and `asOf` causality; schema validation rejects widened stops, unknown evidence ids, invalidation moved down, expired thesis entries; triggers fire exactly once per condition.
- `research.test.mjs`: mocked subprocess output → validated records; off-list URL dropped and counted; syndicated copies merge to one origin; timestamps set at capture.
- `models.test.mjs`: `claude-code` provider with a fake `claude` binary on PATH: success, schema violation, non-zero exit, limit-hit message parsing, timeout kill, budget flag present, no API key in the child env.
- `engine.test.mjs`: decider path: enter sized by existing code, tighten accepted/widen rejected, protective stop fires before decider output, model failure suppresses entry and keeps position.
- `live.test.mjs`: two engines on the recorded-tick fixture with recorded model outputs; replay twice, identical ledgers; Engine B error does not stop Engine A.
- Scoring: golden cases for `invalidationHit`, `mfe`/`mae`, `rulesSameWindow`, memory sealed from earlier `asOf`.
- Before the first 1b session, one manual check on the VPS: setup-token works for a `claude -p` hello call under the service user; research pass writes records; a thesis appears in the panel; a forced limit (set `dailyCallLimit: 1`) shows a suppression.

## 11. Open points you decide

1. Confirm the universe (Phase 1 placeholder) and the research allow-list in §5.
2. Sector index mapping per symbol (I propose it in Task 2 from NSE's published sector indices).
3. Whether `maxResearchPerSession` 5 and the anomaly thresholds are right; they are settings.
4. GOAL.md spend cap: the subscription makes marginal model cost ₹0; the ₹1,200 cap stays for data and VPS. Say if you want the API-equivalent estimate reported against a notional cap.

## 12. Implementation order

1. `claude-code` provider in `models.mjs` + fake-binary tests; confirm flags; runner isolation.
2. `expert.mjs` context pack + daily/index warmup + tests.
3. `research.mjs` + tests; owner confirms allow-list.
4. Engine `decider` option, tighten-only stop path, `expert` strategy id + tests.
5. Thesis and decision schemas, prompts in `src/prompts/`, triggers.
6. Second engine in `LiveRunner`, replay keying, backup; `live.test.mjs` two-book replay.
7. Scoring, nightly review, memory, daily report lines, scorecard.
8. Dashboard panel, settings, deploy README (setup-token steps, pinned CLI version), RESUME-PLAN update.
