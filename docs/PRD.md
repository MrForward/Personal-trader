# PRD — Personal AI Trading Expert

- **Date:** 13 October 2026, Asia/Kolkata
- **Product owner and decision owner:** the user
- **Status:** Draft — owner resumed local paper implementation on 13 October 2026
- **Version:** 0.3; continuous market intelligence and freshness workflow specified; requirements describe intended behavior unless explicitly marked implemented
- **Decision reference:** build toward a private financial trading expert, using the preserved paper prototype to evaluate its capabilities in stages
- **Related:** [Engineering Statement of Direction](ESOD.md), [PRFAQ](PRFAQ.md)
- **Retained context:** [Agreements and lifecycle tool plan](LIFECYCLE-AGREEMENTS.md); these operating requirements remain part of the expert-bot vision
- **Continuous research:** [Market intelligence and decision workflow](MARKET-INTELLIGENCE.md)

**Owner clarification, 13 October 2026:** The core product is a personal AI financial trading expert with the breadth, judgment and discipline expected of a seasoned professional with 20+ years of industry experience. Profitable deployment of the owner's capital is its intended purpose. The 20-year reference is a capability benchmark, not a claim of actual experience or a track record. Keep the interface minimal and private. Following the documentation pause, the owner explicitly resumed development; begin with the local paper stage.

## Problem and outcome

**Problem:** The owner wants to delegate market research, opportunity selection and position management to an AI system capable of making coherent professional trading judgments. It must connect market context, strategy knowledge, historical lessons, current evidence and portfolio conditions into a defensible decision about whether, when and how to trade. The problem is creating and demonstrating that judgment, rather than assembling isolated indicators or assuming a general model already possesses a profitable trading method.

**Product ambition:** A private AI financial trading expert that brings the breadth and discipline expected from a practitioner with 20+ years across market cycles. The benchmark means recognizing relevant patterns and failure modes, understanding regime changes, comparing strategies, weighing conflicting evidence, planning exits and managing positions consistently. Prompting a model to act experienced does not satisfy this requirement; knowledge, context, decision procedures, memory and evaluations must support the capability.

**Desired owner outcome:** Delegate most routine research and trade management to a capable expert bot that identifies worthwhile opportunities, acts within the agreed mandate, adapts to relevant market changes, learns from recorded decisions and seeks to grow the owner's capital. The owner retains control over capital, permitted risk and exceptional interventions. A simple control panel exposes the bot's thesis, decisions, positions and operating status.

**Capability outcomes:**

| Capability | Intended behavior |
|---|---|
| Understand the situation | Synthesize relevant live price/volume, volatility, liquidity, fundamentals, company filings/news, calendar and macro/sector context, permitted web research and portfolio exposure. Identify freshness gaps, source conflicts and unverified claims; assess current market reaction for the chosen horizon. |
| Exercise trading judgment | Form a thesis, examine contrary evidence, compare applicable strategies, identify entry/invalidation/exit conditions and abstain when the case is weak. |
| Manage a trade | Monitor whether the thesis remains valid, manage exits under the position's mandate, and distinguish a market change from an execution or data problem. |
| Apply accumulated knowledge | Retrieve relevant, sourced lessons from historical cases and its own recorded experiments; explain why an analogy applies or does not. |
| Improve systematically | Attribute outcomes to decisions, strategy, market conditions and execution; propose changes for separate evaluation rather than rewrite live behavior impulsively. |
| Operate reliably | Execute eligible actions, maintain truthful account state and recover from failure within deterministic controls. |

**Economic outcome:** Seek profitable capital growth after costs within the owner's accepted risk budget. Financial results test the usefulness of the expert capability; no guaranteed return or daily quota is assumed.

**Delivery approach:** Complete a local paper environment as the first proving ground for the expert bot. Start with bounded markets, horizons and strategy candidates so decisions can be evaluated; those initial candidates are scaffolding, not the full definition of the expert. Rules-only operation provides a baseline and fallback product option if model assistance adds no value. Resume implementation only on the owner's instruction.

**Recommendation confidence:** high that the vision requires explicit domain capability and staged evaluation; unknown whether the eventual bot will achieve expert-level judgment or a durable trading edge. Revisit direction when capability assessments, prospective results, costs or accepted limits change. This remains personal use with Zerodha, initial experimentation below ₹10,000 and no commercial launch objective.

### Facts, evidence, assumptions, and unknowns

