# Trading Lab planning documents

**The owner resumed local paper development on 13 October 2026.** These documents describe the proposed expert product and staged work. Current authorization covers local implementation and verification; deployment, subscriptions, broker connections and real trades remain later decisions.

| Document | Purpose |
|---|---|
| [Goal](GOAL.md) | One-page statement of what the bot is for, the phases, hard constraints and owner decisions. Read first. |
| [Phase 1 design](superpowers/specs/2026-10-17-phase1-live-paper-design.md) | Prospective paper trading on live Kite data from a VPS: what to buy, architecture, daily login, costs, tests. |
| [Phase 1 plan](superpowers/plans/2026-10-17-phase1-live-paper.md) | Task-by-task implementation plan for the Phase 1 design. |
| [Phase 1b expert shadow design](superpowers/specs/2026-10-18-phase1b-expert-shadow-design.md) | Second paper book decided by Claude (via the Claude Max subscription) with research, theses, reviews and memory; shipped in PR #2. |
| [Phase 1b expert shadow plan](superpowers/plans/2026-10-18-phase1b-expert-shadow.md) | Task-by-task plan for the expert shadow. |
| [Phase 1b AI-shadow design (superseded)](superpowers/specs/2026-10-18-phase1b-ai-shadow-design.md) | Not built; replaced by the expert shadow design. |
| [PRFAQ](PRFAQ.md) | Intended experience, proposed future announcement and product/model/risk/cost FAQs. |
| [PRD](PRD.md) | Scope, scenarios, requirements, acceptance criteria, evaluation and staged rollout. |
| [ESOD — Engineering Statement of Direction](ESOD.md) | Architecture, permission boundaries, tradeoffs and dependencies. |
| [Resume plan and checkpoint](RESUME-PLAN.md) | Exact partial-code state, recorded checks, known issues, open decisions and restart sequence. |
| [Retained agreements and lifecycle tools](LIFECYCLE-AGREEMENTS.md) | Models, logs, data, risk, recovery, tooling, permissions and owner intervention across each stage. |
| [Continuous market intelligence](MARKET-INTELLIGENCE.md) | Live prices, filings/news, web research, rumors, source freshness, decision latency and TradingView findings. |

Read PRFAQ → PRD → ESOD → market intelligence → retained agreements → resume plan. The resume plan records the current implementation and what still needs verification. A change to the product vision does not discard the operating agreements.

## Fixed context

- Core ambition: a personal AI financial trading expert with the breadth and judgment expected from 20+ years of professional experience; this is a capability benchmark, not an asserted biography or track record.
- Personal Zerodha Kite account; initial experimentation below ₹10,000.
- Private single-owner tool: minimal interface; prioritize expert decisions, useful capital deployment, execution reliability and low costs. Public exposure and consumer-product aesthetics are excluded.
- Configurable models and editable risk settings desired.
- Continuous bounded market research is required alongside current prices: permitted feeds/browsing, timestamps, verification and strategy-specific freshness. Position protection runs independently of research/models.
- Adaptive selection and profitability remain research questions.
- The 1–2% daily aspiration is not guaranteed or assumed.
- Accepted loss and recurring expense limits remain unresolved.
- Local research and paper evaluation precede any separately authorized live pilot.

## Evidence and status

Requirements and the announcement describe proposed behavior. Code is partial, not a validated complete application. Recorded unit/mock tests establish covered software behavior only. Synthetic, historical paper, prospective paper and real-account results must remain distinct.

Prices and broker requirements are dated in the documents; recheck them before procurement or live use. No application tests or provider requests were run to prepare this documentation.
