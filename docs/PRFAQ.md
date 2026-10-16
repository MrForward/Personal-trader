# PRFAQ — Personal Trading Lab

- **Date:** 13 October 2026, Asia/Kolkata
- **Version:** 0.3; continuous intelligence and source/freshness questions clarified
- **Owner:** the user
- **Status:** Planning draft; local paper development resumed by the owner on 13 October 2026
- **Working name:** Trading Lab; product name is not settled
- **Proposed launch date:** To be determined after evaluation
- **Related:** [PRD](PRD.md), [Engineering Statement of Direction](ESOD.md), [Resume plan](RESUME-PLAN.md)
- **Operating context:** [Retained agreements and lifecycle tool plan](LIFECYCLE-AGREEMENTS.md)
- **Research workflow:** [Market intelligence](MARKET-INTELLIGENCE.md)

## Proposed future announcement

> This describes an intended experience, not a launched product. A local paper dashboard has been built and its verification is still in progress; no profitable strategy has been validated. This draft is for internal planning, not publication. It contains no invented testimonials or performance results.

### Trading Lab aims to bring seasoned financial trading judgment to a personal AI bot

**A private AI trading expert will combine market context, strategy knowledge and lessons from historical and recorded decisions to research, choose and manage trades for its owner.**

The product ambition is the breadth and judgment expected of a professional with 20+ years of industry experience: understanding changing regimes, weighing competing explanations, selecting an appropriate strategy, knowing when to abstain, and managing a position as conditions change. That reference is a standard for the capabilities to build and demonstrate, not a manufactured biography or performance claim.

Its first proving ground will be historical research and paper trading. The owner will choose a model and constraints, while a minimal control panel exposes the bot's thesis, evidence, decisions, positions and outcomes. Knowledge, market-context and decision-memory layers are planned capabilities; they are not delivered by the current partial prototype.

The planned experience begins with the owner's personal Zerodha account and an experimental allocation below ₹10,000. Funds will remain in the brokerage account if a later live pilot is authorized. The first version will use paper execution. Fictional demonstration data, imported historical results, prospective paper results and any later real account results will remain clearly labeled.

The assistant will continuously gather relevant company filings/news, calendar and sector/macro context through approved feeds and bounded web research, alongside live price, volatility, liquidity and portfolio information. It will investigate rumors as labeled claims, assess contrary evidence and market reaction, then select an enabled strategy or recommend no trade. A separate risk and execution layer will enforce the owner's limits. A convincing explanation will not override a rejected order, increase the allocation or widen a protective stop.

Models and settings will be configurable. Changes will have an effective time and a recorded version. Open positions will retain their original exit rules unless the owner explicitly changes a position-specific setting through the permitted controls. The dashboard will make those changes and their consequences visible.

The intended benefit is delegating routine research and trade management to a capable expert bot that seeks to grow the owner's capital. Decision competence and economic usefulness both need evidence. Honest accounting and operational reliability support evaluating that ambition before a limited live experiment.

## Owner and product FAQ

### 1. What problem are we solving?

The owner wants to delegate market research, opportunity selection and position management to a top-tier personal AI trading expert. The problem is building a system that combines context, strategy knowledge and accumulated lessons into coherent trading judgment. Profit is the intended economic outcome of useful expertise. The paper laboratory is the first evaluation environment, not the definition of the product.

### 2. Is the trading strategy already solved?

No. Momentum and mean reversion are initial research candidates. Their presence in code is not proof of an edge. Strategy design, parameters, regime selection and the model's incremental contribution all need evaluation.

### 3. Will the AI understand every market dynamic?

The intended expertise includes market interpretation, strategy comparison, risk/exit discipline and lessons from multiple historical regimes and its own recorded decisions. Provide sourced context and cases, then assess evidence handling, counterarguments and invalidation discipline on unseen scenarios. The 20+ year reference is a capability benchmark. No model can observe every influence or know future events; a persona prompt does not establish expert competence.

### 4. Can it make 1–2% every day?

That is the owner's aspiration, not an expected return or promise. Constant compounding over an illustrative 252 sessions would multiply capital by about 12.274 at 1% daily and 146.975 at 2%. These are arithmetic examples, not forecasts. No-trade days, losing trades and losing periods remain possible. A daily income quota must not force an entry.

### 5. What does success mean?

