# Retained agreements and lifecycle tool plan

- **Date:** 13 October 2026, Asia/Kolkata
- **Status:** Retained requirements; local paper implementation resumed by owner on 13 October 2026
- **Purpose:** Keep the revised expert-bot vision connected to the operational rules and context previously agreed
- **References:** [PRD](PRD.md), [ESOD](ESOD.md), [PRFAQ](PRFAQ.md), [resume checkpoint](RESUME-PLAN.md)
- **Market-research contract:** [Continuous intelligence and decision workflow](MARKET-INTELLIGENCE.md)

## Vision and constraints retained

The product is a personal AI financial trading expert with the breadth and judgment expected of a seasoned 20+ year practitioner. Profit is its intended economic outcome. That vision supplements the requirements below; it does not replace them or imply verified expertise.

Use the owner's personal Zerodha Kite account, with initial experimentation below ₹10,000 and later allocation to be decided. Keep the tool private and its interface minimal. Broad intraday, swing and investing capability remains the longer-term ambition; evaluate bounded capabilities first. No live loss mandate, operating-spend cap, external exposure or live-trading authorization is currently settled. The owner explicitly resumed local paper development after reviewing the documentation.

## Agreement map

| Agreement | Retained direction | Requirement reference |
|---|---|---|
| Configurable AI | Choose supported provider/model profiles and reasoning options where supported; record model version, inputs, usage and configuration. Compare quality and cost rather than assume a more expensive model is better. | PRD R-004, R-010, R-015 |
| Actual trading expertise | Use sourced domain knowledge, historical cases, current context, thesis/counter-thesis reasoning, strategy comparison and decision/outcome memory. A persona prompt alone does not establish expertise. | R-017–R-019 |
| Continuous market research | Scheduled and event-triggered watchlist/held-position research using permitted feeds and bounded browsing; source coverage, freshness, entity mapping, independent origins, rumors and corrections remain explicit. Assess current reaction and proposal expiry. | R-017–R-018, R-020–R-022 |
| Strategy choice | Explicit candidates, documented entry/exit rules, adaptive selection or abstention, and evaluation before promotion. Momentum/reversion are starting scaffolding; strategy edge is unresolved. | R-003, R-018 |
| Editable settings | Version model, strategy and risk changes. Future entries use new settings; existing positions retain entry rules. Explicit stop changes show old/new values and are logged; tightening is the initial default. | R-004–R-005 |
| Independent risk | Enforce approved cash, sizing, exposure, loss and data-validity limits outside model discretion. Model failure cannot disable protective position management. | R-008, R-014 |
| Decision logs | Record every proposal, rejection, abstention, manual change and execution outcome, with concise decision rationale, evidence, counterevidence and identifiers. Logging means observable records and explanations, not access to hidden model reasoning. | R-001, R-009, R-018 |
| Exact information seen | Save the time-correct input snapshot/source/version used for each decision, first receipt/analysis-ready times, corrections, relevant price quotes and order timing, along with observed fills. Retain permitted evidence and captured model responses for replay; disclose any licensing-related reconstruction limits. | R-002, R-007, R-015, R-020 |
| Truthful accounting | Separate simulated results from actual broker-account results, realized/open PnL, deposits and costs. Reconcile rather than trust an AI-written profit summary. | R-006, R-013, R-015 |
| Recovery | Persist state, detect ambiguous submissions, reconcile before retry/resume and prevent duplicate orders/fills. Block new exposure when state is uncertain. | R-009, R-013–R-014 |
| Continuous monitoring | Use deterministic health checks/watchdogs for routine faults. Diagnostic AI reviews redacted logs/read-only data, explains anomalies and proposes fixes. It cannot rewrite the live strategy or acquire execution credentials. | R-011, ESOD observability |
| Disciplined testing | Time-correct data, untouched evaluation periods, tracked selection trials, cost/slippage stress, realistic fills, recovery tests and prospective comparisons. Freeze each evaluated version; change it through recorded review. | R-002, R-007, R-009, R-015 |
| Minimal private interface | Settings, positions, stops, risk, decisions, logs and operating status. No branding, marketing, decorative polish or public/customer features. | R-016 |

## Tools across the lifecycle

These are capabilities needed at the relevant stage, not integrations to provision now. Prefer the smallest tool set that fulfils the requirement. Current drafts and proposed options are distinguished in the resume checkpoint.

