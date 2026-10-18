const $ = id => document.getElementById(id);
const state = { snapshot: null, busy: false, fetching: false, formDirty: false, formVersion: null, range: 'all', stopId: null, review: null, healthy: null, fingerprint: null, epoch: 0 };
const titles = {
  overview: ['Portfolio overview', 'Observe the strategy. Inspect every decision.'],
  strategies: ['Strategy workspace', 'Transparent candidates for a paper experiment.'],
  configuration: ['Configuration', 'Set the model, strategy and risk boundaries.'],
  journal: ['Decision journal', 'Evidence, counter-evidence and execution outcomes.'],
  reports: ['Daily reports', 'Paper results against buy-and-hold, after charges and fixed costs.'],
};
const money = value => Number.isFinite(value) ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: state.snapshot?.currency || 'INR', maximumFractionDigits: 2 }).format(value) : '—';
const percentage = (value, signed = false) => Number.isFinite(value) ? `${signed && value > 0 ? '+' : ''}${value.toFixed(2)}%` : '—';
const numeric = value => Number.isFinite(value) ? new Intl.NumberFormat('en-IN', { maximumFractionDigits: 4 }).format(value) : '—';
const date = (value, time = false) => {
  const parsed = new Date(value);
  return value && Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', ...(time ? { timeStyle: 'short' } : {}), timeZone: 'Asia/Kolkata' }).format(parsed) : '—';
};
const text = (id, value) => { $(id).textContent = value ?? '—'; };
const readable = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
function node(tag, className, content, attributes = {}) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (content !== undefined && content !== null) result.textContent = content;
  for (const [key, value] of Object.entries(attributes)) result.setAttribute(key, value);
  return result;
}
function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', `#i-${id}`); svg.append(use); return svg;
}
function replace(id, children) { $(id).replaceChildren(...children); }
function changeColor(element, value) {
  element.classList.toggle('positive', Number.isFinite(value) && value > 0);
  element.classList.toggle('negative', Number.isFinite(value) && value < 0);
}
function announce(message, error = false) {
  text('feedback', message); $('feedback').hidden = false; $('feedback').classList.toggle('error', error);
}
async function api(path, options = {}) {
  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 75000);
  try {
    response = await fetch(path, { cache: 'no-store', ...options, signal: controller.signal, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = typeof data?.error === 'string' ? data.error : data?.error?.message || data?.message;
      throw new Error(message || `The simulator returned HTTP ${response.status}. Please try again.`);
    }
    if (data === null) throw new Error('The simulator returned an unreadable response.');
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The request timed out. Check the simulator and try again.');
    if (error instanceof TypeError) throw new Error('Cannot reach the local simulator. Check that it is running, then reconnect.');
    throw error;
  } finally { clearTimeout(timeout); }
}
async function refresh({ report = false } = {}) {
  if (state.fetching || state.busy) return;
  state.fetching = true;
  const epoch = state.epoch;
  try {
    const snapshot = await api('/api/state');
    if (epoch !== state.epoch) return;
    applySnapshot(snapshot);
    if (report) announce('Connected to the local paper simulator.');
  } catch (error) {
    if (epoch !== state.epoch) return;
    $('connection-error').hidden = false; text('connection-message', error.message);
    text('run-status', 'Disconnected'); $('run-status').className = 'run-badge';
    text('last-updated', 'Connection lost · displayed values may be stale');
    updateControls(true);
  } finally { state.fetching = false; }
}
async function mutate(path, body, success, method = 'POST') {
  if (state.busy) return null;
  state.busy = true; state.epoch += 1; updateControls();
  try {
    const result = await api(path, { method, body: JSON.stringify(body) });
    if (result?.metrics && result?.settings) applySnapshot(result);
    if (success) announce(success);
    return result;
  } catch (error) { announce(error.message, true); throw error; }
  finally { state.busy = false; updateControls(); }
}
function applySnapshot(snapshot) {
  if (!['paper', 'prospective-paper'].includes(snapshot.mode) || !snapshot.settings || !snapshot.metrics) throw new Error('The server did not return a valid paper workspace.');
  const fingerprint = JSON.stringify(snapshot);
  const changed = fingerprint !== state.fingerprint;
  state.snapshot = snapshot; state.fingerprint = fingerprint; $('connection-error').hidden = true;
  $('workspace-content').setAttribute('aria-busy', 'false');
  if (changed) { renderOverview(); renderStrategies(); renderJournal(); renderConfiguration(); renderIntelligence(); renderExpert(); }
  updateControls();
  text('last-updated', `Updated ${new Intl.DateTimeFormat('en-IN', { timeStyle: 'medium' }).format(new Date())} · local simulator`);
}
function updateControls(disconnected = false) {
  const s = state.snapshot; const unavailable = !s || state.busy || disconnected || !$('connection-error').hidden;
  const ended = s?.status === 'complete' || s?.status === 'error-paused' || s?.mode === 'prospective-paper';
  const riskPaused = s?.status === 'risk-paused';
  $('start-button').disabled = unavailable || ended || riskPaused;
  $('step-button').disabled = unavailable || ended || s?.status === 'running';
  $('step-button').replaceChildren(icon('step'), document.createTextNode(riskPaused ? 'Advance protection' : 'Step once'));
  $('step-button').setAttribute('aria-label', riskPaused ? 'Advance one paper bar for protective exits only; no new exposure' : 'Advance one paper observation');
  $('protection-step-help').hidden = !riskPaused;
  $('reset-button').disabled = unavailable;
  $('save-settings').disabled = unavailable || !state.formDirty;
  $('review-button').disabled = unavailable || !s?.market?.length;
  $('confirm-reset').disabled = state.busy;
  $('confirm-stop').disabled = state.busy;
  $('import-button').disabled = unavailable || s?.status === 'running';
  $('intelligence-import-button').disabled = unavailable;
  $('settings-save-state').textContent = state.formDirty ? 'Unapplied changes' : 'All changes saved';
  document.querySelectorAll('[data-stop-id]').forEach(button => { button.disabled = unavailable; });
  if (s) {
    const running = s.status === 'running';
    $('start-button').replaceChildren(icon(running ? 'pause' : 'play'), document.createTextNode(running ? 'Pause replay' : 'Run simulation'));
    $('start-button').setAttribute('aria-label', running ? 'Pause paper replay' : 'Run paper simulation');
  }
}
const istDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(value));
function renderExpert() {
  const e = state.snapshot.expert;
  if (!e) { text('expert-status', 'The server did not report an expert book.'); return; }
  const book = e.book, runner = e.runner, theses = e.theses ?? {};
  const configured = state.snapshot.settings.expert?.enabled === true;
  text('expert-status', e.enabled ? 'Running: paper-only, decided by Claude.' : `Not running. ${configured ? 'Enabled in settings; starts at the next service restart.' : 'Disabled in settings.'}`);
  const day = book?.run?.timestamp ? istDay(book.run.timestamp) : null;
  const today = (book?.decisions ?? []).filter(d => day && istDay(d.timestamp) === day);
  const calls = today.filter(d => d.expert), suppressed = today.filter(d => d.outcome?.startsWith('Suppressed:'));
  const cost = calls.reduce((total, d) => total + (d.expert.costUsd ?? 0), 0);
  const parts = [`Today: ${calls.length} model calls, ${suppressed.length} suppressed, cost $${cost.toFixed(2)} (usage estimate; marginal cost is ₹0 under the subscription).`];
  if (runner) parts.push(`Research ${runner.researchDone ? 'done' : 'not yet run'} today, theses ${runner.thesesDone ? 'written' : 'not yet written'}, ${runner.coverageMissing.length ? `no coverage for ${runner.coverageMissing.join(', ')}` : 'coverage complete'}${runner.halted ? `. Halted: ${runner.halted}` : ''}.`);
  else parts.push('No live runner: research and theses run only during a live session.');
  if (e.error) parts.push(`Expert book could not be read: ${e.error}`);
  text('expert-summary', parts.join(' '));
  $('expert-limit').hidden = !runner?.limitUntil;
  if (runner?.limitUntil) text('expert-limit', `Claude usage limit reached; no model calls until ${date(runner.limitUntil, true)} IST.`);
  const lastTrigger = symbol => (book?.decisions ?? []).find(d => d.symbol === symbol && d.trigger)?.trigger ?? '—'; // decisions are newest first
  const symbols = [...new Set([...(book?.assets ?? []).map(a => a.symbol), ...Object.keys(theses)])];
  replace('expert-theses-body', symbols.length ? symbols.map(symbol => {
    const t = theses[symbol], row = node('tr');
    row.append(node('td', 'asset-name', symbol), node('td', '', t ? `${t.stance}${t.invalid ? ' (invalidated)' : ''}` : 'watch'), node('td', '', t ? date(t.expiresAt, true) : '—'),
      node('td', 'number', t?.invalidation ? `Below ${numeric(t.invalidation.priceBelow)}${t.invalidation.note ? `: ${t.invalidation.note}` : ''}` : '—'), node('td', '', lastTrigger(symbol)));
    return row;
  }) : [emptyRow(5, 'No universe symbols yet.')]);
  const positions = book?.positions ?? [];
  replace('expert-positions-body', positions.length ? positions.map(p => {
    const row = node('tr'), pnl = node('td', 'number', money(p.unrealizedPnl)); changeColor(pnl, p.unrealizedPnl);
    row.append(node('td', 'asset-name', p.symbol), node('td', 'number', numeric(p.quantity)), pairedCell(money(p.entryPrice), money(p.markPrice), 'number'), node('td', 'number', money(p.stopPrice)), pnl);
    return row;
  }) : [emptyRow(5, 'No open expert positions.')]);
}
function strategyName(id) { return state.snapshot?.strategies?.find(item => item.id === id)?.name || ({ auto: 'Automatic', none: 'No candidate', momentum: 'Trend follow', mean_reversion: 'Range reversion' }[id]) || id || '—'; }
function meter(id, current, limit) {
  const ratio = limit > 0 && Number.isFinite(current) ? Math.min(100, Math.max(0, current / limit * 100)) : 0;
  $(id).setAttribute('aria-valuenow', ratio.toFixed(1));
  $(id).setAttribute('aria-valuetext', `${percentage(current)} used; ${percentage(limit)} limit`);
  $(id).firstElementChild.style.width = `${ratio}%`;
}
function renderOverview() {
  const s = state.snapshot, m = s.metrics, r = s.settings.risk;
  const synthetic = s.dataSource === 'synthetic demo', live = s.mode === 'prospective-paper';
  text('data-source-label', s.dataSource); text('sidebar-source', live ? 'Live NSE prices, simulated fills.' : synthetic ? 'Synthetic prices.' : 'Imported history.');
  text('market-description', live ? 'Live NSE prices from Kite · closed bars only' : synthetic ? 'Fictional DEMO instruments · synthetic replay prices' : `Historical replay from ${s.dataSource}`);
  text('market-source', live ? 'LIVE PAPER' : synthetic ? 'SYNTHETIC DEMO' : 'IMPORTED REPLAY');
  text('run-status', s.status.replaceAll('-', ' ')); $('run-status').className = `run-badge ${s.status}`;
  text('simulation-time', `${date(s.run?.timestamp, true)} IST`); text('run-progress', `${numeric((s.run?.cursor ?? 0) + 1)} / ${numeric(s.run?.total)} observations`);
  text('equity-value', money(m.equity)); text('net-return', `${percentage(m.netReturnPct, true)} net return`); changeColor($('net-return'), m.netReturnPct);
  text('cash-value', money(m.cash)); text('realized-value', money(m.realizedPnl)); changeColor($('realized-value'), m.realizedPnl);
  text('unrealized-value', money(m.unrealizedPnl)); changeColor($('unrealized-value'), m.unrealizedPnl);
  text('trade-count', numeric(m.tradeCount)); text('fees-value', `Simulated fees ${money(m.fees)}`);
  text('exposure-value', percentage(m.exposurePct)); text('drawdown-value', percentage(m.maxDrawdownPct));
  text('exposure-limit', `Limit ${percentage(r.maxExposurePct)}`); text('drawdown-limit', `Pause threshold ${percentage(r.maxDrawdownPct)}`);
  meter('exposure-meter', m.exposurePct, r.maxExposurePct); meter('drawdown-meter', m.maxDrawdownPct, r.maxDrawdownPct);
  text('risk-per-trade', percentage(r.riskPerTradePct)); text('stop-take', `${percentage(r.stopLossPct)} / ${percentage(r.takeProfitPct)}`); text('active-strategy', strategyName(s.settings.strategy.mode));
  text('daily-loss-value', `${percentage(m.dailyLossPct)} / ${percentage(r.maxDailyLossPct)}`);
  $('daily-loss-value').title = `Replay session ${m.sessionDay || 'unavailable'} · ${m.sessionTimezone || 'Asia/Kolkata'}`;
  text('risk-note', s.lastError || 'Orders are checked against deterministic risk limits.');
  text('sidebar-config', `Configuration v${s.settings.version}`);
  text('position-count', s.positions?.length ?? 0); text('journal-count', s.decisions?.length ?? 0);
  renderChart(); renderPositions(); renderLatestDecision(); renderMarket();
}
function svgNode(tag, attributes, content) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes || {})) element.setAttribute(key, value);
  if (content !== undefined) element.textContent = content;
  return element;
}
function renderChart() {
  const s = state.snapshot;
  let rows = (s.equityHistory || []).filter(row => Number.isFinite(row.equity) && Number.isFinite(row.benchmarkEquity));
  if (state.range === 'recent') rows = rows.slice(-30);
  const initial = s.settings.simulation.startingCapital;
  const benchmarkReturn = s.metrics.benchmarkEquity / initial * 100 - 100;
  text('benchmark-return', `Full buy-and-hold ${percentage(benchmarkReturn, true)}`);
  const hasCapped = Number.isFinite(s.metrics.cappedBenchmarkEquity);
  $('capped-benchmark-return').hidden = !hasCapped;
  if (hasCapped) text('capped-benchmark-return', `Static capped reference ${money(s.metrics.cappedBenchmarkEquity)} · ${percentage(s.metrics.cappedBenchmarkEquity / initial * 100 - 100, true)}`);
  if (!rows.length) {
    replace('equity-chart', [node('div', 'chart-placeholder', 'No replay history yet. Step once to record the first observation.')]);
    replace('chart-data-body', [emptyRow(4, 'No recorded observations yet.')]);
    text('chart-summary', 'No recorded returns yet · prices and fills are simulated'); return;
  }
  const values = rows.flatMap(row => [row.equity, row.benchmarkEquity]);
  let low = Math.min(...values), high = Math.max(...values);
  const padding = Math.max((high - low) * .18, initial * .005, 1); low -= padding; high += padding;
  const width = 920, height = 310, left = 70, right = 10, top = 16, bottom = 35;
  const x = index => left + index / Math.max(1, rows.length - 1) * (width - left - right);
  const y = value => top + (high - value) / (high - low) * (height - top - bottom);
  const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-labelledby': 'chart-title chart-desc', preserveAspectRatio: 'none' });
  svg.append(svgNode('title', { id: 'chart-title' }, 'Paper portfolio equity and full buy-and-hold benchmark'), svgNode('desc', { id: 'chart-desc' }, `${rows.length} recorded observations, from ${date(rows[0].timestamp)} to ${date(rows.at(-1).timestamp)}. Portfolio ended at ${money(rows.at(-1).equity)}; full buy-and-hold benchmark at ${money(rows.at(-1).benchmarkEquity)}. The benchmark has different exposure and does not dynamically match strategy risk. Full values are available in the chart data table.`));
  for (let i = 0; i < 5; i++) {
    const value = high - (high - low) * i / 4, py = y(value);
    svg.append(svgNode('line', { x1: left, x2: width - right, y1: py, y2: py, stroke: '#2a3743', 'stroke-width': 1 }), svgNode('text', { x: left - 10, y: py + 4, fill: '#a3b1bc', 'font-size': 11, 'text-anchor': 'end', 'font-family': 'monospace' }, new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value)));
  }
  const points = key => rows.map((row, i) => `${x(i).toFixed(2)},${y(row[key]).toFixed(2)}`).join(' ');
  svg.append(svgNode('polygon', { points: `${x(0)},${height - bottom} ${points('equity')} ${x(rows.length - 1)},${height - bottom}`, fill: '#8fdbc2', 'fill-opacity': .045 }));
  svg.append(svgNode('polyline', { points: points('benchmarkEquity'), fill: 'none', stroke: '#93a5b8', 'stroke-width': 2, 'stroke-dasharray': '5 6', 'vector-effect': 'non-scaling-stroke' }));
  svg.append(svgNode('polyline', { points: points('equity'), fill: 'none', stroke: '#8fdbc2', 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
  svg.append(svgNode('circle', { cx: x(rows.length - 1), cy: y(rows.at(-1).equity), r: 4, fill: '#8fdbc2' }));
  for (const [index, anchor] of [[0, 'start'], [rows.length - 1, 'end']]) svg.append(svgNode('text', { x: x(index), y: height - 8, fill: '#a3b1bc', 'font-size': 11, 'text-anchor': anchor }, date(rows[index].timestamp)));
  replace('equity-chart', [svg]);
  replace('chart-data-body', rows.map(row => {
    const tr = node('tr'); tr.append(node('td', '', date(row.timestamp, true)), node('td', 'number', money(row.equity)), node('td', 'number', money(row.benchmarkEquity)), node('td', 'number', money(row.cappedBenchmarkEquity))); return tr;
  }));
  text('chart-summary', `${rows.length} recorded observations · includes simulated fees and slippage`);
}
function emptyRow(columns, content) { const tr = node('tr'); tr.append(node('td', 'empty-cell', content, { colspan: columns })); return tr; }
function pairedCell(primary, secondary, className = '') { const td = node('td', className); td.append(node('span', '', primary), node('span', 'cell-secondary', secondary)); return td; }
function renderPositions() {
  const positions = state.snapshot.positions || [];
  replace('positions-body', positions.length ? positions.map(p => {
    const row = node('tr');
    row.append(pairedCell(p.symbol, `Opened under v${p.configVersion}`, 'asset-name'), node('td', 'number', numeric(p.quantity)), pairedCell(money(p.entryPrice), money(p.markPrice), 'number'), pairedCell(money(p.stopPrice), money(p.takeProfitPrice), 'number'));
    const pnl = node('td', 'number', money(p.unrealizedPnl)); changeColor(pnl, p.unrealizedPnl); row.append(pnl);
    const action = node('td'), button = node('button', 'button button-subtle table-button', 'Tighten stop', { type: 'button', 'data-stop-id': p.id, 'aria-label': `Tighten protective stop for ${p.symbol}` });
    button.addEventListener('click', () => openStop(p.id)); action.append(button); row.append(action); return row;
  }) : [emptyRow(6, 'No open positions. Advance the replay to evaluate the next entry.')]);
}
function actionPill(action) { const normalized = String(action || 'hold').toLowerCase(); return node('span', `action-pill ${['buy', 'sell', 'hold'].includes(normalized) ? normalized : ''}`, action || 'HOLD'); }
function renderLatestDecision() {
  const d = state.snapshot.decisions?.[0];
  if (!d) { replace('latest-decision', [node('p', 'empty-state', 'No decisions yet. Step the replay to inspect the first set of candidates.')]); return; }
  const kicker = node('div', 'decision-kicker'); kicker.append(actionPill(d.action), node('span', '', strategyName(d.strategyId)));
  const link = node('a', 'text-link', 'Read the decision', { href: '#journal' }); link.append(icon('arrow'));
  replace('latest-decision', [kicker, node('h3', '', d.symbol), node('p', 'decision-reason', d.reason), node('div', 'decision-outcome', d.outcome), link]);
}
function renderMarket() {
  const market = state.snapshot.market || [];
  replace('market-watch', market.length ? market.map(asset => {
    const article = node('article', 'market-item'), top = node('div', 'market-top'), identity = node('div', 'market-symbol');
    const label = node('div'); label.append(node('strong', '', asset.symbol), node('span', '', asset.name)); identity.append(label);
    const change = node('span', 'market-change', percentage(asset.changePct, true)); changeColor(change, asset.changePct); top.append(identity, change);
    article.append(top, node('div', 'market-price', money(asset.price)), node('div', 'market-regime', `Measured regime: ${asset.regime || 'unavailable'}`)); return article;
  }) : [node('p', 'empty-state', 'No market instruments loaded.')]);
  const selected = $('review-symbol').value;
  if (market.map(item => item.symbol).join('|') !== Array.from($('review-symbol').options).slice(1).map(item => item.value).join('|')) {
    replace('review-symbol', [node('option', '', 'Choose symbol', { value: '' }), ...market.map(item => node('option', '', item.symbol, { value: item.symbol }))]);
    if (market.some(item => item.symbol === selected)) $('review-symbol').value = selected;
  }
}
function renderStrategies() {
  const s = state.snapshot, mode = s.settings.strategy.mode;
  text('strategy-mode-title', mode === 'auto' ? 'Automatic selection' : `Manual · ${strategyName(mode)}`);
  text('strategy-mode-description', mode === 'auto' ? 'Choose an enabled candidate from the measured regime. Uncertain evidence can result in no entry.' : 'Use the chosen candidate until you apply a different configuration. Risk checks remain active.');
  replace('strategy-list', (s.strategies || []).map(strategy => {
    const enabled = s.settings.strategy.enabled.includes(strategy.id), baseline = strategy.kind === 'baseline';
    const article = node('article', 'panel strategy-card');
    article.append(node('span', `strategy-tag ${enabled ? 'enabled' : ''}`, baseline ? 'COMPARISON BASELINE' : enabled ? 'ENABLED CANDIDATE' : 'DISABLED'), node('h3', '', strategy.name), node('p', '', strategy.description));
    const detail = node('div', 'strategy-detail'); detail.append(node('span', '', `Regime: ${strategy.regime || 'unspecified'}`), node('span', '', baseline ? 'Benchmark only' : 'Long only · unvalidated')); article.append(detail); return article;
  }));
}
function evidenceBlock(title, evidence) {
  const section = node('div'); section.append(node('h3', '', title));
  if (Array.isArray(evidence) && evidence.length) { const list = node('ul'); evidence.forEach(item => list.append(node('li', '', readable(item)))); section.append(list); }
  else section.append(node('p', '', 'No observations recorded.'));
  return section;
}
function renderJournal() {
  const filter = $('journal-filter').value;
  const decisions = state.snapshot.decisions || [];
  const visible = decisions.filter(d => filter === 'all' || (filter === 'blocked' ? /reject|blocked|limit|unavailable/i.test(`${d.outcome} ${d.reason}`) : String(d.action).toLowerCase() === filter));
  text('decision-total', `${visible.length} of ${decisions.length} entries`);
  const expanded = new Set(Array.from($('decision-list').querySelectorAll('details[open]')).map(item => item.dataset.id));
  replace('decision-list', visible.length ? visible.map(d => {
    const entry = node('details', 'panel journal-entry', null, { 'data-id': d.id }); if (expanded.has(d.id)) entry.open = true;
    const summary = node('summary'); summary.append(node('span', 'journal-time', date(d.timestamp, true)), node('span', 'journal-symbol', d.symbol), actionPill(d.action), node('span', 'journal-summary', d.reason));
    const body = node('div', 'journal-detail'); body.append(node('p', '', d.reason));
    if (d.modelSummary) body.append(node('p', 'decision-reason', d.modelSummary));
    const evidence = node('div', 'evidence-grid'); evidence.append(evidenceBlock('Evidence', d.evidence), evidenceBlock('Counter-evidence', d.counterEvidence)); body.append(evidence);
    body.append(node('div', 'journal-outcome', `Outcome: ${d.outcome || 'Not recorded'}`));
    const metadata = node('div', 'journal-metadata'); metadata.append(node('span', '', strategyName(d.strategyId)), node('span', '', `${d.provider || 'rules'} / ${d.model || 'deterministic rules'}`), node('span', '', `Configuration v${d.configVersion}`));
    if (d.executionTimestamp) metadata.append(node('span', '', `Execution bar ${date(d.executionTimestamp, true)}`)); body.append(metadata);
    if (d.inputSnapshot) { const input = node('details', 'input-snapshot'); input.append(node('summary', '', 'Inspect decision input'), node('pre', '', readable(d.inputSnapshot))); body.append(input); }
    entry.append(summary, body); return entry;
  }) : [node('p', 'empty-state', decisions.length ? 'No decisions match this filter.' : 'No decisions yet. Run or step the paper replay to create a journal.')]);
}
function formValue(name) { return $('settings-form').elements.namedItem(name); }
function kiteLabel(kite) {
  if (!kite?.configured) return 'Not configured';
  const { session, runner } = kite;
  if (session.state !== 'valid' || runner.state === 'login-needed') return 'Login needed';
  const time = value => new Date(value).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  const labels = {
    live: `Live · last tick ${runner.lastTickAt ? time(runner.lastTickAt) : '—'} · ${runner.barsToday} bars today`,
    disconnected: 'Disconnected, reconnecting', 'warming-up': 'Loading recent bars…', 'warmup-failed': 'Could not load recent bars; retrying',
    closed: 'Market closed for today', idle: 'Market closed (weekend or holiday)',
  };
  return `${labels[runner.state] ?? runner.state} · session valid until ${time(session.expiresAt)} IST`;
}
function renderConfiguration() {
  const s = state.snapshot, settings = s.settings;
  text('config-version', `VERSION ${settings.version}`);
  if (!state.formDirty) {
    formValue('provider').value = settings.model.provider; formValue('model').value = settings.model.model;
    for (const name of ['maxOutputTokens', 'timeoutMs', 'dailyCallLimit']) formValue(name).value = settings.model[name];
    formValue('strategyMode').value = settings.strategy.mode;
    document.querySelectorAll('input[name=enabled]').forEach(input => { input.checked = settings.strategy.enabled.includes(input.value); });
    for (const [name, value] of Object.entries(settings.risk)) if (formValue(name)) formValue(name).value = value;
    for (const [name, value] of Object.entries(settings.simulation)) if (formValue(name)) formValue(name).value = value;
    formValue('universe').value = settings.universe.join(', '); formValue('barMinutes').value = settings.barMinutes;
    const x = settings.expert;
    formValue('expertEnabled').checked = x.enabled; formValue('thesisModel').value = x.thesisModel; formValue('decisionModel').value = x.decisionModel; formValue('researchModel').value = x.researchModel;
    formValue('maxResearchPerSession').value = x.maxResearchPerSession; formValue('allowedDomains').value = x.allowedDomains.join('\n');
    state.formVersion = settings.version;
  }
  const started = s.run.cursor > 29 || s.trades.length > 0;
  $('capital-input').disabled = started;
  text('capital-hint', started ? 'Reset the paper run before changing starting capital.' : 'Editable before the replay advances past warmup.');
  text('usage-hint', `${s.modelUsage.callsToday} / ${s.modelUsage.limit} calls today · resets in UTC`);
  updateProviderHint();
  text('import-current', `Current source: ${s.dataSource}`);
  text('broker-description', s.kite?.configured ? 'Live NSE prices from Kite feed the paper ledger. Orders are simulated; nothing is sent to the broker.' : 'Kite is not configured. No broker credentials or real orders are used.');
  text('kite-state', kiteLabel(s.kite));
  $('kite-login').hidden = !s.kite?.configured || !['none', 'expired'].includes(s.kite.session?.state);
  replace('broker-requirements', (s.kite?.requirements || []).map(item => node('li', '', readable(item))));
  replace('configuration-history', (s.configHistory || []).slice().reverse().map(item => {
    const entry = node('div', 'history-entry'); entry.append(node('strong', '', `Version ${item.version}`), node('span', '', item.note || 'Configuration applied'), node('span', '', date(item.timestamp, true))); return entry;
  }));
}
function updateProviderHint() {
  const provider = $('provider-input').value, available = state.snapshot?.providerStatus?.[provider];
  $('model-input').disabled = provider === 'rules'; $('model-input').required = provider !== 'rules';
  const paidAllowed = (state.snapshot?.providerStatus?.paidCallsEnabled ?? state.snapshot?.modelUsage?.paidCallsEnabled) === true;
  text('provider-hint', provider === 'rules' ? 'Available locally · no API key or external request' : `${available ? 'Server API key available' : 'Server API key unavailable'} · ${paidAllowed ? 'paid calls allowed by server policy' : 'paid calls disabled by server policy'}`);
  text('paid-call-policy', paidAllowed ? 'Paid model calls are enabled by owner-configured server policy and the daily call limit. Reviews are advisory.' : 'Paid AI calls are disabled by server policy, even if a key is available. Local rules require no external request.');
  document.querySelectorAll('#provider-input option').forEach(option => { option.textContent = ({ rules: 'Local rule engine', openai: 'OpenAI', anthropic: 'Anthropic' })[option.value] + (option.value === 'rules' ? '' : state.snapshot?.providerStatus?.[option.value] ? ' · key available' : ' · key unavailable'); });
}
function renderIntelligence() {
  const intelligence = state.snapshot.intelligence;
  $('intelligence-panel').hidden = !intelligence;
  if (!intelligence) return;
  const contexts = intelligence.contexts ?? intelligence;
  const entries = Array.isArray(contexts) ? contexts.map((item, index) => [item.symbol || `Context ${index + 1}`, item]) : contexts && typeof contexts === 'object' ? Object.entries(contexts) : [['Context', contexts]];
  const title = node('p', 'intelligence-policy', `${intelligence.mode || 'Captured evidence'} · ${intelligence.networkConnected ? 'Network state reported by server' : 'No live news connection'}`);
  replace('intelligence-content', [title, ...entries.map(([name, context]) => {
    const article = node('article', 'intelligence-context');
    const heading = node('div', 'panel-heading'); heading.append(node('h3', '', name), node('span', 'strategy-tag', context.entryBlocked ? 'ENTRY BLOCKED' : 'CAPTURED CONTEXT'));
    article.append(heading, node('p', 'decision-reason', `Replay as of ${date(context.asOf, true)}. ${Array.isArray(context.records) ? context.records.length : context.availableRecords ?? '—'} captured records available.`));
    if (context.coverage) {
      const c = context.coverage;
      const coverageText = typeof c === 'object' ? `${c.originCount ?? 0} independent origins; ${c.freshVerifiedClaimCount ?? 0} fresh verified claims; ${c.staleClaimCount ?? 0} stale claims; ${c.syndicatedCopyCount ?? 0} syndicated copies.` : readable(c);
      article.append(node('p', 'decision-reason', `Coverage: ${coverageText}`));
    }
    for (const reason of context.blockReasons || []) article.append(node('p', 'intelligence-blocked', readable(reason)));
    const claims = Array.isArray(context.claims) ? context.claims : [];
    for (const claim of claims) {
      const block = node('div', 'captured-claim');
      if (typeof claim === 'string') block.append(node('p', '', claim));
      else {
        block.append(node('p', '', claim.content || claim.claim || claim.statement || claim.text || claim.summary || 'No claim content supplied.'));
        const age = Number.isFinite(claim.ageMinutes) ? `${numeric(claim.ageMinutes)} minutes old` : 'Age unavailable';
        block.append(node('small', 'claim-status', `${claim.status || claim.verificationStatus || 'Status unavailable'} · ${claim.fresh === true ? 'Fresh' : claim.fresh === false ? 'Stale' : 'Freshness unavailable'} · ${age}`));
        const source = claim.source || claim.sourceName || claim.sourceUrl || claim.url;
        block.append(node('small', '', `Origin: ${claim.origin || 'Not supplied'}${claim.sourceKind ? ` · ${claim.sourceKind}` : ''}`));
        if (source) block.append(node('small', '', `Source: ${readable(source)}`));
        if (claim.publishedAt) block.append(node('small', '', `Published ${date(claim.publishedAt, true)}${claim.analysisReadyAt ? ` · available for analysis ${date(claim.analysisReadyAt, true)}` : ''}`));
      }
      article.append(block);
    }
    if (context.evidence || context.counterEvidence) {
      const evidence = node('div', 'evidence-grid'); evidence.append(evidenceBlock('Evidence', context.evidence), evidenceBlock('Counter-evidence', context.counterEvidence)); article.append(evidence);
    }
    const limits = Array.isArray(context.limitations) ? context.limitations : context.limitations ? [context.limitations] : [];
    limits.forEach(item => article.append(node('p', 'decision-reason', `Limitation: ${readable(item)}`)));
    const detail = node('details', 'input-snapshot'); detail.append(node('summary', '', 'Inspect captured records and inputs'), node('pre', '', readable(context))); article.append(detail); return article;
  })]);
}
function openStop(id) {
  const position = state.snapshot.positions.find(item => item.id === id);
  if (!position) { announce('That position is no longer open. Refresh and try again.', true); return; }
  state.stopId = id; text('stop-title', `Tighten ${position.symbol} stop`);
  text('stop-description', `Current stop ${money(position.stopPrice)} · current mark ${money(position.markPrice)}. The existing profit target stays unchanged.`);
  const minimum = Math.ceil(position.stopPrice * 100) / 100, maximum = (Math.ceil(position.markPrice * 100) - 1) / 100;
  $('stop-input').min = minimum; $('stop-input').max = maximum; $('stop-input').value = minimum.toFixed(2);
  text('stop-hint', `Enter at least ${money(minimum)} and less than the current mark. The server checks the latest price before applying.`);
  $('stop-error').hidden = true; $('stop-dialog').showModal();
}
async function renderReports() {
  let reports;
  try { reports = await api('/api/reports'); } catch (error) { replace('reports-body', [node('tr', '', node('td', 'empty-cell', error.message))]); return; }
  text('reports-count', `${reports.length} days`);
  // Expert columns appear only once an expert report exists, so the Phase 1 table is unchanged until then.
  const two = reports.some(row => row.expert);
  const head = document.querySelector('#reports-body').closest('table').querySelector('thead tr');
  head.querySelectorAll('[data-expert-column]').forEach(cell => cell.remove());
  if (two) for (const label of ['Expert net', 'Buy-and-hold net', 'Model cost (USD, est.)']) head.append(node('th', '', label, { scope: 'col', 'data-expert-column': '' }));
  const columns = two ? 10 : 7;
  if (!reports.length) { replace('reports-body', [emptyRow(7, 'No daily report yet. One is written after each live session closes.')]); $('reports-expert-note').hidden = true; return; }
  replace('reports-body', [...reports].reverse().map(({ rules: r, expert: e }) => {
    const row = node('tr', '');
    for (const value of [r.day, money(r.equity), money(r.benchmarkEquity), money(r.fixedCostsToDate), money(r.netAfterFixedCosts), String(r.tradesToday.length), r.dataQuality?.flagged ? 'Flagged' : 'OK']) row.append(node('td', '', value));
    if (two) for (const value of [e ? money(e.netAfterFixedCosts) : '—', e ? money(r.netAfterFixedCosts + r.benchmarkEquity - r.equity) : '—', Number.isFinite(e?.expert?.costUsd) ? `$${e.expert.costUsd.toFixed(2)}` : '—']) row.append(node('td', '', value));
    return row;
  }));
  const cost = reports.reduce((total, row) => total + (row.expert?.expert?.costUsd ?? 0), 0);
  text('reports-expert-note', `Expert book: model cost across these days is about $${cost.toFixed(2)} (estimate). Under the Claude subscription the marginal cost is ₹0; the figure shows usage, not spend.`);
  $('reports-expert-note').hidden = !two;
}
function navigate() {
  const requested = location.hash.slice(1), view = Object.hasOwn(titles, requested) ? requested : 'overview';
  for (const id of Object.keys(titles)) $('view-' + id).hidden = id !== view;
  document.querySelectorAll('[data-view]').forEach(link => { if (link.dataset.view === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  text('page-title', titles[view][0]); text('page-description', titles[view][1]);
  if (view === 'reports') void renderReports();
  $('sidebar').classList.remove('open'); $('menu-button').setAttribute('aria-expanded', 'false'); $('menu-button').setAttribute('aria-label', 'Open navigation');
}
$('menu-button').addEventListener('click', () => { const open = $('sidebar').classList.toggle('open'); $('menu-button').setAttribute('aria-expanded', open); $('menu-button').setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation'); });
window.addEventListener('hashchange', () => { navigate(); $('main').focus({ preventScroll: true }); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('sidebar').classList.remove('open'); $('menu-button').setAttribute('aria-expanded', 'false'); } });
$('retry-button').addEventListener('click', () => refresh({ report: true }));
$('start-button').addEventListener('click', async () => { const action = state.snapshot?.status === 'running' ? 'pause' : 'start'; try { await mutate('/api/control', { action }, action === 'start' ? 'Paper replay started.' : 'Paper replay paused.'); } catch {} });
$('step-button').addEventListener('click', async () => { try { await mutate('/api/control', { action: 'step', expectedCursor: state.snapshot.run.cursor, runId: state.snapshot.runId }, 'Advanced one paper observation.'); } catch { await refresh(); } });
$('reset-button').addEventListener('click', () => $('reset-dialog').showModal());
$('confirm-reset').addEventListener('click', async () => {
  try { await mutate('/api/control', { action: 'reset' }, 'Current run archived. Paper simulation reset.'); $('reset-dialog').close(); state.review = null; $('review-result').hidden = true; }
  catch {}
});
document.querySelectorAll('[data-chart-range]').forEach(button => button.addEventListener('click', () => {
  state.range = button.dataset.chartRange;
  document.querySelectorAll('[data-chart-range]').forEach(item => { item.classList.toggle('selected', item === button); item.setAttribute('aria-pressed', item === button); });
  if (state.snapshot) renderChart();
}));
$('settings-form').addEventListener('input', () => { state.formDirty = true; updateProviderHint(); updateControls(); });
$('settings-form').addEventListener('change', () => { state.formDirty = true; updateProviderHint(); updateControls(); });
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const enabled = Array.from(document.querySelectorAll('input[name=enabled]:checked')).map(input => input.value);
  const mode = formValue('strategyMode').value;
  if (!enabled.length) { announce('Enable at least one strategy.', true); document.querySelector('input[name=enabled]').focus(); return; }
  if (mode !== 'auto' && !enabled.includes(mode)) { announce('Enable the strategy selected for manual mode.', true); formValue('strategyMode').focus(); return; }
  const risk = Object.fromEntries(Object.keys(state.snapshot.settings.risk).filter(name => formValue(name)).map(name => [name, Number(formValue(name).value)]));
  if (risk.maxPositionPct > risk.maxExposurePct) { announce('Maximum position cannot exceed maximum exposure.', true); formValue('maxPositionPct').focus(); return; }
  const provider = formValue('provider').value;
  const payload = { model: { provider, model: provider === 'rules' ? '' : formValue('model').value.trim(), maxOutputTokens: Number(formValue('maxOutputTokens').value), timeoutMs: Number(formValue('timeoutMs').value), dailyCallLimit: Number(formValue('dailyCallLimit').value) }, strategy: { mode, enabled }, risk, simulation: { startingCapital: $('capital-input').disabled ? state.snapshot.settings.simulation.startingCapital : Number(formValue('startingCapital').value), slippageBps: Number(formValue('slippageBps').value), costSchedule: formValue('costSchedule').value, fixedCostsPerMonthInr: Number(formValue('fixedCostsPerMonthInr').value), spendCapPerMonthInr: Number(formValue('spendCapPerMonthInr').value) },
    universe: formValue('universe').value.split(',').map(symbol => symbol.trim().toUpperCase()).filter(Boolean), barMinutes: Number(formValue('barMinutes').value),
    expert: { enabled: formValue('expertEnabled').checked, thesisModel: formValue('thesisModel').value.trim(), decisionModel: formValue('decisionModel').value.trim(), researchModel: formValue('researchModel').value.trim(),
      maxResearchPerSession: Number(formValue('maxResearchPerSession').value), allowedDomains: formValue('allowedDomains').value.split(/[\s,]+/).map(domain => domain.toLowerCase()).filter(Boolean) } };
  try { const result = await mutate('/api/settings', payload, 'Configuration applied. Open-position stops and targets are retained.');
    if (result?.expertWarning) announce(`Applied to the rules book. Expert book not updated: ${result.expertWarning}`, true);
    if (result) { state.formDirty = false; renderConfiguration(); updateControls(); } } catch {}
});
$('cancel-stop').addEventListener('click', () => $('stop-dialog').close());
$('stop-form').addEventListener('submit', async event => {
  event.preventDefault(); $('stop-error').hidden = true;
  try { await mutate(`/api/positions/${encodeURIComponent(state.stopId)}/stop`, { stopPrice: Number($('stop-input').value) }, 'Protective stop tightened.', 'PUT'); $('stop-dialog').close(); }
  catch (error) { text('stop-error', error.message); $('stop-error').hidden = false; }
});
$('journal-filter').addEventListener('change', () => { if (state.snapshot) renderJournal(); });
$('review-form').addEventListener('submit', async event => {
  event.preventDefault(); const symbol = $('review-symbol').value;
  if (!symbol) return;
  try {
    const review = await mutate('/api/review', { symbol }); if (!review) return;
    state.review = review; const content = $('review-result');
    const title = node('h2', '', `${symbol} · advisory review`);
    const evidence = node('div', 'evidence-grid'); evidence.append(evidenceBlock('Evidence', review.evidence), evidenceBlock('Counter-evidence', review.counterEvidence));
    content.replaceChildren(title, node('p', 'decision-reason', review.summary || readable(review)), node('p', 'journal-outcome', `Candidate: ${strategyName(review.strategyId)}`), evidence, node('p', 'decision-reason', `Invalidation: ${review.invalidation || 'Not supplied'}`), node('div', 'journal-metadata', `${review.provider || state.snapshot.settings.model.provider} / ${review.model || 'local rules'} · no order submitted`));
    content.hidden = false; announce('Advisory review recorded. No order submitted.'); await refresh();
  } catch {}
});
$('import-file').addEventListener('change', async () => {
  const file = $('import-file').files[0]; if (!file) return;
  try { if (file.size > 2_000_000) throw new Error('Choose a CSV smaller than 2 MB.'); $('import-csv').value = await file.text(); $('import-name').value = file.name; $('import-error').hidden = true; }
  catch (error) { text('import-error', error.message); $('import-error').hidden = false; }
});
$('import-form').addEventListener('submit', async event => {
  event.preventDefault(); $('import-error').hidden = true;
  try {
    const csv = $('import-csv').value.trim(); if (!csv) throw new Error('Choose a CSV file or paste CSV content.');
    if (new TextEncoder().encode(csv).byteLength > 2_000_000) throw new Error('Keep the CSV below 2 MB.');
    await mutate('/api/import', { csv, name: $('import-name').value.trim() || 'Imported CSV' }, 'Dataset imported. Previous paper run archived; new replay is paused.');
    state.review = null; $('review-result').hidden = true;
  } catch (error) { text('import-error', error.message); $('import-error').hidden = false; }
});
$('intelligence-file').addEventListener('change', async () => {
  const file = $('intelligence-file').files[0]; if (!file) return;
  try { if (file.size > 2_000_000) throw new Error('Choose a JSON file smaller than 2 MB.'); $('intelligence-json').value = await file.text(); $('intelligence-error').hidden = true; }
  catch (error) { text('intelligence-error', error.message); $('intelligence-error').hidden = false; }
});
$('intelligence-import-form').addEventListener('submit', async event => {
  event.preventDefault(); $('intelligence-error').hidden = true;
  try {
    const raw = $('intelligence-json').value.trim(); if (!raw) throw new Error('Choose an evidence JSON file or paste its content.');
    if (new TextEncoder().encode(raw).byteLength > 2_000_000) throw new Error('Keep captured evidence below 2 MB.');
    let parsed; try { parsed = JSON.parse(raw); } catch { throw new Error('Evidence must be valid JSON.'); }
    const records = Array.isArray(parsed) ? parsed : parsed.records;
    if (!Array.isArray(records)) throw new Error('Provide a JSON array of captured records or an object with a records array.');
    await mutate('/api/intelligence/import', { records }, 'Captured evidence imported. Context change recorded in the audit.');
  } catch (error) { text('intelligence-error', error.message); $('intelligence-error').hidden = false; }
});
navigate();
api('/api/health').then(health => { state.healthy = health; }).catch(() => {});
refresh();
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 1500);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
