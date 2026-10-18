# Goal

- **Date:** 17 October 2026, Asia/Kolkata
- **Owner:** the account owner
- **Status:** Agreed statement of what this project is for. Read this before the other documents; they add detail and constraints, not a different goal.

## The goal in one paragraph

Build a private trading bot that runs unattended on a VPS and trades my Zerodha account in Indian cash equities, starting with under ₹10,000. It decides like an experienced trader: it reads prices, fundamentals and news, forms a thesis, sizes within hard risk limits it cannot change, manages exits, and records every decision so I can see why. Phase 1: paper-trade live NSE data on the VPS for a fixed period and beat buy-and-hold after all costs. Phase 2: go live with a capped amount only if Phase 1 clears the bar. US markets and larger capital come after. I do the daily Kite login and approve any risk increase; everything else is the bot's job.

## What "making money" means here

Net profit after **all** costs: trading charges (STT, exchange, stamp, DP), the Kite Connect subscription, the VPS and any model calls. Every report shows trading P&L and fixed costs side by side. A bot that makes ₹400 on ₹10,000 while the subscription costs ₹500 has not made money.

The 1–2% per day idea is not a target. Compounded for a year it is 12× to 147×; nobody does that. The first bar is "no net loss over the evaluation period and better than buy-and-hold on the same stocks."

## Phases

| Phase | What runs | Money at risk | Exit bar |
|---|---|---|---|
| 1 — Prospective paper | Live Kite data on the VPS, rules-only strategies, simulated fills, full cost model | None (₹500/month data + VPS) | 40 trading sessions; net ≥ 0 after fixed costs; beats equal-weight buy-and-hold on the watchlist; no unexplained ledger difference; no missed protective exit |
| 1b — Expert layers | Same live stream; model profile runs in *shadow* (proposals recorded, not executed); news/evidence capture | None | Shadow proposals beat rules on the same period, after model cost |
| 2 — Capped live | Real orders through Kite with the Phase 1 configuration | An amount I set in writing, with a written max loss | Fills and costs match paper assumptions; no duplicate or uncertain orders |
| 3 — Expand | More capital, instruments, horizons; US markets | Decided then | Decided then |

Each phase starts only on my explicit go-ahead.

## Hard constraints that do not change

- **Daily login.** A personal Kite Connect token expires at 6 AM. I log in every trading morning; until then the bot places no new paper or live entries. This step cannot be automated on a personal account.
- **Static IP.** Zerodha requires a whitelisted static IP for API orders. The VPS has one from day one.
- **The model never widens risk.** Stops only tighten, limits only come down, unless I change them myself through a logged settings change.
- **Protection does not depend on the model or on news.** Price-based exits run even if every research source and model call is down.
- **Unknown state blocks new exposure.** If the bot cannot tell what it holds, it stops opening positions and tells me.
- **Private.** The dashboard is reachable only over an SSH tunnel. No public port, no accounts, no branding.

## Owner decisions

Values the bot uses that only I can set. Defaults are what Phase 1 starts with; I change them through the versioned settings, never by editing code.

| Decision | Phase 1 default | Set by |
|---|---|---|
| Starting paper capital | ₹9,000 | me, before Phase 1 |
| Universe | 10 liquid NSE stocks priced under ₹1,500/share (so one share is affordable) | me, before Phase 1 |
| Bar size / horizon | 15-minute closed bars; hold 1–5 sessions; delivery (CNC), long-only | me, before Phase 1 |
| Risk per trade / max daily loss / max drawdown | 0.5% / 3% / 8% | me, before Phase 1 |
| Phase 1 length | 40 trading sessions | me, before Phase 1 |
| Monthly spend cap (data + VPS + models) | ₹1,200 | me, before Phase 1 |
| Live capital and max loss | unset — Phase 2 cannot start without it | me, before Phase 2 |

## Later, not now

- US markets (needs a US-eligible broker and an understanding of the tax/regulatory side).
- Jev AI or any other specialised model: fits the structured-output slot in `src/models.mjs`; evaluate it in Phase 1b shadow mode against a recorded period, not before.
- Intraday leverage (MIS), F&O, short selling.
- Alerts to phone, Tailscale instead of SSH, a second broker.

## Where the detail lives

[PRD](PRD.md) for requirements, [ESOD](ESOD.md) for architecture, [market intelligence](MARKET-INTELLIGENCE.md) for the research design, [lifecycle agreements](LIFECYCLE-AGREEMENTS.md) for operating rules, [resume plan](RESUME-PLAN.md) for the current build state, and `superpowers/specs/` for the per-phase designs.
