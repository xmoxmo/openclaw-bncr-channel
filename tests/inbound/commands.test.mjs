import assert from 'node:assert/strict';
import test from 'node:test';

import { parseBncrNativeCommand } from '../../src/messaging/inbound/commands.ts';
import {
  resolveBncrNativeHelpCommand,
  resolveBncrNativeVerboseCommand,
  resolveBncrNativeWhoamiCommand,
} from '../../src/messaging/inbound/native-command.ts';
import {
  executeSceneAdminCommand,
  parseSceneAdminCommand,
} from '../../src/messaging/inbound/scene-admin.ts';

test('parseBncrNativeCommand only recognizes bncr builtin /bncr subcommands, with help remapped only', () => {
  assert.deepEqual(parseBncrNativeCommand('/bncr'), {
    command: 'help',
    raw: '/bncr',
    body: '/commands',
    argsText: '',
  });
  assert.deepEqual(parseBncrNativeCommand('/bncr help'), {
    command: 'help',
    raw: '/bncr help',
    body: '/commands',
    argsText: '',
  });
  assert.deepEqual(parseBncrNativeCommand('/bncr@AixmoClaw_bot help'), {
    command: 'help',
    raw: '/bncr@AixmoClaw_bot help',
    body: '/commands',
    argsText: '',
  });
  assert.deepEqual(parseBncrNativeCommand('/bncr whoami'), {
    command: 'whoami',
    raw: '/bncr whoami',
    body: '/whoami',
    argsText: '',
  });
  assert.deepEqual(parseBncrNativeCommand('/whoami'), {
    command: 'whoami',
    raw: '/whoami',
    body: '/whoami',
    argsText: '',
  });
  assert.equal(parseBncrNativeCommand('/whoami', { allowBareWhoami: false }), null);
  assert.deepEqual(parseBncrNativeCommand('/bncr verbose on'), {
    command: 'verbose',
    raw: '/bncr verbose on',
    body: '/verbose on',
    argsText: 'on',
  });
});

test('parseBncrNativeCommand ignores non-slash text', () => {
  assert.equal(parseBncrNativeCommand('help'), null);
  assert.equal(parseBncrNativeCommand('/help'), null);
  assert.equal(parseBncrNativeCommand('/status'), null);
  assert.equal(parseBncrNativeCommand('/whoami@AixmoClaw_bot'), null);
  assert.equal(parseBncrNativeCommand('/bncrstatus'), null);
  assert.equal(parseBncrNativeCommand('/bncr@'), null);
  assert.equal(parseBncrNativeCommand('/bncr status'), null);
  assert.equal(parseBncrNativeCommand('hello /bncr help'), null);
});

test('resolveBncrNativeHelpCommand returns builtin bncr help text', () => {
  const helpText = resolveBncrNativeHelpCommand(parseBncrNativeCommand('/bncr help')).text;
  assert.match(helpText, /🦞 Bncr command usage/);
  assert.match(helpText, /\/bncr whoami/);
  assert.match(helpText, /\/bncr verbose on\|off\|full/);
  assert.match(helpText, /\/bncr allow \[<platform>:<groupId>\]/);
  assert.match(helpText, /\/bncr deny \[<platform>:<groupId>\]/);
  assert.match(helpText, /\/bncr bind <agentId> \[<platform>:<groupId>\]/);
  assert.match(helpText, /\/bncr mode help/);
  assert.match(helpText, /\/bncr mode <admin\|mention\|hybrid\|all> \[<platform>:<groupId>\]/);
  assert.match(helpText, /\/bncr revoke \[<platform>:<groupId>\]/);
  assert.match(helpText, /\/bncr list pending/);
  assert.match(helpText, /\/bncr list scenes/);
  assert.doesNotMatch(helpText, /💬 Group reply modes/);
  assert.doesNotMatch(helpText, /\/status/);
  assert.doesNotMatch(helpText, /\/whoami/);
  assert.equal(resolveBncrNativeHelpCommand(parseBncrNativeCommand('/bncr verbose')), null);
});

test('resolveBncrNativeWhoamiCommand returns user and scene identity without bridge details', () => {
  const whoami = resolveBncrNativeWhoamiCommand({
    command: parseBncrNativeCommand('/bncr whoami'),
    platform: 'tgBot',
    groupId: '-1001',
    groupName: 'wind_system',
    userId: '10001',
    userName: 'xmo',
    isGroup: true,
    isAdmin: false,
  });
  assert.match(whoami.text, /🧭 Bncr Identity/);
  assert.match(whoami.text, /Platform: tgBot/);
  assert.match(whoami.text, /User: xmo \(10001\)/);
  assert.match(whoami.text, /Group: wind_system \(-1001\)/);
  assert.match(whoami.text, /Scene: tgBot:-1001/);
  assert.match(whoami.text, /Admin: false/);
  assert.doesNotMatch(whoami.text, /bridge/i);
  assert.doesNotMatch(whoami.text, /client/i);
  assert.equal(
    resolveBncrNativeWhoamiCommand({ command: parseBncrNativeCommand('/bncr help') }),
    null,
  );
});

test('resolveBncrNativeVerboseCommand resolves supported verbose levels', () => {
  assert.deepEqual(resolveBncrNativeVerboseCommand(parseBncrNativeCommand('/bncr verbose on')), {
    handled: true,
    verboseLevel: 'on',
    text: 'Verbose logging enabled.',
  });
  assert.deepEqual(resolveBncrNativeVerboseCommand(parseBncrNativeCommand('/bncr verbose off')), {
    handled: true,
    verboseLevel: 'off',
    text: 'Verbose logging disabled.',
  });
  assert.deepEqual(resolveBncrNativeVerboseCommand(parseBncrNativeCommand('/bncr verbose full')), {
    handled: true,
    verboseLevel: 'full',
    text: 'Verbose logging set to full.',
  });
});

