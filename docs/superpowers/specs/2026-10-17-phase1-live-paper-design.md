# Phase 1 — Prospective paper trading on live Kite data, on a VPS

- **Date:** 17 October 2026, Asia/Kolkata
- **Status:** Design for owner review. Nothing in it is built.
- **Goal served:** [GOAL.md](../../GOAL.md) Phase 1
- **Replaces:** the ordering in [RESUME-PLAN.md](../../RESUME-PLAN.md) that builds every expert layer on synthetic data before touching live data. Real data arrival behaviour is what the expert layers depend on, so it comes first.

## 1. What Phase 1 delivers

The existing paper engine runs on a VPS, fed by live NSE prices from Kite Connect, with the rules-only strategies, a real Zerodha cost model, and daily reports that compare it with buy-and-hold after fixed costs. Every tick is recorded so any day can be replayed exactly.

Not in Phase 1: real orders, news/evidence feeds, model calls, US markets, alerts, Tailscale. See GOAL.md "Later, not now".

## 2. What you buy

| Item | Cost | Why |
|---|---|---|
| Kite Connect app, **Connect (paid)** tier | ₹500/month per app key | The free Personal tier places orders but has no live or historical data. The paid tier includes both. From October 2026, ₹2,000+ brokerage in a month earns credits covering the next month; at ₹10k capital on delivery (₹0 brokerage) that will not apply. |
| AWS Lightsail, Linux, **1 GB** plan, Mumbai region | $7/month (~₹600) | Static IP included (needed for Zerodha API orders in Phase 2). 0.5 GB is too tight for Node + SQLite + the Kite WebSocket; 1 GB leaves headroom. |

Total fixed cost ≈ ₹1,100/month, inside the ₹1,200 cap in GOAL.md. Model calls are off in Phase 1.

Steps for you, in order:
1. Zerodha → developers.kite.trade → create an app. Type "Connect". Redirect URL: `http://127.0.0.1:3000/kite/callback`. Pay ₹500. Keep the API key and secret; they go only into `/etc/trading-lab.env` on the VPS.
2. Lightsail → create instance → Mumbai → Ubuntu 24.04 → $7 plan → attach the static IP it gives you → firewall: SSH only, from your IP.
3. Give me the VPS SSH address and the app's API key name (not the secret). I deploy from there.

## 3. Architecture

One Node 24 process, same as today, plus a live feed. Research and models stay outside the price path.

```
Kite WebSocket ──ticks──▶ bars.mjs ──closed bar──▶ engine.step() ──▶ SQLite ledger
       │                     │                                           │
       ▼                     ▼                                           ▼
 ticks-YYYY-MM-DD.jsonl   warmup from Kite historical API        dashboard over SSH tunnel
```

### New modules

| File | Responsibility | Depends on |
|---|---|---|
| `src/kite.mjs` | Session (login URL, token exchange, expiry), WebSocket subscription for the watchlist, historical candles for warmup. Wraps the official `kiteconnect` npm package. | `kiteconnect`, env secrets |
| `src/bars.mjs` | Turns ticks into closed OHLCV bars of the configured size. Pure function over a tick stream; no I/O. | nothing |
| `src/costs.mjs` | Zerodha CNC charge schedule, versioned. Replaces the flat `feeBps`. | nothing |
| `src/live.mjs` | Glue: on each closed bar, append to the engine's dataset and call `step()`. Writes the tick capture file. Owns the "session valid / market open / warmed up" gate. | kite, bars, engine |

### Changed modules

| File | Change |
|---|---|
| `src/engine.mjs` | Accept bars appended at runtime (today the dataset is fixed at import). Mode label `prospective-paper`. Fill at the first tick after the decision bar closes, labelled `observed`; fall back to next-bar open labelled `assumed` if no tick within 60 s. Use `costs.mjs`. |
| `src/config.mjs` | Add `universe` (symbols), `barMinutes`, `costSchedule` version; remove `feeBps`. Keep `slippageBps`. |
| `src/server.mjs` | Routes `GET /kite/login` (redirect to Kite), `GET /kite/callback` (token exchange), `GET /api/kite/status`. `/api/health` reports session validity and last tick time. |
| `public/app.js`, `index.html` | A "Kite" panel: session state, last tick, bars today, a Login button. Nothing else. |
| `src/store.mjs` | Table `kite_session(id=1, access_token, user_id, issued_at, expires_at)`. Table `daily_report(date, payload)`. |
| `deploy/` | Service file gains `KITE_API_KEY`, `KITE_API_SECRET` via the env file; README gets the real steps from §7. |
| `tests/` | New: `bars.test.mjs`, `costs.test.mjs`, `kite.test.mjs` (mocked), `live.test.mjs` (replay a recorded tick file). |

