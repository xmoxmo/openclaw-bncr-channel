import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBncrNativeCommand } from '../src/messaging/inbound/commands.ts';

test('parseBncrNativeCommand matches help and reset-family commands', () => {
  assert.deepEqual(parseBncrNativeCommand('/help'), { command: 'help', raw: '/help', body: '/help' });
  assert.deepEqual(parseBncrNativeCommand('/new'), { command: 'new', raw: '/new', body: '/new' });
  assert.deepEqual(parseBncrNativeCommand(' /reset '), { command: 'reset', raw: '/reset', body: '/reset' });
  assert.deepEqual(parseBncrNativeCommand('/clear'), { command: 'clear', raw: '/clear', body: '/new' });
});

test('parseBncrNativeCommand ignores other slash commands', () => {
  assert.equal(parseBncrNativeCommand('/status'), null);
  assert.equal(parseBncrNativeCommand('/model xmo/gpt-5.4'), null);
  assert.equal(parseBncrNativeCommand('/reasoning on'), null);
});

test('parseBncrNativeCommand ignores unsupported or malformed text', () => {
  assert.equal(parseBncrNativeCommand('help'), null);
  assert.equal(parseBncrNativeCommand('new'), null);
  assert.equal(parseBncrNativeCommand('/task hello'), null);
  assert.equal(parseBncrNativeCommand('hello /new'), null);
  assert.equal(parseBncrNativeCommand('/bash ls'), null);
  assert.equal(parseBncrNativeCommand('/exec pwd'), null);
});
