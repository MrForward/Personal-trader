import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { providerStatus, reviewMarket, validateModelConfig } from '../src/models.mjs';

const FAKE_OPENAI_KEY = 'test-openai-key-not-a-real-credential';
const FAKE_ANTHROPIC_KEY = 'test-anthropic-key-not-a-real-credential';
let previousKeys;
beforeEach(() => {
  previousKeys = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  process.env.OPENAI_API_KEY = FAKE_OPENAI_KEY;
  process.env.ANTHROPIC_API_KEY = FAKE_ANTHROPIC_KEY;
});
afterEach(() => {
  for (const [name, value] of Object.entries(previousKeys)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const config = (provider = 'openai', overrides = {}) => ({
  provider, model: provider === 'rules' ? '' : 'user-selected-model',
  maxOutputTokens: 700, timeoutMs: 1000, dailyCallLimit: 10, ...overrides,
});
const context = (overrides = {}) => ({
  symbol: 'DEMO', asOf: '2026-10-13T09:00:00Z', source: 'synthetic demo',
  features: { trend: 0.04 }, portfolio: { cash: 10000, equity: 10000, position: null },
  enabledStrategies: ['momentum', 'mean_reversion'], rulesChoice: 'momentum',
  candidates: [{ strategyId: 'momentum', action: 'buy', reason: 'Positive trend.', evidence: ['Trend is positive.'], counterEvidence: ['Synthetic data has no predictive claim.'] }],
  risk: { maxPositionFraction: 0.1 }, ...overrides,
});
const review = (overrides = {}) => ({
  strategyId: 'momentum', summary: 'The supplied momentum candidate is supported.',
  evidence: ['Positive trend in the supplied features.'], counterEvidence: ['The market is synthetic.'],
  invalidation: 'The trend reverses or the risk gate fails.', ...overrides,
});
const response = (body, options) => new Response(JSON.stringify(body), options);
const openaiBody = (value = review(), overrides = {}) => ({
  status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
  usage: { input_tokens: 100, output_tokens: 50 }, ...overrides,
});
const anthropicBody = (value = review(), overrides = {}) => ({
  stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(value) }],
  usage: { input_tokens: 100, output_tokens: 50 }, ...overrides,
});

test('provider status exposes booleans only', () => {
  assert.deepEqual(providerStatus(), { rules: true, openai: true, anthropic: true });
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  assert.deepEqual(providerStatus(), { rules: true, openai: false, anthropic: false });
});

test('rules advisory review respects captured-entry veto and retains contrary evidence', async () => {
  const result = await reviewMarket({ model: config('rules'), context: context({ intelligence: { entryBlocked: true, blockReasons: ['Only an unverified rumor is available.'], evidence: [], counterEvidence: [] } }) });
  assert.equal(result.strategyId, 'none');
  assert.match(result.counterEvidence.join(' '), /unverified rumor/);
  assert.equal(result.usage.inputTokens, 0);
});

test('configuration is sanitized and accepts user model IDs without an allowlist', () => {
  assert.deepEqual(validateModelConfig({ ...config(), model: ' custom/vendor-model:version ', apiKey: 'must-not-survive', baseUrl: 'https://evil.example' }), {
    ...config(), model: 'custom/vendor-model:version',
  });
  assert.equal(validateModelConfig(config('rules')).model, '');
  assert.deepEqual(validateModelConfig({}), { provider: 'rules', model: '', maxOutputTokens: 800, timeoutMs: 15000, dailyCallLimit: 20 });
});

test('configuration rejects unsupported providers, invalid IDs and out-of-range controls', () => {
  const invalid = [
    null, [], { provider: 'custom' }, config('openai', { model: '' }),
    config('anthropic', { model: 'https://other-provider.example/model' }),
    config('openai', { model: 'two models' }), config('openai', { model: 'x'.repeat(129) }),
    config('openai', { maxOutputTokens: 127 }), config('openai', { maxOutputTokens: 4001 }),
    config('openai', { timeoutMs: 999 }), config('openai', { timeoutMs: 60001 }),
    config('openai', { dailyCallLimit: -1 }), config('openai', { dailyCallLimit: 201 }),
    config('openai', { dailyCallLimit: 1.5 }), config('openai', { timeoutMs: '15000' }),
  ];
  for (const value of invalid) assert.throws(() => validateModelConfig(value));
  assert.equal(validateModelConfig(config('openai', { maxOutputTokens: 128, timeoutMs: 60000, dailyCallLimit: 0 })).dailyCallLimit, 0);
  assert.equal(validateModelConfig(config('openai', { maxOutputTokens: 4000, dailyCallLimit: 200 })).maxOutputTokens, 4000);
});

test('rules uses the supplied deterministic choice and never fetches', async () => {
  const result = await reviewMarket({ model: config('rules'), context: context(), fetchImpl: () => { throw new Error('must not fetch'); } });
  assert.equal(result.strategyId, 'momentum');
  assert.match(result.summary, /^Rules review \(no LLM\): Positive trend\./);
  assert.equal(result.provider, 'rules');
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(result.evidence, ['Trend is positive.']);
  const none = await reviewMarket({ model: config('rules'), context: context({ rulesChoice: 'none', enabledStrategies: [] }) });
  assert.equal(none.strategyId, 'none');
});

test('enabled strategy context is mandatory and rules cannot select a disabled strategy', async () => {
  await assert.rejects(reviewMarket({ model: config('rules'), context: {} }), /enabledStrategies/);
  await assert.rejects(reviewMarket({ model: config('rules'), context: context({ enabledStrategies: ['unknown'] }) }), /unsupported strategy/);
  await assert.rejects(reviewMarket({ model: config('rules'), context: context({ enabledStrategies: ['mean_reversion'] }) }), /disabled/);
});

test('OpenAI uses Responses strict JSON schema with only enabled strategies and a fixed URL', async () => {
  let calls = 0;
  const result = await reviewMarket({
    model: config(), context: context({ enabledStrategies: ['momentum'] }),
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.authorization, `Bearer ${FAKE_OPENAI_KEY}`);
      assert.ok(options.signal instanceof AbortSignal);
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'user-selected-model');
      assert.equal(body.max_output_tokens, 700);
      assert.equal(body.store, false);
      assert.equal(body.text.format.type, 'json_schema');
      assert.equal(body.text.format.strict, true);
      assert.equal(body.text.format.schema.additionalProperties, false);
      assert.deepEqual(body.text.format.schema.properties.strategyId.enum, ['none', 'momentum']);
      assert.deepEqual(body.text.format.schema.required, Object.keys(review()));
      assert.equal(options.body.includes(FAKE_OPENAI_KEY), false);
      assert.equal(Object.hasOwn(body, 'tools'), false);
      return response(openaiBody());
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { ...review(), provider: 'openai', model: 'user-selected-model', usage: { inputTokens: 100, outputTokens: 50 } });
});

