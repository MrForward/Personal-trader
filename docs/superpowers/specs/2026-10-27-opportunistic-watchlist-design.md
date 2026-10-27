# Opportunistic watchlist — daily scan into a sticky universe

- **Date:** 27 October 2026, Asia/Kolkata
- **Status:** Built with this document. Owner decisions taken the same day: widen beyond the fixed 10 names with a daily rule-based scan; both paper books trade the same watchlist; the Phase 1 benchmark becomes NIFTY 50 buy-and-hold.
- **Goal served:** [GOAL.md](../../GOAL.md) "decides like an experienced trader", now across the market rather than a hand-picked list.

## Shape

```
06:00–09:00  owner logs in → every NSE token stored (equities + indices), ticker subscribes only to the universe
08:15 IST    scan: quotes for every listed equity → price ≤ ₹1,500, turnover ≥ ₹25 crore → top 60 by turnover
             → 60 daily bars each → positive 20-session momentum ranked with relative volume
             → watchlist = held names (both books) + best new names, up to `scan.slots` (20)
             → engine.relist() on both books: universe and assets swap, history for new names merges onto the dataset,
               the book, trades, benchmarks and run id carry on; ticker re-subscribes
08:30 / 08:45  research and theses run on the new watchlist (unchanged)
```

## Rules

- A held name never leaves the universe; the engine refuses a universe change that drops one (`guardUniverse`). The scan passes held names in first, so this only fires on a bug or an owner edit.
- Bar size still needs a flat book to change.
- Rows older than a name's first history keep no bar for it; strategies and the expert read the bars a name has (`histories` skips gaps), so a new name trades on its 40 warmup bars at first.
- The benchmark is NIFTY 50 buy-and-hold, marked from the index's last daily close at each warmup and relist (`markIndex`). A run whose equal-weight benchmark already holds a dropped name values that holding at its last mark; reset the run for a clean index comparison.
- Scan failure (empty quotes, Kite down) keeps yesterday's watchlist and logs why. The scan is a settings group (`scan.enabled`, `slots`, `maxPrice`, `minTurnoverCr`), versioned like every other owner value.

## Not built

- Expert research proposing names from news; a sector cap on the chosen names; per-name turnover history (the pool uses the quote's last-session volume, which Kite resets at pre-open, so the scan runs before 09:00).
