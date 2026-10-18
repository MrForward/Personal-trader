// Zerodha equity delivery (CNC) charges. Source: https://zerodha.com/charges, read 17 October 2026.
// Re-check that page before relying on a new schedule version; rates are versioned by the schedule key.
const SCHEDULES = Object.freeze({
  none: { sttPct: 0, exchangePct: 0, sebiPerCrore: 0, stampBuyPct: 0, gstPct: 0, dpPerSellDay: 0 },
  'zerodha-cnc-2026-10': { sttPct: 0.1, exchangePct: 0.00297, sebiPerCrore: 10, stampBuyPct: 0.015, gstPct: 18, dpPerSellDay: 15.34 },
});
export const COST_SCHEDULES = Object.freeze(Object.keys(SCHEDULES));
const money = n => Math.round(n * 100) / 100;

function rates(schedule, side) {
  const r = SCHEDULES[schedule];
  if (!r) throw new Error(`Unknown cost schedule: ${schedule}`);
  if (side !== 'BUY' && side !== 'SELL') throw new Error(`Unknown trade side: ${side}`);
  return r;
}

export function charges({ schedule, side, price, quantity, dpApplies }) {
  const r = rates(schedule, side);
  const value = price * quantity;
  const stt = value * r.sttPct / 100, exchange = value * r.exchangePct / 100, sebi = value * r.sebiPerCrore / 1e7;
  const stamp = side === 'BUY' ? value * r.stampBuyPct / 100 : 0;
  const gst = (exchange + sebi) * r.gstPct / 100; // brokerage is zero on delivery
  const dp = side === 'SELL' && dpApplies ? r.dpPerSellDay : 0;
  const parts = { stt: money(stt), exchange: money(exchange), sebi: money(sebi), stamp: money(stamp), gst: money(gst), dp: money(dp) };
  return { ...parts, total: money(stt + exchange + sebi + stamp + gst + dp) };
}

// Fraction of trade value, excluding the flat DP charge; used for sizing only.
export function perShareRate(schedule, side) {
  const r = rates(schedule, side);
  const pct = r.sttPct + r.exchangePct + (side === 'BUY' ? r.stampBuyPct : 0) + (r.exchangePct * r.gstPct / 100);
  return pct / 100 + r.sebiPerCrore / 1e7 * (1 + r.gstPct / 100);
}
