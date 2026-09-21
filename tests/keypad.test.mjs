// Run: node --test tests/keypad.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { push_digit, pop_digit, buffer_to_cents } from '../src/keypad.js';

test('buffer_to_cents: empty buffer is 0, digits read as raw cents', () => {
  assert.equal(buffer_to_cents(''), 0);
  assert.equal(buffer_to_cents('5'), 5);      // 0,05
  assert.equal(buffer_to_cents('1234'), 1234); // 12,34
});

test('push_digit: appends, drops a stray leading zero, caps length', () => {
  assert.equal(push_digit('', '5'), '5');
  assert.equal(push_digit('5', '0'), '50');
  assert.equal(push_digit('0', '5'), '5'); // leading zero dropped
  assert.equal(push_digit('12345678', '9'), '12345678'); // at MAX_DIGITS, ignored
});

test('pop_digit: removes the last digit, empty stays empty', () => {
  assert.equal(pop_digit('1234'), '123');
  assert.equal(pop_digit('1'), '');
  assert.equal(pop_digit(''), '');
});
