/** Captured, time-correct evidence for local paper experiments. No network or trading authority. */
export const SOURCE_KINDS = Object.freeze(['primary', 'news', 'social', 'calendar', 'synthetic', 'other']);
export const VERIFICATION_STATUSES = Object.freeze(['unverified', 'reported', 'corroborated', 'primary-confirmed', 'disputed', 'retracted']);
const VERIFIED = new Set(['corroborated', 'primary-confirmed']);
const FIELDS = new Set(['id', 'symbol', 'origin', 'publishedAt', 'firstReceivedAt', 'analysisReadyAt', 'sourceKind', 'verificationStatus', 'version', 'supersedes', 'content', 'eventAt', 'sourceUrl']);
const SOURCE_PRIORITY = { primary: 5, synthetic: 4, calendar: 3, news: 2, social: 1, other: 0 };
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const originKey = (record) => JSON.stringify([record.symbol, record.origin]);

function text(value, name, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} must be nonempty text of at most ${maximum} characters without control characters.`);
  }
  return value.trim();
}

function identifier(value, name) {
  const result = text(value, name, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) throw new TypeError(`${name} has an invalid identifier.`);
  return result;
}

function symbolValue(value) {
  if (typeof value !== 'string' || !/^[A-Z0-9][A-Z0-9._-]{0,24}$/.test(value)) throw new TypeError('symbol must be a valid uppercase instrument identifier.');
  return value;
}

function timeValue(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) {
    throw new TypeError(`${name} must be an ISO timestamp with an explicit timezone.`);
  }
  const milliseconds = Date.parse(value);
  const day = Date.parse(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds) || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new TypeError(`${name} must be a valid calendar timestamp.`);
  }
  return new Date(milliseconds).toISOString();
}

function sourceUrlValue(value) {
  if (value === undefined || value === null) return null;
  const supplied = text(value, 'sourceUrl', 2048);
  let url;
  try { url = new URL(supplied); } catch { throw new TypeError('sourceUrl must be an HTTPS source URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new TypeError('sourceUrl must use HTTPS without embedded credentials.');
  return url.href;
}

/**
 * Imported labels describe captured evidence; this function does not independently verify its truth.
 * `origin` identifies the underlying report/claim, shared by syndicated copies and later versions.
 */
export function validateIntelligence(records) {
  if (!Array.isArray(records) || records.length > 5000) throw new TypeError('Intelligence must be an array with at most 5000 records.');
  const ids = new Map();
  const versions = new Map();
  const normalized = records.map((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError(`Intelligence record ${index} must be an object.`);
    for (const key of Object.keys(record)) if (!FIELDS.has(key)) throw new TypeError(`Unknown intelligence field: ${key}`);
    const item = {
      id: identifier(record.id, 'id'),
      symbol: symbolValue(record.symbol),
      origin: text(record.origin, 'origin', 240),
      publishedAt: timeValue(record.publishedAt, 'publishedAt'),
      firstReceivedAt: timeValue(record.firstReceivedAt, 'firstReceivedAt'),
      analysisReadyAt: timeValue(record.analysisReadyAt, 'analysisReadyAt'),
      sourceKind: record.sourceKind,
      verificationStatus: record.verificationStatus,
      version: record.version,
      supersedes: record.supersedes === undefined || record.supersedes === null ? null : identifier(record.supersedes, 'supersedes'),
      content: text(record.content, 'content', 1200),
      eventAt: record.eventAt === undefined || record.eventAt === null ? null : timeValue(record.eventAt, 'eventAt'),
      sourceUrl: sourceUrlValue(record.sourceUrl),
    };
    if (ids.has(item.id)) throw new TypeError(`Duplicate intelligence ID: ${item.id}`);
    if (!SOURCE_KINDS.includes(item.sourceKind)) throw new TypeError(`Unsupported sourceKind: ${item.sourceKind}`);
    if (!VERIFICATION_STATUSES.includes(item.verificationStatus)) throw new TypeError(`Unsupported verificationStatus: ${item.verificationStatus}`);
    if (!Number.isSafeInteger(item.version) || item.version < 1) throw new TypeError('version must be a positive integer.');
    if (item.firstReceivedAt < item.publishedAt || item.analysisReadyAt < item.firstReceivedAt) {
      throw new RangeError('Intelligence times must satisfy publishedAt <= firstReceivedAt <= analysisReadyAt.');
    }
    if ((item.version === 1 && item.supersedes !== null) || (item.version > 1 && item.supersedes === null)) {
      throw new TypeError('Version 1 cannot supersede a record; later versions must link a superseded record.');
    }
    if (item.sourceKind === 'synthetic' && !item.symbol.startsWith('DEMO-')) throw new TypeError('Synthetic intelligence must use fictional DEMO symbols.');
    const key = JSON.stringify([item.symbol, item.origin, item.version]);
    if (versions.has(key) && versions.get(key) !== item.verificationStatus) {
      throw new TypeError('Copies of the same origin/version must agree on status; corrections need a new linked version.');
    }
    versions.set(key, item.verificationStatus);
    ids.set(item.id, item);
    return item;
  });

  const children = new Map();
  for (const item of normalized) {
    if (!item.supersedes) continue;
    const prior = ids.get(item.supersedes);
    if (!prior || originKey(prior) !== originKey(item) || item.version !== prior.version + 1) {
      throw new TypeError(`Record ${item.id} must supersede an existing prior version of the same symbol/origin.`);
    }
    if (item.publishedAt < prior.publishedAt || item.analysisReadyAt < prior.analysisReadyAt) {
      throw new RangeError(`Correction ${item.id} cannot precede the availability of the record it supersedes.`);
    }
    const key = JSON.stringify([item.symbol, item.origin, item.version]);
    const priorTarget = children.get(key);
    if (priorTarget && priorTarget !== item.supersedes) throw new TypeError('Copies of a correction must link the same superseded record.');
    children.set(key, item.supersedes);
  }
  return normalized.sort((left, right) => compareText(left.analysisReadyAt, right.analysisReadyAt) || compareText(left.id, right.id));
}

/**
 * Only captured versions usable by asOf are visible. Missing evidence is reported, not a blanket halt.
 * `requireVerified` / `mandatorySourceKinds` opt a strategy into mandatory context requirements.
 */
export function intelligenceContext({ records = [], symbol, asOf, maxAgeMinutes = 120, requireVerified = false, mandatorySourceKinds = [] } = {}) {
  const selectedSymbol = symbolValue(symbol);
  const decisionTime = timeValue(asOf, 'asOf');
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes < 0) throw new RangeError('maxAgeMinutes must be a finite nonnegative number.');
  if (typeof requireVerified !== 'boolean') throw new TypeError('requireVerified must be a boolean.');
  if (!Array.isArray(mandatorySourceKinds) || mandatorySourceKinds.some((kind) => !SOURCE_KINDS.includes(kind))) {
    throw new TypeError('mandatorySourceKinds must contain supported source kinds.');
  }
  const availableRecords = validateIntelligence(records).filter((record) => record.symbol === selectedSymbol && record.analysisReadyAt <= decisionTime);
  const groups = new Map();
  for (const record of availableRecords) {
    const list = groups.get(record.origin) ?? [];
    list.push(record);
    groups.set(record.origin, list);
  }
  const claims = [...groups.entries()].sort(([left], [right]) => compareText(left, right)).map(([origin, group]) => {
    const version = Math.max(...group.map((record) => record.version));
    const current = group.filter((record) => record.version === version).sort((left, right) =>
      SOURCE_PRIORITY[right.sourceKind] - SOURCE_PRIORITY[left.sourceKind]
      || compareText(left.analysisReadyAt, right.analysisReadyAt) || compareText(left.id, right.id));
    const record = current[0];
    // A repost with a newer displayed publication time cannot rejuvenate the underlying report.
    const publishedAt = current.map((item) => item.publishedAt).sort()[0];
    const ageMinutes = (Date.parse(decisionTime) - Date.parse(publishedAt)) / 60_000;
    const fresh = ageMinutes <= maxAgeMinutes;
    const verified = VERIFIED.has(record.verificationStatus);
    return {
      origin, symbol: selectedSymbol, recordId: record.id, recordIds: current.map((item) => item.id).sort(), version,
      status: record.verificationStatus, verificationStatus: record.verificationStatus,
      sourceKind: record.sourceKind, sourceKinds: [...new Set(current.map((item) => item.sourceKind))].sort(),
      content: record.content, eventAt: record.eventAt, publishedAt,
      firstReceivedAt: record.firstReceivedAt, analysisReadyAt: record.analysisReadyAt, sourceUrl: record.sourceUrl,
      ageMinutes, fresh, verified, usableForEntry: fresh && verified,
      supersededRecordIds: group.filter((item) => item.version < version).map((item) => item.id).sort(),
    };
  });
  const usable = claims.filter((claim) => claim.usableForEntry);
  const fresh = claims.filter((claim) => claim.fresh);
  const missingMandatoryKinds = [...new Set(mandatorySourceKinds)].filter((kind) => !usable.some((claim) => claim.sourceKinds.includes(kind)));
  const blockReasons = [];
  if (fresh.some((claim) => claim.status === 'disputed')) blockReasons.push('A fresh relevant claim is disputed; resolve the contradiction before new exposure.');
  if (fresh.length > 0 && usable.length === 0) blockReasons.push('Fresh captured evidence is only unverified, reported, disputed or retracted; it cannot justify an entry.');
  if (requireVerified && usable.length === 0) blockReasons.push('This strategy requires fresh verified captured evidence, which is missing or stale.');
  for (const kind of missingMandatoryKinds) blockReasons.push(`Mandatory ${kind} context is missing, stale or not verified.`);

  const limitations = [
    'Captured evidence only: no live retrieval or independent source verification is performed here.',
    'Verification labels describe imported metadata, not a calibrated probability of truth or profit.',
  ];
  if (!claims.length) limitations.push('No captured evidence is available for this symbol at the decision time; coverage is unknown.');
  if (availableRecords.some((record) => record.sourceKind === 'synthetic')) limitations.push('Fictional DEMO intelligence establishes software behavior, not market evidence.');
  if (claims.some((claim) => !claim.fresh)) limitations.push('Old claims remain visible for audit but cannot satisfy fresh-context requirements.');
  const evidence = usable.map((claim) => `${claim.recordId}: captured ${claim.status} evidence available since ${claim.analysisReadyAt}: ${claim.content}`);
  const counterEvidence = claims.filter((claim) => !claim.usableForEntry).map((claim) =>
    `${claim.recordId}: ${claim.status}${claim.fresh ? '' : ', stale'}; this claim cannot justify an entry: ${claim.content}`);
  const statusCounts = Object.fromEntries(VERIFICATION_STATUSES.map((status) => [status, claims.filter((claim) => claim.status === status).length]));
  return {
    asOf: decisionTime, symbol: selectedSymbol,
    availableRecords, records: availableRecords, claims,
    coverage: {
      availableRecordCount: availableRecords.length, originCount: claims.length,
      syndicatedCopyCount: claims.reduce((count, claim) => count + claim.recordIds.length - 1, 0),
      supersededRecordCount: claims.reduce((count, claim) => count + claim.supersededRecordIds.length, 0),
      freshVerifiedClaimCount: usable.length, staleClaimCount: claims.filter((claim) => !claim.fresh).length,
      latestAnalysisReadyAt: availableRecords.at(-1)?.analysisReadyAt ?? null,
      missingMandatoryKinds, statusCounts,
    },
    limitations, entryBlocked: blockReasons.length > 0, blockReasons, reasons: blockReasons, evidence, counterEvidence,
  };
}

/** Fictional, deterministic fixtures aligned to the supplied replay. Real symbols get no invented news. */
export function makeDemoIntelligence(dataset) {
  const rows = Array.isArray(dataset) ? dataset : dataset?.rows;
  if (!Array.isArray(rows)) throw new TypeError('Demo intelligence requires replay rows or a validated dataset with rows.');
  let lastTime = '';
  const timestamps = rows.map((row) => {
    const timestamp = timeValue(row?.timestamp, 'dataset timestamp');
    if (timestamp <= lastTime) throw new RangeError('Demo dataset timestamps must be strictly increasing.');
    lastTime = timestamp;
    return timestamp;
  });
  const symbols = new Set(Object.keys(rows[0]?.bars ?? {}));
  const records = [];
  const add = ({ id, symbol, origin, index, verificationStatus, content, version = 1, supersedes = null, receivedIndex = index + 1, readyIndex = receivedIndex + 1 }) => {
    if (!symbols.has(symbol) || readyIndex >= timestamps.length) return;
    if (supersedes && !records.some((record) => record.id === supersedes)) return;
    records.push({
      id, symbol, origin, publishedAt: timestamps[index], firstReceivedAt: timestamps[receivedIndex], analysisReadyAt: timestamps[readyIndex],
      eventAt: timestamps[index], sourceKind: 'synthetic', verificationStatus, version, supersedes, content,
    });
  };
  add({ id: 'demo-a-update-v1', symbol: 'DEMO-A', origin: 'fictional:demo-a:operating-update', index: 24,
    verificationStatus: 'primary-confirmed', content: 'Fictional issuer update: a scheduled operating review is complete. This supplies context, not a profit forecast.' });
  add({ id: 'demo-a-update-copy', symbol: 'DEMO-A', origin: 'fictional:demo-a:operating-update', index: 24, receivedIndex: 27, readyIndex: 28,
    verificationStatus: 'primary-confirmed', content: 'Fictional syndicated copy of the same operating-review announcement; not independent corroboration.' });
  add({ id: 'demo-a-update-v2', symbol: 'DEMO-A', origin: 'fictional:demo-a:operating-update', index: 60, version: 2, supersedes: 'demo-a-update-v1',
    verificationStatus: 'disputed', content: 'Fictional correction: the operating-review scope is disputed; the earlier conclusion is no longer reliable.' });
  add({ id: 'demo-b-rumor-v1', symbol: 'DEMO-B', origin: 'fictional:demo-b:transaction-rumor', index: 25,
    verificationStatus: 'unverified', content: 'Unverified fictional transaction rumor. No independent or primary evidence supports the allegation.' });
  add({ id: 'demo-b-rumor-copy', symbol: 'DEMO-B', origin: 'fictional:demo-b:transaction-rumor', index: 25, receivedIndex: 28, readyIndex: 29,
    verificationStatus: 'unverified', content: 'Fictional repost of the same transaction rumor; repetition adds no independent origin.' });
  add({ id: 'demo-b-rumor-v2', symbol: 'DEMO-B', origin: 'fictional:demo-b:transaction-rumor', index: 42, version: 2, supersedes: 'demo-b-rumor-v1',
    verificationStatus: 'retracted', content: 'Fictional retraction: the transaction allegation was withdrawn. Do not retain it as an active verified thesis.' });
  add({ id: 'demo-c-event-v1', symbol: 'DEMO-C', origin: 'fictional:demo-c:scheduled-event', index: 24,
    verificationStatus: 'primary-confirmed', content: 'Fictional scheduled company event completed with a published clarification; direction and trading usefulness remain unestablished.' });
  add({ id: 'demo-c-event-v2', symbol: 'DEMO-C', origin: 'fictional:demo-c:scheduled-event', index: 75, version: 2, supersedes: 'demo-c-event-v1',
    verificationStatus: 'primary-confirmed', content: 'Fictional update clarifies the same event. Compare the new information with the measured price reaction; do not assume it remains tradable.' });
  return validateIntelligence(records);
}