## 4. Daily login

Kite personal tokens expire at 6 AM; there is no refresh. The flow:

1. Each morning before 9:15 you run `ssh -L 3000:127.0.0.1:3000 ubuntu@<vps>` and open `http://127.0.0.1:3000`.
2. The Kite panel shows **Session expired**. Click **Login**. The server redirects you to Kite; you complete Zerodha login + TOTP.
3. Kite redirects to `http://127.0.0.1:3000/kite/callback?request_token=…`. Through the tunnel that hits the VPS. The server exchanges it for an access token with the API secret, stores it, subscribes the WebSocket.
4. Panel shows **Session valid until 06:00 tomorrow**. Done; close the tunnel if you like.

Until step 4 completes the bot opens no new paper positions. Open positions keep their stop/target logic once ticks resume; while no ticks arrive, the ledger records `protection: no data` for each bar period missed. This is honest, not a guarantee: a stop cannot fire without a price.

Weekends and NSE holidays: no login needed; the bot idles. A holiday calendar is a short JSON list in `src/calendar.mjs`, updated yearly by hand.

## 5. Data flow and causality

- **Subscribe** in Kite `full` mode for the universe: last price, volume, exchange timestamp, depth.
- **Capture** every tick as one JSON line to `/var/lib/trading-lab/ticks/YYYY-MM-DD.jsonl`, written before anything else uses it. Replaying that file through `live.mjs` must reproduce the day's ledger exactly (R-009). This file is also the only way to test on a quiet evening.
- **Bars**: a 15-minute bar `[09:15, 09:30)` closes when the first tick with exchange time ≥ 09:30 arrives, or at 09:30:30 wall clock if no tick came (bar marked `thin`). The decision for that bar runs only after close, with the bar's own data only (R-002).
- **Warmup**: on start, fetch the last 25 closed 15-minute bars per symbol from the historical API so a restart at 11:00 does not mean 6 hours of HOLD. Historical bars are flagged `source: historical`.
- **Clock**: exchange timestamps drive bars; wall clock only closes thin bars. Clock skew > 5 s between VPS and exchange time logs a warning and blocks new entries.
- **Out-of-order / duplicate ticks**: dropped and counted. If > 1% of ticks in a session are dropped, the day's report flags data quality.

## 6. Costs

Zerodha equity delivery (CNC), as of 17 October 2026, to be re-checked against Zerodha's charges page when `costs.mjs` is written and recorded there with the check date:

| Charge | Rate | Side |
|---|---|---|
| Brokerage | ₹0 | — |
| STT | 0.1% | buy and sell |
| NSE transaction | 0.00307% | both |
| SEBI | ₹10 per crore | both |
| Stamp duty | 0.015% | buy |
| GST | 18% of (brokerage + exchange + SEBI) | both |
| DP charge | ₹15.34 per scrip per sell day | sell |

