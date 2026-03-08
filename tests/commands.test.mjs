import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBncrNativeCommand } from '../src/messaging/inbound/commands.ts';

test('parseBncrNativeCommand matches first-batch commands', () => {
  assert.deepEqual(parseBncrNativeCommand('/new'), { command: 'new', raw: '/new', body: '/new' });
  assert.deepEqual(parseBncrNativeCommand(' /reset '), { command: 'reset', raw: '/reset', body: '/reset' });
  assert.deepEqual(parseBncrNativeCommand('/clear'), { command: 'clear', raw: '/clear', body: '/new' });
  assert.deepEqual(parseBncrNativeCommand('/help'), { command: 'help', raw: '/help', body: '/help' });
  assert.deepEqual(parseBncrNativeCommand('/commands'), { command: 'commands', raw: '/commands', body: '/commands' });
  assert.deepEqual(parseBncrNativeCommand('/status'), { command: 'status', raw: '/status', body: '/status' });
  assert.deepEqual(parseBncrNativeCommand('/usage full'), { command: 'usage', raw: '/usage full', body: '/usage full' });
  assert.deepEqual(parseBncrNativeCommand('/session idle 60'), { command: 'session', raw: '/session idle 60', body: '/session idle 60' });
  assert.deepEqual(parseBncrNativeCommand('/whoami'), { command: 'whoami', raw: '/whoami', body: '/whoami' });
  assert.deepEqual(parseBncrNativeCommand('/model xmo/gpt-5.4'), { command: 'model', raw: '/model xmo/gpt-5.4', body: '/model xmo/gpt-5.4' });
  assert.deepEqual(parseBncrNativeCommand('/models openai'), { command: 'models', raw: '/models openai', body: '/models openai' });
  assert.deepEqual(parseBncrNativeCommand('/compact keep todos'), { command: 'compact', raw: '/compact keep todos', body: '/compact keep todos' });
  assert.deepEqual(parseBncrNativeCommand('/stop'), { command: 'stop', raw: '/stop', body: '/stop' });
  assert.deepEqual(parseBncrNativeCommand('/reasoning on'), { command: 'reasoning', raw: '/reasoning on', body: '/reasoning on' });
  assert.deepEqual(parseBncrNativeCommand('/verbose off'), { command: 'verbose', raw: '/verbose off', body: '/verbose off' });
  assert.deepEqual(parseBncrNativeCommand('/think high'), { command: 'think', raw: '/think high', body: '/think high' });
  assert.deepEqual(parseBncrNativeCommand('/elevated ask'), { command: 'elevated', raw: '/elevated ask', body: '/elevated ask' });
});

test('parseBncrNativeCommand ignores unsupported or malformed text', () => {
  assert.equal(parseBncrNativeCommand('new'), null);
  assert.equal(parseBncrNativeCommand('/task hello'), null);
  assert.equal(parseBncrNativeCommand('hello /new'), null);
  assert.equal(parseBncrNativeCommand('/bash ls'), null);
  assert.equal(parseBncrNativeCommand('/exec pwd'), null);
});
