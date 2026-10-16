# Personal Trading Lab

The owner resumed the local paper build on 13 October 2026. This is the first proving environment for a personal financial trading expert bot. It uses fictional market/evidence fixtures or imported historical data, simulated orders and a persisted SQLite ledger. No broker, live news service or real-money execution is connected.

## Run locally

Use Node 24 or later. From this directory:

```sh
npm run dev
```

Open `http://127.0.0.1:3000`. The app binds to loopback, starts replay paused and uses rules without a model key. Step a closed-bar decision forward, run/pause the replay, inspect position protection and the decision journal, change versioned settings, import captured data, or export the recorded evidence. Reset archives the current run before starting another.

```sh
npm test
npm run typecheck
```

The dashboard uses Node built-ins; installed eve dependencies are for the separate optional diagnostic harness. `npm run agent:dev` is not needed to run the dashboard and can require model authentication/paid usage. Default shell/file tools are disabled; diagnostics have a read-only snapshot tool. Its model is separately configured in `agent/agent.ts`.

## Model access and expenses

The dashboard supports rules, OpenAI and Anthropic profiles with a chosen model ID, output/call limits and timeouts. Keys belong only in a local `.env` or private server secrets, never chat or Git. Paid calls are disabled by default even if a key exists. Enable `TRADING_LAB_ALLOW_PAID_MODEL_CALLS=1` only after choosing a budget and supported provider/model; no paid call was made to verify this build.

This local stage does not implement a monetary spend meter or provider-specific reasoning controls. Daily call/output limits bound requests, not exact currency costs. Confirm pricing and add required spend controls before operating a paid prospective experiment.

## Imported data and captured intelligence

Price CSV header:

```csv
timestamp,symbol,open,high,low,close,volume
```

Supply 35–5,000 strictly increasing aligned timestamps, with 1–20 consistent symbols and valid closed OHLCV bars. Use explicit timezones; missing prices are not forward-filled. Historical import does not establish data licensing, corporate-action correctness or live freshness. Record source assumptions for a real experiment.

Captured evidence records use `id`, `symbol`, `origin`, `publishedAt`, `firstReceivedAt`, `analysisReadyAt`, `sourceKind`, `verificationStatus`, `version`, `content` and optional `supersedes`, `eventAt`, `sourceUrl`. Context includes only versions usable by the decision time, preserves corrections, deduplicates shared origins and exposes stale/unknown coverage. Imported verification labels are metadata, not independent verification by the app.

The live research design is in [market intelligence](docs/MARKET-INTELLIGENCE.md). Browser/feed acquisition, source qualification and operational freshness are later integrations; fixtures do not implement them.

## Evidence and next stages

Read the [planning index](docs/README.md), [PRD](docs/PRD.md), [ESOD](docs/ESOD.md), [PRFAQ](docs/PRFAQ.md), [lifecycle agreements](docs/LIFECYCLE-AGREEMENTS.md) and [development checkpoint](docs/RESUME-PLAN.md). Local checks establish software behavior, not expert competence, a profitable edge or live readiness. Costs/fills are simplified assumptions. Risk defaults are experimental examples, not an approved live mandate.

Operational feeds, model spending, VPS deployment and a capped Zerodha pilot require their relevant setup and owner decisions. Strategy/model evaluation and prospectively captured evidence come before reliance on returns. No paid plan, broker connection or cloud resource was provisioned.