| Classification | Current position |
|---|---|
| User-provided | Personal Zerodha account; initial capital below ₹10,000; a top-tier expert trading bot is the core ambition, with 20+ years used as a capability reference; configurable models, adaptive selection and editable settings desired; local development resumed after documentation review. |
| Aspiration | 1–2% daily returns. This is not a product acceptance target or guarantee. Over an illustrative 252 sessions, constant compounding gives approximately 12.274× or 146.975× final capital before friction; the arithmetic is not a forecast. No-trade days and losses remain valid outcomes. |
| Recorded software evidence | Seven strategy tests and 15 mocked model-adapter tests passed before the pause. They verify covered software behavior, not trading returns, live provider behavior, or the complete application. No tests were rerun for this document. |
| Partial implementation | Strategy, synthetic-data, and model modules exist. Engine, store, configuration, and dataset code are drafted and untested. `server.mjs` and browser `app.js` are absent; HTML/CSS are partial; eve agent instructions remain placeholders. This is not a runnable, validated full application. |
| Assumption | Begin real-market research with a small, affordable cash-equity, long-only universe. Confirm instruments, timeframe, and holding horizon before collecting evidence. |
| Unknown | Maximum accepted loss, approved daily/drawdown limits, exact live allocation, model/data/hosting budget, strategy edge, and criteria sufficient for any live pilot. Existing code defaults are simulation placeholders, not approved risk settings. |

## Hypothesis

If the bot combines verified market context, sourced financial/strategy knowledge, historical cases, explicit decision procedures and memory of its own results, it may produce more coherent and useful trading judgments than isolated signals or an unconstrained model prompt. Evaluate that hypothesis using time-correct unseen scenarios and prospective comparisons against simpler baselines. Logging, simulation and accounting provide the evidence needed to assess its expertise; they are supporting infrastructure rather than the product's primary ambition. Economic usefulness remains a separate measured outcome.

## Scope

### In scope

- An expert-capability architecture: context synthesis, sourced trading knowledge and case retrieval, thesis/counter-thesis formation, strategy comparison, position judgment and outcome review. Deliver these incrementally; their existence is not yet verified.
- Continuous, bounded market research using approved feeds and read-only web search/document retrieval. News, event calendars and permitted social claims complement current broker prices. Source qualification, timestamps, corrections, deduplication and coverage are explicit; provider selection remains open.
- Local historical replay and clearly labeled fictional synthetic data; prospectively recorded live-market paper trading as a later stage.
- Momentum and mean-reversion research candidates, an explicit buy-and-hold baseline, fixed-strategy comparisons, and a no-trade option.
- Rules, OpenAI, and Anthropic profiles initially; provider/model IDs, reasoning options where supported, and a documented extension boundary for future providers.
- Versioned configuration, risk controls, position management, cost accounting, experiment reports, durable logs, and operator controls.
- Kite authentication and data integration planning; any real-order adapter is a separately gated later delivery.

### Non-goals

- Public launch, external users, marketing pages, branding work, decorative animations, extensive visual polish, subscriptions, multi-user onboarding or multi-tenant infrastructure.
- Guaranteed profit, compulsory daily trades, validated alpha, automatic risk increases, or unrestricted model-generated strategies.
- Unattended credential/OTP/TPIN login, automatic deposits, trading other people's funds, or live orders in the current scope.
- AWS purchases, deployment commitments, broad multi-market support, leverage/derivatives, or live model self-modification in the initial experiment.

## Scenarios and behavior

| Scenario | User intent | Expected behavior | Failure or edge behavior |
|---|---|---|---|
| Start a replay | Explore candidate behavior | Select dataset, capital, strategy, model profile, and cost assumptions; display experiment identity. | Reject invalid data; synthetic results remain visibly synthetic. |
| Receive a closed bar | Choose a candidate | Use only information available at that timestamp; record evidence, counter-evidence, selected strategy, and vetoes. | Warmup, stale/uncertain data, or no suitable candidate produces HOLD. |
| Detect a material story or rumor | Understand what changed | Resolve the company/event, inspect original evidence, record verification status, compare expectations and current market reaction, and reassess the relevant thesis. | Repeated copies count as one origin; recycled stories and unsupported claims cannot create an entry. Missing mandatory context or an expired proposal suppresses new exposure. |
| Research hangs during an open position | Preserve protection | Continue independent price/broker-event processing and the position's registered protective policy. | Bound queues and tool budgets. Stale prices or uncertain broker state follow their own incident policy; research availability is not a guarantee that an exit can execute. |
| Change settings | Adjust future behavior | Save a new version for subsequent entries, with an effective timestamp and change history. | Reject invalid or inconsistent limits; existing positions retain their entry strategy and exit rules. |
| Modify an open-position stop | Reduce exposure to loss | Preview old/new stop and remaining risk; require an explicit position-specific action. | Tightening only by default; reject automatic widening. Widening needs a separately authorized exception design. |
| Model request fails | Keep the experiment interpretable | Record the failed review and budget usage; suppress new model-assisted entries. | Do not substitute silent rules decisions; deterministic protective exits continue. |
| Restart or lose connection | Recover accurately | Restore state and reconcile recorded events before enabling new entries. | Unknown fills/state block new exposure; alert the owner for reconciliation. |
| Consider live trading | Inspect readiness | Show evidence, unresolved risks, limits, account/IP/auth status, and operator responsibilities. | Remain paper-only until explicit owner authorization and live gates are satisfied. |

