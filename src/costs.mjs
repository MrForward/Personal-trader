// Zerodha equity charges. Source: https://zerodha.com/charges, read 17 October 2026.
// A CNC buy and sell in the same session is charged as intraday (Zerodha support: "brokerage charged for partial delivery");
// those shares never reach demat, so no DP charge. Re-check the page before relying on a new schedule version.
const SCHEDULES = Object.freeze({
  none: { sttBuyPct: 0, sttSellPct: 0, exchangePct: 0, sebiPerCrore: 0, stampBuyPct: 0, gstPct: 0, dpPerSellDay: 0, brokeragePct: 0, brokerageCap: 0 },
  'zerodha-cnc-2026-10': { sttBuyPct: 0.1, sttSellPct: 0.1, exchangePct: 0.00307, sebiPerCrore: 10, stampBuyPct: 0.015, gstPct: 18, dpPerSellDay: 15.34, brokeragePct: 0, brokerageCap: 0 },
  'zerodha-intraday-2026-10': { sttBuyPct: 0, sttSellPct: 0.025, exchangePct: 0.00307, sebiPerCrore: 10, stampBuyPct: 0.003, gstPct: 18, dpPerSellDay: 0, brokeragePct: 0.03, brokerageCap: 20 },
});
// Schedules an owner can select; the intraday one is applied automatically to same-day round trips.
export const COST_SCHEDULES = Object.freeze(['none', 'zerodha-cnc-2026-10']);
export const INTRADAY_OF = Object.freeze({ none: 'none', 'zerodha-cnc-2026-10': 'zerodha-intraday-2026-10' });
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
  const brokerage = Math.min(value * r.brokeragePct / 100, r.brokerageCap);
  const stt = value * (side === 'BUY' ? r.sttBuyPct : r.sttSellPct) / 100, exchange = value * r.exchangePct / 100, sebi = value * r.sebiPerCrore / 1e7;
  const stamp = side === 'BUY' ? value * r.stampBuyPct / 100 : 0;
  const gst = (brokerage + exchange + sebi) * r.gstPct / 100;
  const dp = side === 'SELL' && dpApplies ? r.dpPerSellDay : 0;
  const parts = { schedule, brokerage: money(brokerage), stt: money(stt), exchange: money(exchange), sebi: money(sebi), stamp: money(stamp), gst: money(gst), dp: money(dp) };
  return { ...parts, total: money(brokerage + stt + exchange + sebi + stamp + gst + dp) };
}

// Fraction of trade value, excluding the flat DP charge; used for sizing only.
export function perShareRate(schedule, side) {
  const r = rates(schedule, side);
  const pct = (side === 'BUY' ? r.sttBuyPct + r.stampBuyPct : r.sttSellPct) + r.exchangePct + r.brokeragePct * (1 + r.gstPct / 100) + (r.exchangePct * r.gstPct / 100);
  return pct / 100 + r.sebiPerCrore / 1e7 * (1 + r.gstPct / 100);
}
