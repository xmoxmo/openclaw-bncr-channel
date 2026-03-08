import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBncrNativeCommand } from '../src/messaging/inbound/commands.ts';

test('parseBncrNativeCommand marks reset-family commands for plugin-side handling', () => {
  assert.deepEqual(parseBncrNativeCommand('/new'), {
    command: 'new',
    raw: '/new',
    body: '/new',
    route: 'reset',
  });
  assert.deepEqual(parseBncrNativeCommand(' /reset '), {
    command: 'reset',
    raw: '/reset',
    body: '/reset',
    route: 'reset',
  });
  assert.deepEqual(parseBncrNativeCommand('/clear'), {
    command: 'clear',
    raw: '/clear',
    body: '/new',
    route: 'reset',
  });
});

test('parseBncrNativeCommand marks all other slash commands for fallback-to-chat handling', () => {
  assert.deepEqual(parseBncrNativeCommand('/help'), {
    command: 'help',
    raw: '/help',
    body: '/help',
    route: 'generic',
  });
  assert.deepEqual(parseBncrNativeCommand('/status'), {
    command: 'status',
    raw: '/status',
    body: '/status',
    route: 'generic',
  });
  assert.deepEqual(parseBncrNativeCommand('/model xmo/gpt-5.4'), {
    command: 'model',
    raw: '/model xmo/gpt-5.4',
    body: '/model xmo/gpt-5.4',
    route: 'generic',
  });
  assert.deepEqual(parseBncrNativeCommand('/reasoning on'), {
    command: 'reasoning',
    raw: '/reasoning on',
    body: '/reasoning on',
    route: 'generic',
  });
});

test('parseBncrNativeCommand ignores non-slash text', () => {
  assert.equal(parseBncrNativeCommand('help'), null);
  assert.equal(parseBncrNativeCommand('new'), null);
  assert.equal(parseBncrNativeCommand('hello /new'), null);
});