test('resolveBncrNativeVerboseCommand treats status and empty verbose as unchanged', () => {
  assert.deepEqual(
    resolveBncrNativeVerboseCommand(parseBncrNativeCommand('/bncr verbose status')),
    {
      handled: true,
      text: 'Current verbose level is unchanged.',
    },
  );
  assert.deepEqual(resolveBncrNativeVerboseCommand(parseBncrNativeCommand('/bncr verbose')), {
    handled: true,
    text: 'Current verbose level is unchanged.',
  });
});

test('resolveBncrNativeVerboseCommand handles unknown verbose levels and non-verbose commands', () => {
  assert.deepEqual(resolveBncrNativeVerboseCommand(parseBncrNativeCommand('/bncr verbose loud')), {
    handled: true,
    text: 'Unrecognized verbose level "loud". Valid levels: off, on, full.',
  });
  assert.equal(resolveBncrNativeVerboseCommand(parseBncrNativeCommand('/bncr help')), null);
});

test('parseSceneAdminCommand parses allow deny revoke bind mode and list commands', () => {
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr allow tgBot:10001')), {
    matched: true,
    valid: true,
    command: {
      kind: 'allow',
      sceneKey: 'tgBot:10001',
    },
  });
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr deny tgBot:10001')), {
    matched: true,
    valid: true,
    command: {
      kind: 'deny',
      sceneKey: 'tgBot:10001',
    },
  });
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr revoke tgBot:10001')), {
    matched: true,
    valid: true,
    command: {
      kind: 'revoke',
      sceneKey: 'tgBot:10001',
    },
  });
  assert.deepEqual(
    parseSceneAdminCommand(parseBncrNativeCommand('/bncr bind public-x tgBot:10001')),
    {
      matched: true,
      valid: true,
      command: {
        kind: 'bind',
        sceneKey: 'tgBot:10001',
        agentId: 'public-x',
      },
    },
  );
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr mode admin tgBot:-1001')), {
    matched: true,
    valid: true,
    command: {
      kind: 'mode',
      sceneKey: 'tgBot:-1001',
      mode: 'admin',
    },
  });
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr mode help')), {
    matched: true,
    valid: true,
    command: {
      kind: 'mode-help',
    },
  });
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr list pending')), {
    matched: true,
    valid: true,
    command: {
      kind: 'list',
      scope: 'pending',
    },
  });
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr list scenes')), {
    matched: true,
    valid: true,
    command: {
      kind: 'list',
      scope: 'scenes',
    },
  });
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr allow')), {
    matched: true,
    valid: true,
    command: {
      kind: 'allow',
      sceneKey: undefined,
    },
  });
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr bind tgBot:10001')), {
    matched: true,
    valid: true,
    command: {
      kind: 'bind',
      agentId: 'tgBot:10001',
    },
  });
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr mode tgBot:-1001 nope')), {
    matched: true,
    valid: false,
    text: 'Usage: /bncr mode | /bncr mode <admin|mention|hybrid|all> [<sceneKey>]',
  });
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr list nope')), {
    matched: true,
    valid: false,
    text: 'Usage: /bncr list <pending|scenes>',
  });
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr help')), {
    matched: false,
  });
});

test('executeSceneAdminCommand requires admin and mutates scene registry deterministically', () => {
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'pending',
        platform: 'tgBot',
        userId: '10001',
        userName: 'xmo',
        lastSeenAt: 1,
      },
    ],
  ]);
  const parsed = {
    isAdmin: true,
    userId: '1',
  };

  assert.deepEqual(
    executeSceneAdminCommand({
      parsed: { ...parsed, isAdmin: false },
      command: { kind: 'allow', sceneKey: 'tgBot:10001' },
      sceneRegistry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 2,
    }),
    { ok: false, text: 'Admin permission required.' },
  );

  assert.deepEqual(
    executeSceneAdminCommand({
      parsed,
      command: { kind: 'allow', sceneKey: 'tgBot:10001' },
      sceneRegistry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 2,
    }),
    { ok: true, text: 'Allowed scene tgBot:10001.' },
  );
  assert.deepEqual(sceneRegistry.get('tgBot:10001'), {
    sceneKey: 'tgBot:10001',
    kind: 'direct',
    status: 'allowed',
    platform: 'tgBot',
    userId: '10001',
    userName: 'xmo',
    agentId: 'main',
    lastSeenAt: 2,
  });

  assert.deepEqual(
    executeSceneAdminCommand({
      parsed,
      command: { kind: 'bind', sceneKey: 'tgBot:10001', agentId: 'public-x' },
      sceneRegistry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 3,
    }),
    { ok: true, text: 'Bound tgBot:10001 to agent public-x.' },
  );
  assert.equal(sceneRegistry.get('tgBot:10001')?.agentId, 'public-x');

  assert.deepEqual(
    executeSceneAdminCommand({
      parsed,
      command: { kind: 'revoke', sceneKey: 'tgBot:10001' },
      sceneRegistry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 4,
    }),
    { ok: true, text: 'Revoked scene tgBot:10001.' },
  );
  assert.equal(sceneRegistry.has('tgBot:10001'), false);
});
