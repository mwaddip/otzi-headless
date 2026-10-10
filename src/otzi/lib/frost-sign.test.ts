import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParticipantBinding } from './frost-sign';

test('participant binding allows one party per sender and one sender per party', () => {
  const b = new ParticipantBinding(p => p >= 0 && p < 5);
  assert.equal(b.bind(0, 2), 'ok');
  assert.equal(b.bind(0, 2), 'ok');
  assert.equal(b.bind(1, 4), 'ok');
  assert.equal(b.bind(1, 2), 'conflict');   // sender 1 claims party 2, bound to sender 0
  assert.equal(b.bind(2, 4), 'conflict');   // sender 2 claims party 4, bound to sender 1
  assert.equal(b.bind(0, 3), 'conflict');   // sender 0 switches party
  assert.equal(b.bind(3, 9), 'invalid');
  assert.equal(b.partyOf(1), 4);
});
