import test from 'node:test';
import assert from 'node:assert/strict';
import { charges, perShareRate, COST_SCHEDULES } from '../src/costs.mjs';

const Z = 'zerodha-cnc-2026-10';

test('schedules are none and zerodha-cnc-2026-10', () => assert.deepEqual(COST_SCHEDULES, ['none', Z]));
test('none schedule charges nothing', () => assert.equal(charges({ schedule: 'none', side: 'BUY', price: 1000, quantity: 1, dpApplies: false }).total, 0));
test('buy of one ₹1000 share', () => {
  const c = charges({ schedule: Z, side: 'BUY', price: 1000, quantity: 1, dpApplies: false });
  assert.equal(c.stt, 1); assert.equal(c.stamp, 0.15); assert.equal(c.exchange, 0.03); assert.equal(c.dp, 0);
  assert.ok(Math.abs(c.total - 1.19) < 0.01, `total ${c.total}`);
});
test('sell of one ₹1000 share with DP', () => {
  const c = charges({ schedule: Z, side: 'SELL', price: 1000, quantity: 1, dpApplies: true });
  assert.equal(c.stt, 1); assert.equal(c.stamp, 0); assert.equal(c.dp, 15.34);
  assert.ok(Math.abs(c.total - 16.37) < 0.01, `total ${c.total}`);
});
test('second sell of same scrip same day: caller passes dpApplies false', () => assert.equal(charges({ schedule: Z, side: 'SELL', price: 1000, quantity: 1, dpApplies: false }).dp, 0));
test('charges scale with quantity except DP', () => {
  const c = charges({ schedule: Z, side: 'SELL', price: 1000, quantity: 10, dpApplies: true });
  assert.equal(c.stt, 10); assert.equal(c.dp, 15.34);
});
test('per-share rates', () => {
  assert.ok(perShareRate(Z, 'BUY') > 0.00115 && perShareRate(Z, 'BUY') < 0.0012, String(perShareRate(Z, 'BUY')));
  assert.ok(perShareRate(Z, 'SELL') > 0.00100 && perShareRate(Z, 'SELL') < 0.00105, String(perShareRate(Z, 'SELL')));
  assert.equal(perShareRate('none', 'SELL'), 0);
});
test('unknown schedule or side throws', () => {
  assert.throws(() => charges({ schedule: 'x', side: 'BUY', price: 1, quantity: 1, dpApplies: false }), /schedule/);
  assert.throws(() => charges({ schedule: Z, side: 'HOLD', price: 1, quantity: 1, dpApplies: false }), /side/);
});