## Requirements and acceptance

All **must** items are required before the stage named in the acceptance criteria; a future live requirement does not expand current authorization.

| ID | Requirement | Acceptance criteria | Priority |
|---|---|---|---|
| R-001 | Explicit modes and provenance | Every screen/export identifies synthetic, historical paper, prospective paper, or capped live; records retain dataset source, timestamps, experiment ID, and configuration version. No synthetic prices use real stock labels. | must |
| R-002 | Data validity and temporal causality | Reject nonfinite/nonpositive OHLC, inconsistent bounds, duplicate/out-of-order time, and open bars. A prefix decision remains unchanged when future bars are appended. Closed-bar timestamps, timezone, corporate-action treatment, and missing-data policy are recorded. | must |
| R-003 | Bounded adaptive selection | Select only enabled, versioned candidates or none; record regime measurements and reasons. Current candidate warmup is 25 closed bars. No invented win confidence; no live model code replacement. Held positions continue their entry strategy's exit logic. | must |
| R-004 | Configurable experiment inputs | Validate capital, universe, timeframe, horizon, selection mode, candidate set, provider/model, supported reasoning options, token/call/spend limits, timeouts, fee/slippage assumptions, and risk limits. Unsupported combinations fail visibly. Secrets are excluded from configuration exports. | must |
| R-005 | Versioned changes and explicit stops | Future entries reference the effective configuration version. Active stops change only through a logged position-specific action showing prior/new values, reason, and remaining risk. A tighter long stop cannot move downward; models cannot widen stops or increase limits. | must |
| R-006 | Account ledger and full costs | Cash plus marked positions reconciles to equity; realized/unrealized PnL, deposits, withdrawals, fees, and slippage remain distinct. Include relevant brokerage, exchange/statutory charges, and delivery costs; version assumptions. Golden accounting cases cover entry, partial fill, exit, and rejected fill without double charging. | must |
| R-007 | Realistic simulation | Decisions execute after information becomes available, never retrospectively at a known close. Fill reports distinguish assumed from observed prices. Gaps, stop/target ordering ambiguity, liquidity, and partial fills use explicit conservative policies; a stop price is not a guaranteed fill. | must |
| R-008 | Deterministic risk authority | Position size respects affordable whole units, cash, risk per trade, total exposure, daily loss, drawdown, and per-instrument limits. Insufficient capital yields a logged skip. Unknown/unapproved live loss limits disable live mode; AI output cannot bypass a veto. | must |
| R-009 | Durable replay and recovery | Events have unique IDs and causal ordering. Replaying the same events/configuration reproduces paper decisions and ledger state. Restart and interrupted-write cases do not duplicate a fill/order or advance the cursor incorrectly; corruption halts new exposure. | must |
| R-010 | Provider budget and failure controls | Reserve call budget before dispatch; record actual usage where available, including failed requests. Enforce call/token/spend caps and timeout behavior; unknown price estimates are disclosed. Malformed/refused/unsupported responses suppress entries and are never treated as orders. | must |
| R-011 | Isolated agent permissions | A research worker may use scoped read-only search/fetch/feed tools; diagnostics use redacted read-only logs. Neither receives broker credentials, unrestricted filesystem/network access, strategy-write rights, order tools or risk-mutation rights. Source text is untrusted evidence. Adversarial content, redirects and credential-leak cases produce no forbidden action. | must |
| R-012 | Broker authentication lifecycle | At the later Kite stage, the owner completes official login; expiry, logout, and authorization errors block new broker actions. Secret values never appear in UI, exports, errors, or model prompts. Token renewal is an operator task. | must |
| R-013 | Live order preflight and reconciliation | Before any later order: verify explicit live authorization, approved limits, account/instrument permissions, funds, registered static IP, session, and delivery-sale consent where applicable. Recover actual broker order/fill state before retrying an uncertain request; prevent duplicate exposure. | must |
| R-014 | Pause, exit, and emergency behavior | Pause blocks new entries and calls; deterministic protective exits remain available. Emergency halt and explicit close/flatten are distinct controls. Logs state whether positions/orders remain open; unresolved state never triggers a blind liquidation or resubmission. | must |
| R-015 | Comparable reports | For the same eligible universe/period/capital, report rules-only, each fixed candidate, buy-and-hold, and AI-assisted selection. Include every suppression and its cause, gross/net returns, costs, drawdowns, exposure, and missing-data coverage. Losing and no-trade experiments remain visible. | must |
| R-016 | Minimal functional operator view | Plain labeled controls and readable tables suffice. Show mode, positions, stops, available capital, costs, risk breaches, latest data time, decisions and recovery state. Keep inputs keyboard-operable and errors unambiguous; confirm destructive paper resets. Visual polish is not an acceptance criterion. | must |
| R-017 | Domain context and knowledge | For the selected market/horizon, construct versioned context from current prices, relevant company/sector/macro events, calendars, fundamentals, portfolio state and approved research. Retrieved lessons/cases carry source and dates; missing inputs and unverified claims are explicit. An expert persona prompt alone does not satisfy acceptance. | must |
| R-018 | Professional decision procedure | Record thesis, contrary evidence, alternatives, chosen strategy or abstention, invalidation and exits. Event assessments include novelty/materiality, surprise relative to documented expectations, observed market reaction, liquidity, latency/costs and proposal expiry. Priced-in judgments and causality remain labeled inferences. Assess unseen regimes, contradictions and no-trade cases under a rubric fixed before the experiment. | must |
| R-019 | Learning and experience memory | Link outcome reviews to the original inputs, thesis, execution and effective version. Distinguish decision quality from luck and execution effects. Proposed strategy/model changes enter a separate evaluation; recorded hindsight cannot alter the original decision or become information available to an earlier replay. | must |
| R-020 | Source qualification, available time and freshness | Before prospective use, record permitted source use, coverage, delay, retention, costs and source-specific health/age policies. Capture event/publication/update/first-receipt/analysis-ready/decision times where available; corrections create new versions. A story received at 09:08 cannot affect a 09:05 replay. Stale mandatory inputs or expired proposals block entries, even with fresh headlines. Recheck current price/risk before submission. | must |
| R-021 | Evidence and rumor lifecycle | Link claims to entity, original sources, corroboration, conflicting evidence and explicit verification states. Syndicated copies count as one origin. Retraction triggers a recorded reassessment without erasing earlier snapshots. Initial policy forbids rumor-only entries or increases; credibility is not a win probability. Recycled/spoofed stories and conflicting reports are covered before prospective use. | must |
| R-022 | Bounded continuous intelligence and independent protection | Before prospective use, define watchlist/held-position coverage, scheduled and event-triggered refresh, deduplication, queue/call/spend bounds and strategy context dependencies. Hanging research and news bursts cannot delay protective processing beyond a declared measured operational limit. Source failures are logged; news-dependent modes cannot silently become price-only modes. No assumption that every source outage halts all strategies. | must |

