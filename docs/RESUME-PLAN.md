# Development checkpoint and resume plan

- **Checkpoint date:** 17 October 2026, Asia/Kolkata
- **Status:** Owner resumed local paper implementation on 13 October 2026 after the documentation pause; current build and verification status is below
- **Scope:** Current work is local implementation and verification; preserve planning context and distinguish later spending/integration/live decisions
- **References:** [PRD](PRD.md), [Engineering Statement of Direction](ESOD.md), [PRFAQ](PRFAQ.md)
- **Required context:** [Retained agreements and lifecycle tools](LIFECYCLE-AGREEMENTS.md)
- **Research correction:** [Continuous market intelligence](MARKET-INTELLIGENCE.md), including permitted sources, temporal availability, rumor controls and independent protection

## Phase 1 build — 17 October 2026

The goal is restated in [GOAL.md](GOAL.md). Phase 1 (prospective paper trading on live Kite data from a VPS) is designed in the [Phase 1 spec](superpowers/specs/2026-10-17-phase1-live-paper-design.md) and built per the [Phase 1 plan](superpowers/plans/2026-10-17-phase1-live-paper.md), Tasks 1–9, on branch `phase1-live-paper`:

- `src/costs.mjs`: Zerodha CNC charge schedule (STT, exchange, SEBI, stamp, GST, DP once per scrip per day) replaces the flat fee; sizing counts the DP charge.
- `src/bars.mjs`: ticks to closed bars aligned to 09:15 IST; late/outside-session ticks dropped and counted; thin bars when a symbol had no tick.
- `src/calendar.mjs`: NSE 2026 trading holidays (hand-maintained yearly).
- `src/kite.mjs`, `src/secrets.mjs`: Kite login, 06:00 IST expiry, instrument lookup, closed-only warmup bars, full-mode tick source; one SDK ticker per process with SDK reconnect off (the SDK exits the process when its own retries run out).
- `src/live.mjs`: tick capture before use, one engine step per closed bar, entries blocked for two clean bars after a gap and on clock skew, protection-gap records while disconnected, catch-up after restart, daily report at the close.
- Engine: `beginLive`, `appendBar`, `catchUp`, `blockEntries`, `dailyReport`; live runs stay `live`.
- Server and dashboard: `/kite/login`, `/kite/callback`, `/api/kite/status`, `/api/reports`; Kite status panel, Reports view, new settings (universe, bar size, fixed costs, spend cap).
- `deploy/`: `deploy.sh`, backup script and timer, rewritten README with the owner steps. The Docker path was removed (the server refuses non-loopback binds and the spec has no Docker in Phase 1).

**Verification:** `npm test` passes (unit, integration and a recorded-tick replay that reproduces the ledger exactly); `npm run typecheck` passes; the dashboard was checked in a browser in replay and live modes. **Not verified:** any real Kite login, live tick stream or VPS deploy; that is Task 10 and needs the owner's Kite app and Lightsail instance. The default universe is a placeholder until the owner confirms it.

### Task 10 progress — 18 October 2026

Running on the owner's Mac while the AWS account finishes activating:
- [x] Kite Connect app created; key/secret in the git-ignored local `.env`.
- [x] Kite login through `/kite/login` works; session valid until 06:00 IST; all 10 default symbols resolve on NSE.
- [x] Restart keeps state and the Kite session (no new login needed).
- [x] Backup script copies the database; the copy restores with the same run, session and audit rows.
- [ ] First live session (Monday 19 Oct): header switches to LIVE PAPER, ticks arrive from 09:15, first decision around 09:30, daily report after 15:30.
- [ ] Deploy to AWS Lightsail Mumbai (waiting on account activation; $100 sign-up + $20 budget credits on the account).

## Earlier checkpoint — 16 October 2026

The local paper dashboard now has a Node server, browser controls, persistent SQLite ledger, configurable strategies/risk settings, model profiles with paid calls disabled by default, replay/import/export, and captured-intelligence display/import. The optional eve diagnostic agent has a single read-only snapshot tool; shell and file defaults are disabled. The dashboard is loopback-only. No live feed, news API, TradingView account, Zerodha account, paid model call, subscription, VM or real order is connected.

The replay/ledger changes addressed entry-strategy exit ownership, candle event ordering, latched daily/drawdown loss caps, trailing-stop timing, atomic reset/archive, stale-step and concurrent-mutation handling, recovery behavior and a static capped benchmark reference. These remain local software changes, not verified live execution.

Captured intelligence covers publication/receipt/analysis-ready times, deduplication by source origin, linked revisions, retractions and entry-blocking claims. Only fictional evidence is supplied automatically for DEMO assets; imported records are not independently verified. The web/news/social acquisition workflow is designed in [Market Intelligence](MARKET-INTELLIGENCE.md), but is not implemented.