Demonstrated professional trading judgment and useful delegation of research/position management, followed by credible economic performance within the owner's mandate. Evaluate context accuracy, strategy fit, counterarguments, abstention and exit discipline as well as returns after costs. Reconstructable records and reliable operations provide the evidence; a completed dashboard or an experienced-sounding explanation is insufficient.

### 6. What does the owner control?

Permitted instruments, allocation, strategy candidates, model profile, operating budget, risk limits, pause state and any explicit live authorization. The owner also completes broker authentication, funding and account-consent steps. Raising risk or capital requires a new explicit decision.

### 7. What does the AI control?

Within an evaluated experiment, it can examine an approved input snapshot, select an enabled candidate or abstain, and produce a concise structured justification. It does not hold broker credentials or approve its own spending, order size, risk changes or deployments. Deterministic controls decide whether a proposal is eligible for execution.

### 8. Why make the model configurable?

To compare quality, cost, latency and reliability without rebuilding the system. Rules-only operation, OpenAI and Anthropic are the initial planned profiles. Future providers should implement the same validated contract. Unsupported models or response formats must fail visibly, without silent substitution.

### 9. Does a more expensive model necessarily improve returns?

No such relationship is established. Compare the same universe, dates, rules, limits and costs with and without model assistance. Record every model/version change and attempted experiment. Include API spending in the economic assessment.

### 10. Can stops and other settings change?

Yes, through versioned controls. Default stop and target changes apply to subsequent entries. Changing an existing position is a separate action that previews the old/new level and records the owner, time and reason. Tightening is the initial default. Widening is not an AI capability and would need a separately reviewed exception policy. A stop does not guarantee the execution price during gaps or outages.

### 11. What happens to open positions when the model or strategy changes?

Management remains tied to the entry strategy and effective position configuration. An abstaining selector or failed model request must not suppress a required exit. Mechanical protection continues independently of the model. The draft engine needs correction and testing in this area before its returns are used as evidence.

### 12. Where does the money go?

Paper experiments use simulated balances. In a separately authorized live pilot, money stays in the owner's Zerodha account, funded through its supported flows. The application is not a new custodian or pooled wallet. [Zerodha funding documentation](https://support.zerodha.com/category/funds/adding-funds/how-to-add-funds/articles/how-do-i-add-money-to-my-zerodha-account).

### 13. How hands-off can Zerodha trading be?

