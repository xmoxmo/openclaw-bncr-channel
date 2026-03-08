import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBncrNativeCommand } from '../src/messaging/inbound/commands.ts';

test('parseBncrNativeCommand treats all slash commands as tool-chain candidates', () => {
  assert.deepEqual(parseBncrNativeCommand('/new'), {
    command: 'new',
    raw: '/new',
    body: '/new',
  });
  assert.deepEqual(parseBncrNativeCommand(' /reset '), {
    command: 'reset',
    raw: '/reset',
    body: '/reset',
  });
  assert.deepEqual(parseBncrNativeCommand('/clear'), {
    command: 'clear',
    raw: '/clear',
    body: '/new',
  });
  assert.deepEqual(parseBncrNativeCommand('/help'), {
    command: 'help',
    raw: '/help',
    body: '/commands',
  });
  assert.deepEqual(parseBncrNativeCommand('/whoami'), {
    command: 'whoami',
    raw: '/whoami',
    body: '/whoami',
  });
  assert.deepEqual(parseBncrNativeCommand('/model xmo/gpt-5.4'), {
    command: 'model',
    raw: '/model xmo/gpt-5.4',
    body: '/model xmo/gpt-5.4',
  });
});

test('parseBncrNativeCommand ignores non-slash text', () => {
  assert.equal(parseBncrNativeCommand('help'), null);
  assert.equal(parseBncrNativeCommand('new'), null);
  assert.equal(parseBncrNativeCommand('hello /new'), null);
});