**Same-session round trips** (amended 17 October 2026 after review): Zerodha charges a CNC buy and sell in the same session at intraday rates: brokerage 0.03% or ₹20 per order, whichever is lower; STT 0.025% on the sell only; stamp 0.003% on the buy; exchange, SEBI and GST as above (GST also on brokerage); no DP charge, since the shares never reach demat. The buy is charged delivery rates when it happens (whether it will be sold the same day is unknown then); a same-day sell carries the difference so the round trip totals intraday charges. Sources: [charges](https://zerodha.com/charges/), [Zerodha support](https://support.zerodha.com/category/account-opening/resident-individual/ri-charges/articles/brokerage-charged-for-partial-delivery).

For a ₹1,000 one-share delivery round trip that is about ₹2.5 in taxes plus ₹15.34 DP, i.e. ~1.8%. That is why `feeBps=10` understates it and why the universe must stay in stocks where one share is a meaningful position. Golden tests cover: single buy, single sell, two sells of the same scrip on one day (one DP charge), partial exit across two days (two DP charges).

Fixed costs (₹500 data + ₹600 VPS, prorated per trading day) appear as a separate line in every report. They are never charged to the paper ledger, so trading P&L stays comparable with buy-and-hold; the report subtracts them below the line.

## 7. VPS and operations

- Ubuntu 24.04, Node 24 from NodeSource, `ufw` allow 22 only. Dashboard binds 127.0.0.1.
- `deploy/trading-lab.service` as today, plus `ReadWritePaths=/var/lib/trading-lab` already covers ticks and backups.
- Deploy = `rsync src public package.json` + `npm ci --omit=dev` + `systemctl restart`. A `deploy/deploy.sh` does this; no CI, no Docker in Phase 1.
- **Backup**: a `systemd` timer at 16:00 IST copies `trading-lab.sqlite` and the day's tick file to `/var/lib/trading-lab/backups/`, keeps 30 days. Restore is documented and tested once before Phase 1 starts.
- **Restart**: service starts paused until it has checked the stored session and reconciled the ledger (existing behaviour); then subscribes if the session is valid.
- **Logs**: `journalctl -u trading-lab`. Secrets are never logged; the existing redaction covers the Kite token.
- **Spend cap**: the daily report shows month-to-date fixed cost against the ₹1,200 cap. No automatic action; it is for you to see.

## 8. Risk and failure behaviour

Existing rules stay (model cannot widen stops; daily/drawdown caps latch; fail closed on unknown state). Phase 1 adds:

| Situation | Behaviour |
|---|---|
| WebSocket drops | Reconnect with backoff up to 5 min. Bars during the gap are `thin`/missing; no new entries until 2 clean bars arrive. Positions keep their rules on the next real price. |
| Token expires mid-session (Kite can invalidate early) | Same as a drop, plus the panel shows **Login needed**. |
| Historical API fails at warmup | Start with an empty history; strategies HOLD for 25 bars. Logged. |
| Disk full / SQLite write fails | Process exits; systemd restarts; starts paused. Tick capture is append-only so nothing already written is lost. |
| Clock skew, >1% dropped ticks, thin bars > 20% of a session | Day's report carries a data-quality flag; the day is excluded from the Phase 1 scorecard but kept in the ledger. |

## 9. Reports and the Phase 1 scorecard

At 15:45 IST each trading day, `live.mjs` writes a `daily_report` row and the dashboard shows it:

- Equity, cash, open positions with stops, realised/unrealised P&L.
- Trades today with observed vs assumed fills and the full cost breakdown.
- Buy-and-hold equal-weight on the universe from Phase 1 day 1, same cost model.
- Fixed costs to date; net after fixed costs.
- Data quality: ticks, dropped, thin bars, session gaps, login time.

The scorecard after 40 clean sessions answers GOAL.md's exit bar: net ≥ 0 after fixed costs, beats buy-and-hold, zero unexplained ledger differences, zero positions that lacked protection while a price was available. Losing is a valid, reported outcome.

## 10. Testing

- `bars.test.mjs`: tick sequences → bars; late tick, duplicate, out-of-order, thin close, bar boundary at 09:15 and 15:30.
- `costs.test.mjs`: the golden cases in §6.
- `kite.test.mjs`: token exchange, expiry at 06:00, early invalidation, callback with a bad token; all with a mocked HTTP client. No real Kite call in tests.
- `live.test.mjs`: replay a committed 1-day fixture tick file (synthetic symbols, fictional prices) and assert the ledger; replay it twice and assert identical output.
- Existing 64 tests keep passing; `feeBps` removal updates `config.test.mjs` and `engine.test.mjs`.
- Before Phase 1 day 1, one manual check on the VPS: login, see ticks, see a bar close, see a decision, restart the service, see state restored.

## 11. Open points you decide

Defaults are set in GOAL.md; confirm or change before implementation starts:

1. The 10-stock universe (I will propose a list of liquid NIFTY names under ₹1,500 once you confirm the price cap).
2. 15-minute bars and 1–5 session holds.
3. 40 sessions as the Phase 1 length.
4. Whether the Phase 1b shadow-model work starts in parallel once ticks are flowing, or after the 40 sessions.

## 12. Implementation order

1. `costs.mjs` + tests; swap into the engine. (Local, no Kite needed.)
2. `bars.mjs` + tests. (Local.)
3. `kite.mjs` session + routes + panel; `kite.test.mjs`. (Needs your API key on the VPS to try for real.)
4. `live.mjs` + tick capture + warmup + `live.test.mjs`.
5. Daily report + buy-and-hold line.
6. `deploy/deploy.sh`, backup timer, README; first deploy; manual check.
7. Update RESUME-PLAN.md; start the 40-session clock.