Trading can be automated during an authenticated session. Kite documents token expiry at 6 AM the next day, and its developer team says personal users log in manually daily. Delivery selling may require TPIN/OTP if DDPI/POA is absent. The intended routine is brief authentication followed by operation within the mandate and exception alerts. [Session documentation](https://kite.trade/docs/connect/v3/user/), [personal-login clarification](https://kite.trade/forum/discussion/14052/how-to-get-refresh-token), [holdings authorization](https://support.zerodha.com/category/trading-and-markets/trading-faqs/general/articles/tpin-preauthorisation).

### 14. What account access is needed?

Historical/live data access when required, read access to relevant account information and eventually order access held by the execution service. Provider secrets stay on the server. Diagnostic AI receives redacted logs and bounded read-only views. No real account connection or order submission is currently authorized.

### 15. Why not immediately use a $5 Amazon server?

A server does not validate a strategy or fix incomplete execution. AWS currently lists a $5/month Linux public-IPv4 bundle with 0.5 GB RAM and a $7 bundle with 1 GB. These are candidate plans, not measured capacity guarantees. Complete local validation first, then assess a dedicated VM with persistent state and restricted access. [Lightsail pricing](https://aws.amazon.com/lightsail/pricing/), checked 13 October 2026.

### 16. Is this worthwhile below ₹10,000?

Unknown until costs and outcomes are measured. Zerodha lists free Personal execution/account APIs and a ₹500/month paid plan including historical/live data, with renewal credits for qualifying brokerage. ₹500 is 5% of ₹10,000 before other costs. Keep learning expenses distinct from capital and evaluate both. Do not trade more merely to qualify for credits. [Current data-plan terms](https://support.zerodha.com/category/trading-and-markets/general-kite/kite-api/articles/historical-data-and-live-market-data-payment-plan).

### 17. How will we know results are real?

Each report identifies mode, source, sample, configuration and cost assumptions. Prospective decisions are recorded before outcomes. A later live report reconciles broker orders, fills and statements; deposits are not profits and open losses are included. Paper results never appear as earned cash. A model-generated summary is not independent verification.

### 18. What testing matters?

Time-correct data, no future leakage, untouched evaluation periods, recorded trial counts, appropriate baselines, realistic costs and adverse execution scenarios. Software checks cover duplicates, partial fills, restarts, ambiguous submissions, model failures and vetoes. Historical LLM tests have training-data contamination concerns; prospective comparisons are important.

### 19. Should a tested strategy run without interference?

Freeze an experiment's rules and avoid changing them merely because a recent trade disappointed. Continue predefined operational and loss-limit stops. Pausing new entries, managing open positions and emergency flattening are distinct actions. Define their failure handling in the runbook before live trading.

### 20. What does AI monitoring do?

It explains missed signals, fill/cost discrepancies and deviations from the declared strategy using sanitized records. A conventional supervisor handles health checks and bounded restarts. Monitoring AI does not receive an unrestricted shell, autonomously repair the live strategy or infer broker misconduct from a price mismatch.

### 21. Will it cover intraday, swing trading, investing and other markets?

That is the broader ambition. Add each capability as an independently evaluated strategy/data/broker module. Choose a bounded first universe and horizon at resumption. A model working in one market is not assumed to generalize to all markets.

### 22. What has actually been built?

The local dashboard, paper replay, settings, model adapters, ledger, captured evidence import and engine are present. No broker or live news feed is connected; no real orders or paid model calls have run. Some focused suites passed, but a corrected server security case and full browser verification remain outstanding. No live model or broker performance is verified. [Current checkpoint](RESUME-PLAN.md).

### 23. What decisions remain open?

Accepted loss in rupees/percentage; daily/drawdown limits; initial instruments and horizon; data/model/hosting budgets; advancement criteria; delivery-consent status; and eventual operating ownership. Draft numeric defaults are examples, not approved live limits.

### 24. What happens next?

The owner has resumed the local paper build. Correct causal execution/position-management issues, implement captured market intelligence and complete/verify the local flow. Paid integrations, a cloud purchase or a live pilot are later concrete decisions. [Resume plan](RESUME-PLAN.md).

### 25. Are we building an external product with a polished consumer interface?

No. This is a private personal expert bot. The proposed announcement is a planning exercise, not a public-launch plan. Focus effort on trading judgment, useful capital deployment, strategy evaluation, execution and low costs. A simple panel for models/settings, positions, stops, risk, costs and logs is sufficient. Public exposure, onboarding, branding, decorative animations and consumer-level visual polish are excluded. Basic legibility and clear controls remain necessary for accurate operation.

### 26. Isn't broker or exchange data too late?

Not categorically. Kite supplies live quotes; historical bars, periodic snapshots, web pages and streaming feeds are different products. Measure actual feed age and end-to-end decision delay rather than assume their speed. An old last trade is also different from an old current quote. Browsing can uncover context but has its own delays. The first strategy must fit measured data access and latency. [Kite stream](https://kite.trade/docs/connect/v3/websocket/).

### 27. Will it browse news and watch rumors during trading?

Yes, as a proposed ongoing capability: scheduled watchlist/position coverage plus research triggered by relevant events, source corrections and market anomalies. Inspect originals, retain timestamps and verification states, and assess whether the story is new, material and still offers a useful entry after the market's reaction. Initial rumor-only entries/increases are excluded; claims can trigger investigation or suppress a vulnerable entry. Retrieved text cannot instruct the bot to change risk or place an order. The feeds and browser worker are not implemented yet.

### 28. Should we use TradingView?

Possibly for owner research/chart inspection. Its official MCP beta exposes research tools, but ordinary terms restrict autonomous/non-display use of platform data. Do not infer bot-trading rights from a paid plan, MCP access or webhooks. Check instrument-specific data entitlement and suitable rights before any integration. [MCP](https://www.tradingview.com/mcp/docs), [terms](https://www.tradingview.com/policies/). Keep executable prices and account state on an appropriately permitted broker/vendor feed.

### 29. What happens when news research is slow or wrong?

Position protection runs independently of browsing/models. A stale mandatory source, expired proposal or unresolved relevant event blocks an affected entry under its strategy policy. Keep corrections, missing coverage and failed searches visible; do not silently turn them into neutral sentiment. Price/auth/broker outages have separate incident responses. Every later order needs current price/risk checks, and neither a fresh headline nor an accepted order guarantees a fill. See the [intelligence workflow](MARKET-INTELLIGENCE.md) for the proposed rules.
