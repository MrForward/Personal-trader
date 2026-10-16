const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const FIELDS = ['open', 'high', 'low', 'close', 'volume'];

function timestamp(value, now) {
  if (typeof value !== 'string') throw new Error('Timestamps must be ISO strings with an explicit timezone.');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error('Timestamps must be ISO strings with an explicit timezone.');
  const [, year, month, day, hour, minute, second, , offset] = match;
  const check = new Date(0);
  check.setUTCFullYear(+year, +month - 1, +day);
  check.setUTCHours(+hour, +minute, +second, 0);
  if (check.getUTCFullYear() !== +year || check.getUTCMonth() !== +month - 1 || check.getUTCDate() !== +day
    || +hour > 23 || +minute > 59 || +second > 59
    || (offset !== 'Z' && (+offset.slice(1, 3) > 14 || +offset.slice(4) > 59 || (+offset.slice(1, 3) === 14 && +offset.slice(4) !== 0)))) throw new Error('Invalid calendar timestamp or timezone offset.');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > now) throw new Error('Bars must have valid timestamps that are not in the future.');
  return time;
}

export function validateDataset(rows, { now = Date.now() } = {}) {
  if (!Number.isFinite(now)) throw new Error('The dataset validation clock must be finite.');
  if (!Array.isArray(rows) || rows.length < 35 || rows.length > 5000) throw new Error('Provide between 35 and 5,000 aligned timestamps.');
  let lastTime = -Infinity;
  let symbols;
  const result = rows.map(row => {
    if (!object(row) || !object(row.bars)) throw new Error('Each timestamp requires an object of bars.');
    if (Object.keys(row).some(key => !['timestamp', 'bars', 'closed', 'isClosed'].includes(key))) throw new Error('Unknown dataset row field.');
    for (const flag of ['closed', 'isClosed']) if (Object.hasOwn(row, flag) && row[flag] !== true) throw new Error('Only closed bars can be imported.');
    const time = timestamp(row.timestamp, now);
    if (time <= lastTime) throw new Error('Timestamps must be unique and strictly increasing.');
    lastTime = time;
    const keys = Object.keys(row.bars).sort();
    if (!keys.length || keys.length > 20 || keys.some(key => !/^[A-Z0-9][A-Z0-9._-]{0,24}$/.test(key))) throw new Error('Use 1–20 valid symbols.');
    if (symbols && JSON.stringify(keys) !== JSON.stringify(symbols)) throw new Error('Every timestamp must contain all symbols; missing prices cannot be forward-filled here.');
    symbols ??= keys;
    const bars = {};
    for (const symbol of keys) {
      const source = row.bars[symbol];
      if (!object(source) || Object.keys(source).some(key => ![...FIELDS, 'timestamp', 'closed', 'isClosed'].includes(key))) throw new Error('Invalid or unknown bar field.');
      for (const flag of ['closed', 'isClosed']) if (Object.hasOwn(source, flag) && source[flag] !== true) throw new Error('Only closed bars can be imported.');
      if (Object.hasOwn(source, 'timestamp') && timestamp(source.timestamp, now) !== time) throw new Error('Bar timestamp must match its aligned row.');
      const bar = { timestamp: new Date(time).toISOString(), closed: true };
      for (const field of FIELDS) {
        if (typeof source[field] !== 'number' || !Number.isFinite(source[field]) || source[field] < 0 || (field !== 'volume' && source[field] === 0)) throw new Error(`Invalid ${field} for ${symbol}.`);
        bar[field] = source[field];
      }
      if (bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) || bar.low > bar.high) throw new Error(`Inconsistent OHLC for ${symbol}.`);
      bars[symbol] = bar;
    }
    return { timestamp: new Date(time).toISOString(), closed: true, bars };
  });
  return { rows: result, symbols, timestampMeaning: 'Each timestamp identifies a completed bar; decisions use only the closed prefix.' };
}

export function parseCsv(csv, options) {
  if (typeof csv !== 'string' || !csv.trim() || csv.length > 8000000) throw new Error('CSV must be nonempty text of at most 8 MB.');
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length > 100001) throw new Error('CSV contains too many rows.');
  const expected = ['timestamp', 'symbol', 'open', 'high', 'low', 'close', 'volume'];
  const header = lines.shift().split(',').map(value => value.trim().toLowerCase());
  if (JSON.stringify(header) !== JSON.stringify(expected)) throw new Error(`CSV header must be ${expected.join(',')}`);
  const grouped = new Map();
  const now = options?.now ?? Date.now();
  let previousTime = -Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = line.split(',').map(value => value.trim());
    if (fields.length !== 7 || line.includes('"')) throw new Error('Each CSV row needs seven unquoted columns.');
    const [stamp, symbol, ...numbers] = fields;
    if (numbers.some(value => !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))) throw new Error('OHLCV fields must be finite decimal numbers.');
    const time = timestamp(stamp, now);
    if (time < previousTime) throw new Error('CSV timestamps must be ordered.');
    previousTime = time;
    const key = new Date(time).toISOString();
    const row = grouped.get(key) ?? { timestamp: key, bars: {} };
    if (Object.hasOwn(row.bars, symbol)) throw new Error('Duplicate symbol at the same timestamp.');
    if (!/^[A-Z0-9][A-Z0-9._-]{0,24}$/.test(symbol)) throw new Error('Invalid CSV symbol.');
    row.bars[symbol] = Object.fromEntries(FIELDS.map((field, index) => [field, Number(numbers[index])]));
    grouped.set(key, row);
  }
  return validateDataset([...grouped.values()], { now });
}