## Quality and risk

- **Privacy/security:** keep API secrets server-side with limited filesystem access; sanitize logs and exports; the local operator interface requires access control before any remote exposure.
- **Reliability:** prioritize correct state over trading continuity. Failure to persist, authenticate, price, or reconcile means no new exposure. Recovery and protective exits cannot depend on an LLM being available.
- **Model risk:** a persuasive explanation is not calibrated evidence. Historical LLM experiments may have training-data contamination; label that limitation and prioritize prospective comparisons.
- **Financial risk:** stop losses can slip; operational halts cannot ensure a known maximum loss. Small capital also makes fixed data/model costs material. Maximum accepted loss is unresolved.
- **Operational support:** the owner monitors auth, data freshness, errors, positions, and budgets. Expansion requires an explicit operator runbook and evidence review.

## Measurement

**Primary capability signal:** demonstrated trading judgment under a predeclared rubric covering context accuracy, strategy suitability, contrary-evidence handling, invalidation/exit discipline, useful abstention and consistency across the tested scenarios. Assess time-correct unseen cases and prospective decisions. Expert-level competence is not currently established, and independent reference assessments remain to be sourced.

**Supporting software signals:** complete, reconstructable experiments, zero unexplained ledger discrepancies and zero unauthorized actions in defined acceptance scenarios. These support judging the expert, not a return forecast or claim of experience.

