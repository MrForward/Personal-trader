import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { Store } from './store.mjs';
import { TradingEngine } from './engine.mjs';
import { reviewMarket } from './models.mjs';
import { intelligenceContext, makeDemoIntelligence, validateIntelligence } from './intelligence.mjs';
import { redact } from './secrets.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const loopbackNames = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const MAX_BODY = 4 * 1024 * 1024;

function publicError(error) {
  return redact(error?.message || 'The requested operation failed.').slice(0, 1000);
}

async function jsonBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new Error('Send an application/json body.');
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) throw new Error('Request exceeds the 4 MB limit.');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Request body must be valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be a JSON object.');
  return value;
}

export function createApplication({
  dbPath = resolve(projectRoot, 'data/trading-lab.sqlite'),
  host = '127.0.0.1', port = 3000, autoStepMs = 1000,
  allowPaidModelCalls = false, reviewer = reviewMarket,
} = {}) {
  if (!loopbackNames.has(host)) throw new Error('The personal dashboard must bind to loopback. Use an SSH tunnel for remote access.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid listening port.');
  const store = new Store(dbPath);
  let engine;
  let fixtureDataset;
  let fixtureRecords = [];
  const intelligenceProvider = ({ symbol, asOf }) => {
    if (!engine) return { symbol, asOf, records: [], claims: [], entryBlocked: false, limitations: ['Initializing captured context.'] };
    if (engine.state.dataset !== fixtureDataset) {
      fixtureDataset = engine.state.dataset;
      fixtureRecords = engine.state.dataSource === 'synthetic demo' ? makeDemoIntelligence(fixtureDataset) : [];
    }
    return intelligenceContext({ records: engine.state.intelligenceRecords ?? fixtureRecords, symbol, asOf });
  };
  engine = new TradingEngine(store, {
    allowPaidCalls: allowPaidModelCalls,
    intelligenceProvider,
    reviewer: async input => {
      if (input.model.provider !== 'rules' && !allowPaidModelCalls) {
        throw new Error('Paid model calls are disabled. Agree a budget, configure server-side credentials and explicitly enable TRADING_LAB_ALLOW_PAID_MODEL_CALLS.');
      }
      return reviewer(input);
    },
  });
  const snapshot = () => {
    const value = engine.snapshot();
    value.providerStatus.paidCallsEnabled = allowPaidModelCalls;
    value.intelligence ??= {
      mode: 'captured fixtures / imported evidence', networkConnected: false,
      contexts: value.market.map(asset => intelligenceProvider({ symbol: asset.symbol, asOf: value.run.timestamp })),
    };
    return value;
  };
  // One writer: requests and replay ticks cannot race settings, state or the cursor.
  let queue = Promise.resolve();
  const serial = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  let closing = false;
  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    let url;
    try { url = new URL(req.url, `http://${req.headers.host}`); }
    catch { return json(res, 400, { error: 'Invalid request URL.' }); }
    if (!loopbackNames.has(url.hostname)) return json(res, 403, { error: 'Unrecognized host.' });
    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    if (isMutation) {
      const origin = req.headers.origin;
      if ((origin && origin !== url.origin) || req.headers['sec-fetch-site'] === 'cross-site') {
        return json(res, 403, { error: 'Cross-origin mutations are not permitted.' });
      }
    }
    if (closing) return json(res, 503, { error: 'The workspace is shutting down.' });
    try {
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [filename, contentType] = assets.get(url.pathname);
        const content = await readFile(resolve(projectRoot, 'public', filename));
        res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
        res.end(content); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, mode: 'paper', liveTrading: false, paidModelCallsEnabled: allowPaidModelCalls, networkNewsConnected: false });
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await serial(snapshot));
      if (req.method === 'GET' && url.pathname === '/api/audit') return json(res, 200, await serial(() => store.audit()));
      if (req.method === 'GET' && url.pathname === '/api/export') {
        const exported = await serial(() => engine.export());
        res.setHeader('content-disposition', 'attachment; filename="trading-lab-paper.json"');
        return json(res, 200, exported);
      }
      if (!isMutation) return json(res, 404, { error: 'Route not found.' });
      const body = await jsonBody(req);
      const result = await serial(async () => {
        if (req.method === 'POST' && url.pathname === '/api/control') {
          if (body.action === 'step') {
            if (!Number.isInteger(body.expectedCursor) || typeof body.runId !== 'string') throw new Error('Step requires the expectedCursor and runId from the latest state.');
            await engine.step({ expectedCursor: body.expectedCursor, runId: body.runId });
          } else engine.control(body.action);
        } else if (req.method === 'POST' && url.pathname === '/api/settings') engine.settings(body);
        else if (req.method === 'POST' && url.pathname === '/api/import') engine.importDataset(body);
        else if (req.method === 'POST' && url.pathname === '/api/intelligence/import') engine.setIntelligence(validateIntelligence(body.records));
        else if (req.method === 'POST' && url.pathname === '/api/review') return engine.review(body.symbol);
        else if (req.method === 'PUT' && /^\/api\/positions\/[^/]+\/stop$/.test(url.pathname)) {
          const id = decodeURIComponent(url.pathname.split('/')[3]);
          engine.tightenStop(id, body);
        } else { const error = new Error('Route not found.'); error.status = 404; throw error; }
        return snapshot();
      });
      json(res, 200, result);
    } catch (error) {
      const message = publicError(error);
      const status = error.status || (/busy|stale|cursor|run has changed/i.test(message) ? 409 : 400);
      json(res, status, { error: message });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  let tickQueued = false;
  const interval = autoStepMs > 0 ? setInterval(() => {
    if (closing || tickQueued || engine.state.status !== 'running') return;
    tickQueued = true;
    void serial(async () => {
      if (engine.state.status !== 'running') return;
      try { await engine.step({ expectedCursor: engine.state.cursor, runId: engine.state.runId }); }
      catch (error) {
        if (engine.state.status === 'running') engine.control('pause');
        process.stderr.write(`Paper replay stopped: ${publicError(error)}\n`);
      }
    }).finally(() => { tickQueued = false; });
  }, autoStepMs) : null;
  interval?.unref();
  return {
    server, engine, store,
    listen: () => new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolveListen(server.address()); });
    }),
    async close() {
      if (closing) return;
      closing = true;
      if (interval) clearInterval(interval);
      if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
      await queue;
      store.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApplication({
    dbPath: process.env.TRADING_LAB_DB_PATH ? resolve(process.env.TRADING_LAB_DB_PATH) : undefined,
    host: process.env.TRADING_LAB_HOST || '127.0.0.1',
    port: Number(process.env.TRADING_LAB_PORT || 3000),
    allowPaidModelCalls: process.env.TRADING_LAB_ALLOW_PAID_MODEL_CALLS === '1',
  });
  const address = await app.listen();
  process.stdout.write(`Trading Lab paper workspace: http://${address.address}:${address.port}\n`);
  process.stdout.write('Simulated orders only; captured intelligence, no live news or broker connection.\n');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
