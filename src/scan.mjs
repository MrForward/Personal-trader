// Pre-market scan: which liquid NSE names deserve a watchlist slot today. Held names always keep theirs.
const CRORE = 10_000_000, LOOKBACK = 20, MIN_DAILY_BARS = 25;
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;

// Long-only opportunism: positive 20-session momentum, ranked with last session's volume against its 20-session average.
export function rankCandidates(dailyBySymbol) {
  const rows = [];
  for (const [symbol, bars] of Object.entries(dailyBySymbol)) {
    if (!Array.isArray(bars) || bars.length < MIN_DAILY_BARS) continue;
    const closes = bars.map(bar => bar.close), volumes = bars.map(bar => bar.volume);
    const momentum = closes.at(-1) / closes.at(-1 - LOOKBACK) - 1, baseline = mean(volumes.slice(-1 - LOOKBACK, -1));
    const relVolume = baseline > 0 ? volumes.at(-1) / baseline : 0;
    if (Number.isFinite(momentum) && momentum > 0) rows.push({ symbol, momentum, relVolume });
  }
  const rank = key => new Map([...rows].sort((a, b) => b[key] - a[key]).map((row, index) => [row.symbol, index]));
  const byMomentum = rank('momentum'), byVolume = rank('relVolume');
  return rows.map(row => ({ ...row, score: byMomentum.get(row.symbol) + byVolume.get(row.symbol) }))
    .sort((a, b) => a.score - b.score || a.symbol.localeCompare(b.symbol));
}

export function chooseWatchlist({ held = [], ranked = [], slots }) {
  const chosen = [...new Set(held)];
  for (const symbol of ranked) { if (chosen.length >= slots) break; if (!chosen.includes(symbol)) chosen.push(symbol); }
  return chosen.sort();
}

// One quote sweep over every listed equity, then daily bars for the most traded names under the price cap.
export async function scanWatchlist({ session, settings, held, endMs, log = () => {}, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const { slots, maxPrice, minTurnoverCr } = settings.scan;
  const quotes = await session.quotes(session.equities());
  const pool = Object.entries(quotes)
    .map(([symbol, q]) => ({ symbol, price: q.price, turnover: q.volume * q.averagePrice }))
    .filter(c => c.price > 0 && c.price <= maxPrice && c.turnover >= minTurnoverCr * CRORE)
    .sort((a, b) => b.turnover - a.turnover).slice(0, 3 * slots);
  if (!pool.length) throw new Error('Scan found no liquid candidates; quotes carry no volume this early.');
  const daily = {};
  for (const { symbol } of pool) {
    try { daily[symbol] = await session.historicalBars({ symbol, barMinutes: 'day', count: 60, endMs }); }
    catch (error) { log(`Scan: daily bars for ${symbol} unavailable: ${error.message}`); }
    await pause(350); // Kite allows ~3 historical requests a second.
  }
  return chooseWatchlist({ held, ranked: rankCandidates(daily).map(row => row.symbol), slots });
}
