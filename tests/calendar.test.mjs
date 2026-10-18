import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionFor, HOLIDAYS_2026 } from '../src/calendar.mjs';

const T = iso => Date.parse(iso);

test('a regular Tuesday opens 09:15 and closes 15:30 IST', () => {
  assert.deepEqual(sessionFor(T('2026-10-27T05:00:00Z')), { day: '2026-10-27', openMs: T('2026-10-27T03:45:00Z'), closeMs: T('2026-10-27T10:00:00Z') });
});
test('weekends have no session', () => {
  assert.equal(sessionFor(T('2026-10-24T05:00:00Z')), null);
  assert.equal(sessionFor(T('2026-10-25T05:00:00Z')), null);
});
test('listed holidays have no session', () => {
  assert.equal(HOLIDAYS_2026.length, 16);
  for (const day of HOLIDAYS_2026) assert.equal(sessionFor(T(`${day}T05:00:00+05:30`)), null, day);
});
test('early morning IST maps to the IST day, not the previous UTC day', () => {
  // 02:00 IST on Wednesday 28 Oct is 20:30 UTC on Tuesday 27 Oct.
  assert.equal(sessionFor(T('2026-10-27T20:30:00Z')).day, '2026-10-28');
});
test('a non-finite time throws', () => assert.throws(() => sessionFor(NaN), /time/));