test('Anthropic uses Messages JSON output format and reports cached input usage', async () => {
  const result = await reviewMarket({
    model: config('anthropic'), context: context(),
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      assert.equal(options.headers['x-api-key'], FAKE_ANTHROPIC_KEY);
      assert.equal(options.headers['anthropic-version'], '2023-06-01');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'user-selected-model');
      assert.equal(body.max_tokens, 700);
      assert.equal(body.output_config.format.type, 'json_schema');
      assert.equal(body.output_config.format.schema.additionalProperties, false);
      assert.deepEqual(body.output_config.format.schema.properties.strategyId.enum, ['none', 'momentum', 'mean_reversion']);
      assert.equal(Object.hasOwn(body, 'tools'), false);
      return response(anthropicBody(review(), { usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 30, cache_creation_input_tokens: 20 } }));
    },
  });
  assert.equal(result.provider, 'anthropic');
  assert.deepEqual(result.usage, { inputTokens: 150, outputTokens: 50 });
});

test('missing provider keys fail before a request', async () => {
  for (const [provider, key] of [['openai', 'OPENAI_API_KEY'], ['anthropic', 'ANTHROPIC_API_KEY']]) {
    delete process.env[key];
    await assert.rejects(reviewMarket({ model: config(provider), context: context(), fetchImpl: () => { throw new Error('must not fetch'); } }), new RegExp(`${key} is not configured`));
  }
});

