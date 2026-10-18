import { analyzeMarket } from './strategies.mjs';
import { HOLIDAYS_2026 } from './calendar.mjs';

// shortcut: hand-maintained sector map for the placeholder universe; unmapped symbols simply get no sector series.
export const SECTOR_INDEX = { RELIANCE: 'NIFTY ENERGY', INFY: 'NIFTY IT', HDFCBANK: 'NIFTY BANK', ICICIBANK: 'NIFTY BANK', ITC: 'NIFTY FMCG', SBIN: 'NIFTY BANK', WIPRO: 'NIFTY IT', ONGC: 'NIFTY ENERGY', COALINDIA: 'NIFTY ENERGY', TATASTEEL: 'NIFTY METAL' };

const MAX_PACK_CHARS = 60_000, DAILY_ROWS = 60;
const istDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
const sum = values => values.reduce((total, value) => total + value, 0);

/**
 * Everything the model sees for one symbol at `asOf`. Pure: every series is cut at `asOf` here, whatever the caller passed in.
 * A daily bar is stamped at its session close (15:30 IST), so the day still forming at `asOf` is never visible.
 */
export function buildContextPack({ symbol, asOf, state, daily = {}, intelligence = null, memory = [], thesis = null, callsRemaining = null }) {
  const at = new Date(asOf).getTime();
  if (!Number.isFinite(at)) throw new RangeError('asOf must be a valid time.');
  asOf = new Date(at).toISOString();
  const today = istDay.format(at);
  const known = stamp => Date.parse(stamp) <= at;

  const rows = state.dataset.filter(row => known(row.timestamp) && row.bars[symbol]);
  const history = rows.map(row => ({ timestamp: row.timestamp, ...row.bars[symbol] }));
  const features = analyzeMarket(history);
  const todays = history.filter(bar => istDay.format(Date.parse(bar.timestamp)) === today);

  const series = name => (daily[name] ?? []).filter(bar => known(`${bar.date}T15:30:00+05:30`)).slice(-DAILY_ROWS);
  const closes = name => { const bars = series(name); return bars.length ? bars.map(({ date, close }) => ({ date, close })) : null; };
  const stockDaily = series(symbol);
  const prior = stockDaily.filter(bar => bar.date < today).slice(-20);
  const avgVolume = prior.length === 20 ? sum(prior.map(bar => bar.volume)) / 20 : 0;
  const sectorIndex = SECTOR_INDEX[symbol] ?? null;

  const claims = (intelligence?.claims ?? []).filter(claim => known(claim.analysisReadyAt));
  const holidayLimit = new Date(at + 5.5 * 3_600_000 + 14 * 86_400_000).toISOString().slice(0, 10);

  const pack = {
    version: 1, symbol, asOf,
    price: {
      features,
      todayRangeAtr: todays.length && features.atr > 0 ? (Math.max(...todays.map(bar => bar.high)) - Math.min(...todays.map(bar => bar.low))) / features.atr : null,
      volumeVs20d: todays.length && avgVolume > 0 ? sum(todays.map(bar => bar.volume)) / avgVolume : null,
      daily: stockDaily,
      nifty50: closes('NIFTY 50'),
      sector: { index: sectorIndex, closes: sectorIndex ? closes(sectorIndex) : null },
    },
    evidence: { claims: claims.filter(claim => !claim.sourceKinds?.includes('calendar')), coverage: intelligence?.coverage ?? null, limitations: intelligence?.limitations ?? [] },
    calendar: { events: claims.filter(claim => claim.sourceKinds?.includes('calendar')), holidays: HOLIDAYS_2026.filter(day => day > today && day <= holidayLimit) },
    portfolio: {
      cash: state.cash ?? null, equity: state.metrics?.equity ?? null, exposurePct: state.metrics?.exposurePct ?? null,
      position: structuredClone(state.positions?.find(position => position.symbol === symbol) ?? null),
      thesis: thesis && (!thesis.createdAt || known(thesis.createdAt)) ? thesis : null,
    },
    memory: memory.filter(entry => known(entry.reviewedAt)).sort((a, b) => Date.parse(b.reviewedAt) - Date.parse(a.reviewedAt)).slice(0, 5),
    limits: { ...state.settings.risk, sizingIsDeterministic: true, callsRemaining },
  };
  const size = JSON.stringify(pack).length;
  if (size > MAX_PACK_CHARS) throw new Error(`Context pack is ${size} characters; the limit is ${MAX_PACK_CHARS}.`);
  return pack;
}
