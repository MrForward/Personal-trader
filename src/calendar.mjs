// NSE capital-market trading holidays on weekdays, from https://zerodha.com/marketintel/holiday-calendar/ read 17 October 2026.
// shortcut: hand-maintained yearly list with no special sessions (e.g. Diwali Muhurat); add the next year's list each December.
export const HOLIDAYS_2026 = Object.freeze([
  '2026-01-15', '2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03', '2026-04-14', '2026-05-01',
  '2026-05-28', '2026-06-26', '2026-09-14', '2026-10-02', '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25',
]);
const HOLIDAYS = new Set(HOLIDAYS_2026);
const istDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });

export function sessionFor(dateMs) {
  if (!Number.isFinite(dateMs)) throw new Error('Session lookup needs a finite time.');
  const parts = Object.fromEntries(istDay.formatToParts(new Date(dateMs)).map(part => [part.type, part.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun' || HOLIDAYS.has(day)) return null;
  return { day, openMs: Date.parse(`${day}T09:15:00+05:30`), closeMs: Date.parse(`${day}T15:30:00+05:30`) };
}