| Stage | Necessary tools/capabilities | Access boundary and owner intervention |
|---|---|---|
| Engineering research and design | Official provider/broker/exchange documentation; public research and inspectable code; project documents and decision records | Read-only due diligence. Social/video claims are leads, not verified performance. Keep source dates and limitations. This does not replace ongoing market research. |
| Continuous market intelligence after resume | Qualified broker/feed data; filings and event calendars; permitted publisher feeds; scoped web search/page/document retrieval; optional permitted social discovery; entity/deduplication/claim store | Research is read-only and separate from order authority. Version first receipt, analysis-ready time and corrections. Scheduled/event-triggered coverage is bounded by watchlist, horizon and budgets. Owner chooses paid access and completes setup. Initial rumor-only entries are excluded. |
| Local development, now resumed | Scoped project filesystem/Git; coding assistant; unit/integration tests; captured fixtures and browser verification | Work in the designated project. No automatic production promotion or paid/external integration from the resume alone. |
| Historical evaluation | Validated historical data, reproducible strategy engine, cost/fill models, experiment registry and benchmark reports | Only information available at the decision time. Data subscriptions and licenses are owner decisions; historic LLM contamination must be disclosed. |
| Expert knowledge and memory | Sourced financial/case retrieval, contextual analysis and recorded decision/outcome store | Source/date/applicability tracked. Hindsight memory cannot enter an earlier replay. Knowledge retrieval and evaluation methods remain to be selected. |
| Model review | Configurable model adapters, structured-output validation, source-linked context, timeouts, call/token/spend controls | Server-side provider credentials; no broker credentials. Assess novelty, expectations, reaction, contrary evidence, expiry and costs. Unsupported/refused responses suppress model-assisted entries. Paid usage requires an agreed budget. |
| Prospective paper | Incoming prices/intelligence, independent protective processing, paper order/fill simulation, immutable snapshots and reports | No real orders. Approved source/data/model access; simulated-fill labels. Compare intelligence with matched price-only baselines; preserve gaps and late events. |
| Limited live pilot, if justified | Kite session/account APIs, controlled order service, independent risk checks and broker reconciliation | Owner handles official login, funding, account consent and explicit live mandate. Routine eligible orders can run within that mandate; risk/capital increases are separate decisions. |
| Hosting and operation | Dedicated private VM/static IP when justified, persistent database, backups, bounded supervisor, health checks and owner alerts | AWS Lightsail is a candidate, not a purchased host. Confirm capacity and costs. Use scoped deployment access; keep the interface private. |
| Diagnostics and improvement | Read-only log/database views, replay tools, outcome attribution, regression checks and configuration/version history | AI proposes explanations/fixes. Validate proposed changes separately before deployment; do not automatically widen risk or change a frozen experiment. |
| Incidents and recovery | Stop-new-entry controls, protective-exit path, order-state inspection, restore and incident runbook | Unknown state blocks new exposure. Define pause versus flatten explicitly. Owner acts on unresolved account/auth/recovery situations. |

## Operating details preserved

- **Retention:** keep decision/trade records, relevant input snapshots, model/config versions and outcome history for the full selected evaluation and recovery period. A configurable 30/60-day policy can apply to verbose debug logs; it must not erase needed trading evidence. Choose detailed retention, licensing and storage costs before operation. Seq is an optional implementation choice, not a requirement.
- **Alerts:** surface stale data, expired credentials, uncertain orders, reconciliation mismatches, risk breaches, repeated service failures and budget exhaustion. The owner chooses the notification destination. No alert integration or external message has been created.
- **Backups:** preserve ledger/state separately from a release. Test restore and reconciliation before relying on recovery in a live stage.
- **Human steps:** initial account/API setup; daily Zerodha authentication; delivery-sale consent when applicable; subscription/host spending; approved capital/loss mandate; material strategy/risk changes; exceptional recovery decisions. Current broker facts and source links are in the [ESOD](ESOD.md).
- **Hosting economics:** the desired inexpensive VPS remains in the plan. Pricing and broker data expenses are recorded in ESOD/PRFAQ and must be rechecked before procurement. Heavy model inference stays outside the smallest VM; capacity has not been measured.
- **Tool choices:** Node/SQLite/static UI and model adapters are draft first-experiment choices. LEAN, Seq or the optional eve scaffold are candidates where justified, not ends in themselves. Read-only web research is part of the proposed market-intelligence capability. TradingView MCP/charting is optional; autonomous use of its platform data is not assumed permitted under ordinary terms. No mandatory Vercel/Sites hosting or public application has been agreed.
- **Other projects:** Hermes harness work, MeasureX and the AI journaling app were separate items in the original sequence. They are not dependencies silently added to this bot's scope.

## Required reading when resuming

Read this agreement map alongside the PRD, ESOD and resume checkpoint. Carry the vision, operating requirements, unknowns and existing defects forward together. Revise a settled agreement explicitly rather than dropping it during a vision, model, architecture or implementation change.
