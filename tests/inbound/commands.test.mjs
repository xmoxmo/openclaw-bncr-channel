import assert from 'node:assert/strict';
import test from 'node:test';

import { parseBncrNativeCommand } from '../../src/messaging/inbound/commands.ts';
import { resolveBncrNativeVerboseCommand } from '../../src/messaging/inbound/native-command.ts';

test('parseBncrNativeCommand treats all slash commands as tool-chain candidates, with help remapped only', () => {
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
    body: '/clear',
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
  assert.deepEqual(parseBncrNativeCommand('/verbose on'), {
    command: 'verbose',
    raw: '/verbose on',
    body: '/verbose on',
  });
});

test('parseBncrNativeCommand ignores non-slash text', () => {
  assert.equal(parseBncrNativeCommand('help'), null);
  assert.equal(parseBncrNativeCommand('new'), null);
  assert.equal(parseBncrNativeCommand('hello /new'), null);
});

test('resolveBncrNativeVerboseCommand resolves supported verbose levels', () => {
  assert.deepEqual(resolveBncrNativeVerboseCommand(parseBncrNativeCommand('/verbose on')), {
    handled: true,
    verboseLevel: 'on',
    text: 'Verbose logging enabled.',
  });
  assert.deepEqual(resolveBncrNativeVerboseCommand(parseBncrNativeCommand('/verbose off')), {
    handled: true,
    verboseLevel: 'off',
    text: 'Verbose logging disabled.',
  });
  assert.deepEqual(resolveBncrNativeVerboseCommand(parseBncrNativeCommand('/verbose full')), {
    handled: true,
    verboseLevel: 'full',
    text: 'Verbose logging set to full.',
  });
});

test('resolveBncrNativeVerboseCommand treats status and empty verbose as unchanged', () => {
  assert.deepEqual(resolveBncrNativeVerboseCommand(parseBncrNativeCommand('/verbose status')), {
    handled: true,
    text: 'Current verbose level is unchanged.',
  });
  assert.deepEqual(resolveBncrNativeVerboseCommand(parseBncrNativeCommand('/verbose')), {
    handled: true,
    text: 'Current verbose level is unchanged.',
  });
});

test('resolveBncrNativeVerboseCommand handles unknown verbose levels and non-verbose commands', () => {
  assert.deepEqual(resolveBncrNativeVerboseCommand(parseBncrNativeCommand('/verbose loud')), {
    handled: true,
    text: 'Unrecognized verbose level "loud". Valid levels: off, on, full.',
  });
  assert.equal(resolveBncrNativeVerboseCommand(parseBncrNativeCommand('/new')), null);
});