**Verification status:** 30 strategy/model/intelligence tests previously passed together; 28 engine/config/store/dataset regression tests were reported by the implementation agent. A separate server API test run first passed 4 of 5 cases. The remaining case used Node fetch, which rewrites the Host header; the test now uses raw HTTP to check host-rebinding rejection. That corrected case and a clean full-suite rerun are pending. TypeScript had passed before the last diagnostic-tool edit; typecheck has not been repeated. Browser rendering and the full browser-to-ledger flow have not yet been verified. Do not report this application as fully verified until these checks pass.

**Repository status (updated 17 October 2026):** The repository is on GitHub at [MrForward/Personal-trader](https://github.com/MrForward/Personal-trader). Phase 1 work is on branch `phase1-live-paper`; `main` holds the earlier checkpoint.

## Direction and open decisions

Personal Zerodha trading assistant; eventual broad market/horizon coverage; configurable AI; adaptive selection; editable stops. Initial experimental capital is below ₹10,000. Begin with observable paper research, compare rules and AI assistance, and consider a separately authorized live pilot only if evidence and operations justify it.

**Vision correction:** The primary product is a top-tier financial trading expert bot with the breadth and judgment expected of a seasoned 20+ year practitioner. Profit is the intended economic outcome. The paper laboratory is its first proving ground, not the entire product. On resumption, account for sourced expert knowledge, historical cases, current context, explicit judgment procedures and decision/outcome memory; those layers are not yet implemented or validated.

**Workflow correction:** Ongoing market research requires bounded feeds and web retrieval, not just broker candles or design-time reading. Keep current prices/protection separate from slower intelligence processing. Record actual availability and corrections, verify claims, assess materiality/expectations/current reaction and expire stale proposals. Broker data is not categorically delayed; measure the actual feed. TradingView now has MCP research tools, but bot data-use rights are not established by ordinary subscriptions. The intelligence plan is proposed, not implemented.

Strategy edge is unsolved. The 1–2% daily aspiration is not a forecast or acceptance threshold. Maximum accepted loss, expense cap, first universe/horizon, evaluation thresholds and account authorizations remain open. Code defaults are simulation examples only.

**Personal-use constraint confirmed:** Keep the expert bot private and its interface minimal. Prioritize decision capability, strategy evidence, useful capital deployment, reliable execution/accounting and diagnostics. Existing partial visual assets may be reused; aesthetic polish, branding, public exposure and commercial features are outside resume scope. Basic clear controls, risk visibility and readable logs are required.

## Preserved implementation

| Area | Files | Status at pause |
|---|---|---|
| Strategies and synthetic data | `src/strategies.mjs`, `src/demo-data.mjs`, `tests/strategies.test.mjs` | Seven tests passed before pause; covered behavior, not profitability. |
| Model adapters | `src/models.mjs`, `tests/models.test.mjs` | Fifteen mocked tests passed before pause. Rules/OpenAI/Anthropic drafted; no real provider call verified. |
| Continuous intelligence | Source/feed registry, browser tools, available-time/claim store, event scheduler and context assessments | Design added in documentation; not implemented or tested. No news/social/TradingView account connected. |
| Settings, dataset, storage and engine | `src/config.mjs`, `src/dataset.mjs`, `src/store.mjs`, `src/engine.mjs` | Drafts exist; integration, accounting, concurrency and recovery unverified. |
| Browser UI | `public/index.html`, `public/styles.css` | Partial. `public/app.js` missing; no browser verification. |
| HTTP service | Intended `src/server.mjs` | Missing; no runnable full dashboard backend. |
| Agent | `agent/agent.ts`, `agent/channels/eve.ts`, `agent/instructions.md` | eve scaffold; generic instructions, constrained diagnostics not implemented. |
| Metadata | `package.json`, `package-lock.json`, `tsconfig.json`, `.env.example`, `.gitignore`, `AGENTS.md`, `CLAUDE.md` | Preserved; full typecheck/package consistency unverified. Real keys were not added by this work. |
| Deployment templates | `deploy/trading-lab.service`, `deploy/README.md` (Dockerfile removed 17 October 2026) | Superseded by the Phase 1 build above; not yet deployed. |

No application tests were rerun after the pause. No VM was purchased/provisioned, no broker account connected, no trade submitted and no application server started. No development commit or PR was created. Preserve these files; do not treat them as a working deployment.

## Known review issues before integration

These are identified concerns, not completed fixes or a comprehensive audit:

1. **Exit ownership:** manage held positions using their entry strategy even when a selector changes or abstains. Model failure must not suspend mechanical protection.
2. **Causal event ordering:** the draft processes intrabar stop/target exits before next-bar-open entries. Correct this so proceeds from a later exit cannot fund an earlier entry. Specify stop/target ambiguity and test gaps.
3. **Risk timing:** breached drawdown/global caps must prevent new entries before they occur. The draft's closing-bar check is not a verified live risk design.
4. **Persistence/concurrency:** verify atomic updates, archives, concurrent call reservations, interrupted writes and duplicate replay prevention. Coordinate future HTTP mutations safely.
5. **Comparable baselines:** disclose exposure/cost differences between fully invested buy-and-hold and a capped strategy; add the agreed comparable reference.
6. **Runtime boundaries:** reconcile metadata, complete missing pieces, restrict agent capabilities and verify private binding before launching a service.

## Proposed phases

### Phase 0 — Documentation pause completed

Documentation and partial source state were preserved. The owner explicitly said “resume” after the market-intelligence correction. Local implementation, tests and browser verification are now active. No reminder or automatic restart caused this change; paid calls, operational feeds, broker connections, subscriptions, deployment and real trading remain later decisions.

### Phase 1 — Complete the local paper laboratory

**Decisions needed:** first universe/horizon, learning expense cap and comparison profiles. A live loss mandate is not needed for local synthetic software checks; real-money execution remains disabled.

Define the first expert-capability slice before filling in code: required market context, relevant sourced knowledge/cases, decision procedure, memory boundaries and unseen assessment scenarios. Specify the bounded watchlist, mandatory/optional context, permitted source registry, source-specific freshness, research cadence/budgets and independent protective processing. Use captured evidence/fixtures first; choose operational providers before prospective use. The initial momentum/reversion implementation is scaffolding for that experiment, not a complete financial expert.

**Work after resumption:** address the review issues; implement missing HTTP/browser integration as a minimal functional control panel; finish versioned settings and explicit stop updates; verify provenance, causal replay, net accounting and exported evidence; restrict optional agent capabilities; run focused unit/integration/recovery checks and browser verification. Avoid decorative or consumer-product work. Use captured fixtures/mocked providers before separately authorized paid calls.

**Exit:** reproducible local experiments; no unexplained ledger differences or forbidden actions in defined scenarios; tested causal data use; clear synthetic/historical labels. This establishes software readiness, not an edge.

### Phase 2 — Evaluate strategy and model value

**Decisions needed:** data/corporate-action policy, recorded trial counts, untouched periods, baselines, cost stresses and proceed/reject criteria.

Compare fixed rules, adaptive rules and constrained AI selection, separating the incremental effect of verified intelligence. Capture inputs and model responses for replay; preserve losing runs and all variants. Use information as actually available and disclose historical timing gaps/model contamination. Test stale/recycled/contradictory stories, source duplication, entity errors and rumor retractions. No accepted fixed duration or trade count currently constitutes proof. Reject or revise candidates whose measured value does not justify cost and complexity.

### Phase 3 — Prospective paper operation

**Decisions needed:** source coverage/rights/retention and measured delay; data/news subscriptions if required; model/research budget; horizon-specific refresh/expiry policies; version-freeze policy; alerts; and whether hosting is useful now.

Record incoming prices/intelligence and decisions before outcomes, with first receipt, analysis-ready time, source versions and corrections. Run a frozen configuration; measure event detection and proposal age. Exercise research hangs/news bursts alongside independent protection, outages/restarts/unknown state and compare observations with historical assumptions. Separate missed/late information and signals from fill assumptions. Paper fills remain simulated. Exit requires dependable operation and informative prospective comparisons under predeclared criteria.

### Phase 4 — Decide on a limited live pilot

**Owner decisions:** exact allocation, accepted maximum rupee loss, daily/drawdown/exposure limits, instruments, expenses, stop conditions and explicit live authorization.

**Prerequisites:** recheck Kite requirements; official login; static-IP order path; delivery consent; verified order/reconciliation handling; recovery runbook; restricted credentials and monitoring. Never blindly retry an uncertain submission.

Evaluate Lightsail against measured resource needs. The documented $5/0.5 GB and $7/1 GB plans are candidates, with data/model/tax/backup costs extra. Templates do not authorize procurement. Reconcile actual fills/costs against paper assumptions; stop or return to paper if reliability or economic evidence fails.

### Phase 5 — Expand selectively

Add horizons, instruments, markets, providers, capital or an established engine only where previous results support it. Each addition requires its own data, execution, cost and risk assessment. No launch date, return commitment or automatic capital increase is recorded.

## Suggested instruction when ready

> Resume Trading Lab development in the same workspace. Read docs/README.md, docs/RESUME-PLAN.md, docs/PRD.md, docs/ESOD.md and docs/LIFECYCLE-AGREEMENTS.md first. Preserve the expert-bot vision and all operating agreements. Start with Phase 1, address the documented engine/recovery issues, and keep execution paper-only. Bring any paid integration or live proposal to me as a concrete reviewable decision.

This is a convenience for the owner, not a sent, scheduled or executed instruction.