**Trading evidence:** net returns after modeled/observed trading costs; separately disclose model, data, and hosting expenses; maximum drawdown, loss distribution, exposure, turnover, and fill deviation. Compare against baselines without mixing backtest and prospective results. Report sample size, period, regime coverage, selection changes, suppressed trades, and uncertainty. No statistical proof threshold or fixed calendar duration has been established.

**Intelligence evidence:** compare matched price-only, verified-intelligence and model-assisted variants; attribute benefit separately from added cost. Report time to detect/verify/decide, source coverage, stale/missed/duplicated events, entity errors, corrections, late proposals and abstentions. Historical articles must use the version actually available; publication time alone is insufficient. Prospective capture establishes arrival behavior. The detailed workflow is in [market intelligence](MARKET-INTELLIGENCE.md).

**Instrumentation/owner:** immutable decision-to-fill links, data/config/model versions, guardrail vetoes, manual actions, and recovery events; the user owns review decisions. Offline LLM reviews use captured responses for reproducible replay; fresh provider responses are separate experiment runs. Configuration changes are annotated, not retroactively applied to past performance.

## Dependencies and open questions

### Sourced broker dependencies, checked 13 October 2026

- Kite access tokens normally expire at **6 AM the next day** and may be invalidated earlier. Use official login and treat session validity as a runtime prerequisite. [Kite authentication documentation](https://kite.trade/docs/connect/v3/user/)
- Zerodha requires a registered static IP for **all API-based order placement from 1 April 2026**; market-data WebSockets and APIs such as orderbook/positions can use other IPs. This affects the later live execution design, not permission to purchase hosting. [Static-IP requirements](https://support.zerodha.com/category/trading-and-markets/general-kite/kite-api/articles/static-ip)
- Free Personal APIs exclude historical/live market data; the paid plan lists **₹500/month per API key** including both. Confirm the owner's subscription and any current credits before selecting a data budget. [Data plan](https://support.zerodha.com/category/trading-and-markets/general-kite/kite-api/articles/historical-data-and-live-market-data-payment-plan)
- Delivery sales by a non-DDPI/POA customer require CDSL TPIN/OTP authorization; DDPI is optional and changes that workflow. Account status is unknown; do not automate consent or infer it from holdings. [TPIN authorization](https://support.zerodha.com/category/trading-and-markets/trading-faqs/general/articles/tpin-preauthorisation), [DDPI](https://support.zerodha.com/category/your-zerodha-account/your-profile/ddpi/articles/activate-ddpi)

### Assumptions still being tested

Adaptive selection improves outcomes; candidate signals survive cost stress; verified intelligence and models add more value than they cost; a below-₹10,000 allocation supports the chosen instruments; prospective paper behavior predicts usable execution. None is validated. Broker quotes are not categorically delayed, and web search is not an assumed faster executable feed. TradingView automated use is not assumed licensed; see the source findings in the market-intelligence plan.

## Rollout and resumption gates

| Stage | Scope and exit evidence |
|---|---|
| 0 — Documentation pause completed | Partial files and planning context preserved; owner explicitly resumed local paper development on 13 October 2026. |
| 1 — Local laboratory | In progress after the owner's resumption. Complete and verify the causal data path, ledger, risk controls, replay, and reporting. Historical/synthetic runs establish software behavior only. |
| 2 — Prospective paper | Record incoming prices and intelligence as actually received, including corrections and source gaps, with declared strategy/config versions, costs and baseline comparisons. Verify source rights, freshness and independent protection. Freeze each experiment's rules; review operational failures and incremental intelligence value. |
| 3 — Explicit capped live pilot | Requires separate owner authorization, accepted loss/exposure/budget limits, eligible broker setup, reconciliation/recovery tests, monitoring, and an exit runbook. Start only within the approved allocation; pilot losses are possible. |
| 4 — Expansion | Consider additional instruments, markets, horizons, providers, or capital only after reviewing the prior stage. Each expansion gets fresh data, cost, operational, and risk checks. |

Mode controls default to paper and persist their state. Rollback blocks new exposure while preserving logs and managing known positions under the documented operator runbook. Review timing and return-evidence criteria are to be set before each prospective experiment; no launch date or runtime estimate is committed.

**Open decisions owned by the user at resumption:** accepted maximum rupee loss and daily/drawdown limits; exact allocation and recurring spend cap; initial universe/timeframe/horizon; enabled candidate/model profiles; evaluation and stop rules; broker data plan and delivery-consent status; where the eventual static-IP executor would run. Record these decisions before their dependent stage. The immediate next step is an owner-directed review of this PRD and the Engineering Statement of Direction, followed by a scoped paper-only completion plan.