test('both providers reject disabled strategies and malformed review schemas', async () => {
  const invalid = [
    review({ strategyId: 'mean_reversion' }), review({ strategyId: 'invented' }),
    { ...review(), quantity: 50 }, { summary: 'Missing fields.' }, review({ evidence: 'not an array' }),
    review({ summary: '' }), review({ counterEvidence: Array(9).fill('too many') }), review({ invalidation: 'x'.repeat(1001) }),
  ];
  for (const provider of ['openai', 'anthropic']) {
    for (const value of invalid) {
      await assert.rejects(reviewMarket({ model: config(provider), context: context({ enabledStrategies: ['momentum'] }), fetchImpl: async () => response(provider === 'openai' ? openaiBody(value) : anthropicBody(value)) }));
    }
  }
});

test('refusal and incomplete responses fail without a rules fallback', async () => {
  const cases = [
    ['openai', openaiBody(review(), { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }] }), /refused/],
    ['openai', openaiBody(review(), { status: 'incomplete' }), /not completed/],
    ['anthropic', anthropicBody(review(), { stop_reason: 'refusal' }), /refused/],
    ['anthropic', anthropicBody(review(), { stop_reason: 'max_tokens' }), /not completed/],
  ];
  for (const [provider, body, pattern] of cases) {
    await assert.rejects(reviewMarket({ model: config(provider), context: context(), fetchImpl: async () => response(body) }), pattern);
  }
});

test('malformed JSON and invalid token usage fail clearly', async () => {
  await assert.rejects(reviewMarket({ model: config(), context: context(), fetchImpl: async () => new Response('{broken') }), /malformed JSON/);
  await assert.rejects(reviewMarket({ model: config(), context: context(), fetchImpl: async () => response(openaiBody(review(), { output: [{ type: 'message', content: [{ type: 'output_text', text: '{broken' }] }] })) }), /malformed JSON/);
  await assert.rejects(reviewMarket({ model: config(), context: context(), fetchImpl: async () => response(openaiBody(review(), { usage: { input_tokens: -1, output_tokens: 50 } })) }), /invalid token usage/);
});

test('HTTP and network error messages never expose provider bodies or credentials', async () => {
  const check = (error) => {
    assert.equal(error.message.includes(FAKE_OPENAI_KEY), false);
    assert.equal(error.message.includes(FAKE_ANTHROPIC_KEY), false);
    assert.equal(error.cause, undefined);
    return true;
  };
  await assert.rejects(reviewMarket({ model: config(), context: context(), fetchImpl: async () => new Response(FAKE_OPENAI_KEY, { status: 401 }) }), (error) => { check(error); return /HTTP 401/.test(error.message); });
  await assert.rejects(reviewMarket({ model: config(), context: context(), fetchImpl: async () => { throw new Error(`Network error ${FAKE_OPENAI_KEY}`); } }), (error) => { check(error); return /connectivity/.test(error.message); });
});

test('provider output and context cannot expose configured secrets', async () => {
  await assert.rejects(reviewMarket({ model: config(), context: context(), fetchImpl: async () => response(openaiBody(review({ summary: `Leaked ${FAKE_OPENAI_KEY}` }))) }), /sensitive content/);
  await assert.rejects(reviewMarket({ model: config(), context: context({ accidentallyIncludedKey: FAKE_ANTHROPIC_KEY }), fetchImpl: () => { throw new Error('must not fetch'); } }), /sensitive content/);
});

test('timeout aborts stalled provider work and reports no secret', async () => {
  let aborted = false;
  await assert.rejects(reviewMarket({
    model: config(), context: context(),
    fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error(`Aborted ${FAKE_OPENAI_KEY}`)); }, { once: true });
    }),
  }), (error) => /timed out/.test(error.message) && !error.message.includes(FAKE_OPENAI_KEY));
  assert.equal(aborted, true);
});

test('timeout covers a response body that stalls after headers arrive', async () => {
  await assert.rejects(reviewMarket({
    model: config('anthropic'), context: context(),
    fetchImpl: async () => ({ ok: true, text: () => new Promise(() => {}) }),
  }), /timed out/);
});
