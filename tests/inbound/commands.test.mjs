import assert from 'node:assert/strict';
import test from 'node:test';

import { parseBncrNativeCommand } from '../../src/messaging/inbound/commands.ts';
import {
  isBncrStopCommandText,
  isBncrWhitelistBareCommandText,
  parseBncrUnsupportedDirectCommand,
  resolveBncrNativeHelpCommand,
  resolveBncrNativeSessionResetCommand,
  resolveBncrNativeStatusCommand,
  resolveBncrNativeVerboseCommand,
  resolveBncrNativeWhoamiCommand,
} from '../../src/messaging/inbound/native-command.ts';
import {
  executeSceneAdminCommand,
  HISTORY_HELP_TEXT,
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
  assert.equal(parseBncrNativeCommand('/bncr@AixmoClaw_bot help'), null);
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
  assert.deepEqual(parseBncrNativeCommand('/status', { allowBareStatus: true }), {
    command: 'status',
    raw: '/status',
    body: '/status',
    argsText: '',
  });
  assert.deepEqual(parseBncrNativeCommand('/new', { allowBareSessionReset: true }), {
    command: 'new',
    raw: '/new',
    body: '/new',
    argsText: '',
  });
  assert.deepEqual(parseBncrNativeCommand('/reset', { allowBareSessionReset: true }), {
    command: 'reset',
    raw: '/reset',
    body: '/reset',
    argsText: '',
  });
  assert.equal(parseBncrNativeCommand('/whoami', { allowBareWhoami: false }), null);
  assert.equal(parseBncrNativeCommand('/status'), null);
  assert.equal(parseBncrNativeCommand('/new'), null);
  assert.equal(parseBncrNativeCommand('/reset'), null);
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
  assert.equal(parseBncrNativeCommand('/new'), null);
  assert.equal(parseBncrNativeCommand('/reset'), null);
  assert.equal(parseBncrNativeCommand('/whoami@AixmoClaw_bot'), null);
  assert.equal(parseBncrNativeCommand('/bncr@AixmoClaw_bot help'), null);
  assert.equal(parseBncrNativeCommand('/bncrstatus'), null);
  assert.equal(parseBncrNativeCommand('/bncr@'), null);
  assert.deepEqual(parseBncrNativeCommand('/bncr status'), {
    command: 'status',
    raw: '/bncr status',
    body: '/status',
    argsText: '',
  });
  assert.deepEqual(parseBncrNativeCommand('/bncr new'), {
    command: 'new',
    raw: '/bncr new',
    body: '/new',
    argsText: '',
  });
  assert.deepEqual(parseBncrNativeCommand('/bncr reset'), {
    command: 'reset',
    raw: '/bncr reset',
    body: '/reset',
    argsText: '',
  });
  assert.equal(parseBncrNativeCommand('hello /bncr help'), null);
});

test('parseBncrUnsupportedDirectCommand detects unsupported direct slash commands only outside allowed set', () => {
  assert.deepEqual(parseBncrUnsupportedDirectCommand('/model gpt-5'), {
    command: 'model',
    raw: '/model gpt-5',
  });
  assert.equal(parseBncrUnsupportedDirectCommand('/model@AixmoClaw_bot'), null);
  assert.deepEqual(parseBncrUnsupportedDirectCommand('/bncr verbose on'), {
    command: 'bncr verbose',
    raw: '/bncr verbose on',
  });
  assert.deepEqual(parseBncrUnsupportedDirectCommand('/bncr deny tgBot:10001'), {
    command: 'bncr deny',
    raw: '/bncr deny tgBot:10001',
  });
  assert.equal(parseBncrUnsupportedDirectCommand('/whoami'), null);
  assert.equal(parseBncrUnsupportedDirectCommand('/status'), null);
  assert.equal(parseBncrUnsupportedDirectCommand('/new'), null);
  assert.equal(parseBncrUnsupportedDirectCommand('/reset'), null);
  assert.equal(parseBncrUnsupportedDirectCommand('/bncr help'), null);
  assert.equal(parseBncrUnsupportedDirectCommand('/bncr status'), null);
  assert.equal(parseBncrUnsupportedDirectCommand('hello'), null);
});

test('isBncrStopCommandText only recognizes exact /stop', () => {
  assert.equal(isBncrStopCommandText('/stop'), true);
  assert.equal(isBncrStopCommandText('/STOP'), true);
  assert.equal(isBncrStopCommandText('/stop please'), false);
  assert.equal(isBncrStopCommandText('/stop@AixmoClaw_bot'), false);
  assert.equal(isBncrStopCommandText('/bncr stop'), false);
});

test('isBncrWhitelistBareCommandText does not strip @bot suffixes', () => {
  assert.equal(isBncrWhitelistBareCommandText('/whoami'), 'whoami');
  assert.equal(isBncrWhitelistBareCommandText('/whoami@AixmoClaw_bot'), null);
  assert.equal(isBncrWhitelistBareCommandText('/status@bot'), null);
  assert.equal(isBncrWhitelistBareCommandText('/model gpt-5'), 'model');
  assert.equal(isBncrWhitelistBareCommandText('/model@bot gpt-5'), null);
  assert.equal(isBncrWhitelistBareCommandText('/new'), 'new');
  assert.equal(isBncrWhitelistBareCommandText('/new@bot'), null);
  assert.equal(isBncrWhitelistBareCommandText('/stop'), 'stop');
  assert.equal(isBncrWhitelistBareCommandText('/stop@bot'), null);
  assert.equal(isBncrWhitelistBareCommandText('not a command'), null);
});

test('resolveBncrNativeHelpCommand returns full help for admin callers', () => {
  const helpText = resolveBncrNativeHelpCommand(parseBncrNativeCommand('/bncr help'), {
    isAdmin: true,
    peerKind: 'group',
  }).text;
  assert.match(helpText, /🦞 Bncr command usage/);
  assert.match(helpText, /\/bncr whoami/);
  assert.match(helpText, /\/bncr status/);
  assert.match(helpText, /\/bncr new/);
  assert.match(helpText, /\/bncr reset/);
  assert.match(helpText, /\/bncr verbose on\|off\|full/);
  assert.match(helpText, /\/bncr allow \[<SceneId>\]/);
  assert.match(helpText, /\/bncr mode <admin\|mention\|hybrid\|all\|clear> \[<SceneId>\]/);
  assert.match(helpText, /\/bncr history-limit \[<number>\|clear\] \[<SceneId>\]/);
  assert.match(helpText, /\/bncr download-media on\|off\|clear\|default on\|off/);
  assert.match(helpText, /📋 Conversation history/);
  assert.doesNotMatch(helpText, /📋 Group history/);
  assert.doesNotMatch(helpText, /💬 Group reply modes/);
});

test('resolveBncrNativeHelpCommand returns full management help for direct admin callers', () => {
  const helpText = resolveBncrNativeHelpCommand(parseBncrNativeCommand('/bncr help'), {
    isAdmin: true,
    peerKind: 'direct',
  }).text;
  assert.match(helpText, /\/bncr whoami/);
  assert.match(helpText, /\/bncr new/);
  assert.match(helpText, /\/bncr verbose on\|off\|full/);
  assert.match(helpText, /\/bncr allow \[<SceneId>\]/);
  assert.match(helpText, /\/bncr mode <admin\|mention\|hybrid\|all\|clear> \[<SceneId>\]/);
  assert.match(helpText, /📋 Conversation history/);
});

test('resolveBncrNativeHelpCommand returns direct non-admin help with self-service commands', () => {
  const helpText = resolveBncrNativeHelpCommand(parseBncrNativeCommand('/bncr help'), {
    isAdmin: false,
    peerKind: 'direct',
  }).text;
  assert.match(helpText, /🦞 Bncr command usage/);
  assert.match(helpText, /\/bncr whoami/);
  assert.match(helpText, /\/bncr status/);
  assert.match(helpText, /\/bncr new/);
  assert.match(helpText, /\/bncr reset/);
  assert.match(helpText, /\/bncr verbose on\|off\|full/);
  assert.match(helpText, /📋 Conversation history/);
  assert.match(helpText, /\/bncr history-help/);
  assert.match(helpText, /\/bncr download-media/);
  assert.doesNotMatch(helpText, /\/bncr allow \[<SceneId>\]/);
  assert.doesNotMatch(helpText, /\/bncr mode /);
  assert.doesNotMatch(helpText, /\/status/);
  assert.doesNotMatch(helpText, /\/whoami/);
});

test('resolveBncrNativeHelpCommand returns group non-admin help with only available builtins', () => {
  const helpText = resolveBncrNativeHelpCommand(parseBncrNativeCommand('/bncr help'), {
    isAdmin: false,
    peerKind: 'group',
  }).text;
  assert.match(helpText, /🦞 Bncr command usage/);
  assert.match(helpText, /\/bncr whoami/);
  assert.match(helpText, /\/bncr status/);
  assert.doesNotMatch(helpText, /\/bncr new/);
  assert.doesNotMatch(helpText, /\/bncr reset/);
  assert.doesNotMatch(helpText, /\/bncr verbose on\|off\|full/);
  assert.doesNotMatch(helpText, /\/bncr allow \[<SceneId>\]/);
  assert.doesNotMatch(helpText, /\/bncr mode /);
  assert.doesNotMatch(helpText, /📋 Conversation history/);
  assert.doesNotMatch(helpText, /🌐 Remote media/);
  assert.doesNotMatch(helpText, /\/status/);
  assert.doesNotMatch(helpText, /\/whoami/);
});

test('resolveBncrNativeHelpCommand rejects non-help commands', () => {
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

test('resolveBncrNativeStatusCommand returns scoped direct-session status for bncr-local bare status', () => {
  const status = resolveBncrNativeStatusCommand({
    command: parseBncrNativeCommand('/status', { allowBareStatus: true }),
    accountId: 'Primary',
    platform: 'tgBot',
    userId: '10001',
    userName: 'xmo',
    resolvedAgentId: 'public',
    sessionKey: 'agent:public:bncr:direct:7467426f743a3130303031',
  });
  assert.match(status.text, /🦞 Bncr Status/);
  assert.match(status.text, /Channel: bncr/);
  assert.match(status.text, /Account: Primary/);
  assert.match(status.text, /User: xmo \(10001\)/);
  assert.match(status.text, /Scene: tgBot:10001/);
  assert.match(status.text, /Agent: public/);
  assert.match(status.text, /SessionKey: agent:public:bncr:direct:7467426f743a3130303031/);
  assert.equal(
    resolveBncrNativeStatusCommand({
      command: parseBncrNativeCommand('/bncr whoami'),
      accountId: 'Primary',
      platform: 'tgBot',
      userId: '10001',
      resolvedAgentId: 'public',
      sessionKey: 'agent:public:bncr:direct:7467426f743a3130303031',
    }),
    null,
  );
});

test('resolveBncrNativeSessionResetCommand returns direct-session reset intents', () => {
  assert.deepEqual(
    resolveBncrNativeSessionResetCommand({
      command: parseBncrNativeCommand('/new', { allowBareSessionReset: true }),
      peerKind: 'direct',
    }),
    {
      handled: true,
      reason: 'new',
      text: '✅ New session started.',
    },
  );
  assert.deepEqual(
    resolveBncrNativeSessionResetCommand({
      command: parseBncrNativeCommand('/bncr reset'),
      peerKind: 'direct',
    }),
    {
      handled: true,
      reason: 'reset',
      text: '✅ Session reset.',
    },
  );
  assert.equal(
    resolveBncrNativeSessionResetCommand({
      command: parseBncrNativeCommand('/bncr whoami'),
      peerKind: 'direct',
    }),
    null,
  );
});

test('resolveBncrNativeSessionResetCommand returns group-session reset intents', () => {
  assert.deepEqual(
    resolveBncrNativeSessionResetCommand({
      command: parseBncrNativeCommand('/bncr new'),
      peerKind: 'group',
    }),
    {
      handled: true,
      reason: 'new',
      text: '✅ New session started.',
    },
  );
  assert.deepEqual(
    resolveBncrNativeSessionResetCommand({
      command: parseBncrNativeCommand('/bncr reset'),
      peerKind: 'group',
    }),
    {
      handled: true,
      reason: 'reset',
      text: '✅ Session reset.',
    },
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

test('resolveBncrNativeVerboseCommand reports current level for status and empty verbose', () => {
  // When no currentLevel is provided, it should show 'default'.
  assert.deepEqual(
    resolveBncrNativeVerboseCommand(parseBncrNativeCommand('/bncr verbose status')),
    {
      handled: true,
      text: 'Current verbose level: default',
    },
  );
  assert.deepEqual(resolveBncrNativeVerboseCommand(parseBncrNativeCommand('/bncr verbose')), {
    handled: true,
    text: 'Current verbose level: default',
  });
  // When a current level is provided, it should display that level.
  assert.deepEqual(
    resolveBncrNativeVerboseCommand(parseBncrNativeCommand('/bncr verbose status'), 'on'),
    {
      handled: true,
      text: 'Current verbose level: on',
    },
  );
  assert.deepEqual(
    resolveBncrNativeVerboseCommand(parseBncrNativeCommand('/bncr verbose'), 'off'),
    {
      handled: true,
      text: 'Current verbose level: off',
    },
  );
  assert.deepEqual(
    resolveBncrNativeVerboseCommand(parseBncrNativeCommand('/bncr verbose'), 'full'),
    {
      handled: true,
      text: 'Current verbose level: full',
    },
  );
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
  assert.deepEqual(
    parseSceneAdminCommand(parseBncrNativeCommand('/bncr list scenes public tgBot')),
    {
      matched: true,
      valid: true,
      command: {
        kind: 'list',
        scope: 'scenes',
        filters: ['public', 'tgbot'],
      },
    },
  );
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
    text: 'Usage: /bncr list <pending|scenes> [filters...]',
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

test('parseSceneAdminCommand parses history-limit and history-force commands', () => {
  // history-limit with 0 args → get
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr history-limit')), {
    matched: true,
    valid: true,
    command: { kind: 'history-limit-get' },
  });
  // history-limit with number → set
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr history-limit 100')), {
    matched: true,
    valid: true,
    command: { kind: 'history-limit-set', sceneKey: '', limit: 100 },
  });
  // history-limit with sceneKey → get for scene
  assert.deepEqual(
    parseSceneAdminCommand(parseBncrNativeCommand('/bncr history-limit tgBot:-1001')),
    {
      matched: true,
      valid: true,
      command: { kind: 'history-limit-get', sceneKey: 'tgBot:-1001' },
    },
  );
  // history-limit with number + sceneKey → set for scene
  assert.deepEqual(
    parseSceneAdminCommand(parseBncrNativeCommand('/bncr history-limit 200 tgBot:-1001')),
    {
      matched: true,
      valid: true,
      command: { kind: 'history-limit-set', sceneKey: 'tgBot:-1001', limit: 200 },
    },
  );
  // history-limit invalid → error
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr history-limit x y z')), {
    matched: true,
    valid: false,
    text: 'Usage: /bncr history-limit [<number>|clear] [<sceneKey>]',
  });

  // history-force with 0 args → get
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr history-force')), {
    matched: true,
    valid: true,
    command: { kind: 'history-force-get' },
  });
  // history-force on → set
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr history-force on')), {
    matched: true,
    valid: true,
    command: { kind: 'history-force-set', sceneKey: '', enabled: true },
  });
  // history-force off → set
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr history-force off')), {
    matched: true,
    valid: true,
    command: { kind: 'history-force-set', sceneKey: '', enabled: false },
  });
  // history-force off with sceneKey → set for scene
  assert.deepEqual(
    parseSceneAdminCommand(parseBncrNativeCommand('/bncr history-force off tgBot:-1001')),
    {
      matched: true,
      valid: true,
      command: { kind: 'history-force-set', sceneKey: 'tgBot:-1001', enabled: false },
    },
  );
  // history-force with sceneKey → get for scene
  assert.deepEqual(
    parseSceneAdminCommand(parseBncrNativeCommand('/bncr history-force tgBot:-1001')),
    {
      matched: true,
      valid: true,
      command: { kind: 'history-force-get', sceneKey: 'tgBot:-1001' },
    },
  );

  // history-help → help command
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr history-help')), {
    matched: true,
    valid: true,
    command: { kind: 'history-help' },
  });
});

test('executeSceneAdminCommand handles history commands', () => {
  const sceneRegistry = new Map([
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1001',
        agentId: 'public',
        groupReplyMode: 'admin',
        historyLimit: 50,
        historyForce: true,
        lastSeenAt: 1,
      },
    ],
  ]);
  const parsed = { isAdmin: true, peer: { kind: 'group' }, platform: 'tgBot', groupId: '-1001' };

  // history-help returns help text
  assert.deepEqual(
    executeSceneAdminCommand({
      parsed,
      command: { kind: 'history-help' },
      sceneRegistry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 2,
    }),
    { ok: true, text: HISTORY_HELP_TEXT },
  );
  assert.match(HISTORY_HELP_TEXT, /\/bncr history-limit \[<number>\|clear\]/);
  assert.match(HISTORY_HELP_TEXT, /\/bncr history-force on\|off\|clear/);

  // history-limit-get returns current value
  assert.deepEqual(
    executeSceneAdminCommand({
      parsed,
      command: { kind: 'history-limit-get', sceneKey: 'tgBot:-1001' },
      sceneRegistry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 2,
    }),
    { ok: true, text: 'Current tgBot:-1001 history limit is 50.' },
  );

  // history-limit-get for non-existent scene returns default
  assert.deepEqual(
    executeSceneAdminCommand({
      parsed,
      command: { kind: 'history-limit-get', sceneKey: 'tgBot:-9999' },
      sceneRegistry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 2,
    }),
    { ok: true, text: 'Default history limit is 50.' },
  );

  // history-limit-set with valid positive value
  assert.deepEqual(
    executeSceneAdminCommand({
      parsed,
      command: { kind: 'history-limit-set', sceneKey: 'tgBot:-1001', limit: 100 },
      sceneRegistry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 3,
    }),
    { ok: true, text: 'Set tgBot:-1001 history limit to 100.' },
  );
  assert.equal(sceneRegistry.get('tgBot:-1001').historyLimit, 100);

  // history-limit-set with hidden negative value
  assert.deepEqual(
    executeSceneAdminCommand({
      parsed,
      command: { kind: 'history-limit-set', sceneKey: 'tgBot:-1001', limit: -10 },
      sceneRegistry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 4,
    }),
    { ok: true, text: 'Set tgBot:-1001 history limit to 10.' },
  );
  assert.equal(sceneRegistry.get('tgBot:-1001').historyLimit, 10);

  // history-limit-set with the minimum accepted value
  assert.deepEqual(
    executeSceneAdminCommand({
      parsed,
      command: { kind: 'history-limit-set', sceneKey: 'tgBot:-1001', limit: 2 },
      sceneRegistry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 5,
    }),
    {
      ok: true,
      text: 'Set tgBot:-1001 history limit to 2.',
    },
  );
  assert.equal(sceneRegistry.get('tgBot:-1001').historyLimit, 2);

  // history-limit-set with negative too small (abs < 2) → error
  assert.deepEqual(
    executeSceneAdminCommand({
      parsed,
      command: { kind: 'history-limit-set', sceneKey: 'tgBot:-1001', limit: -1 },
      sceneRegistry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 6,
    }),
    {
      ok: false,
      text: 'Value too small, must be >= 2, or use negative number (abs >= 2) for hidden override.',
    },
  );

  // history-limit-set with hidden -2 stores the accepted minimum
  assert.deepEqual(
    executeSceneAdminCommand({
      parsed,
      command: { kind: 'history-limit-set', sceneKey: 'tgBot:-1001', limit: -2 },
      sceneRegistry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 7,
    }),
    { ok: true, text: 'Set tgBot:-1001 history limit to 2.' },
  );
  assert.equal(sceneRegistry.get('tgBot:-1001').historyLimit, 2);

  // history-limit-set with large positive value is capped
  assert.deepEqual(
    executeSceneAdminCommand({
      parsed,
      command: { kind: 'history-limit-set', sceneKey: 'tgBot:-1001', limit: 99999 },
      sceneRegistry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 8,
    }),
    { ok: true, text: 'Set tgBot:-1001 history limit to 10000.' },
  );
  assert.equal(sceneRegistry.get('tgBot:-1001').historyLimit, 10000);

  // history-force-get returns current value
  assert.deepEqual(
    executeSceneAdminCommand({
      parsed,
      command: { kind: 'history-force-get', sceneKey: 'tgBot:-1001' },
      sceneRegistry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 8,
    }),
    { ok: true, text: 'Current tgBot:-1001 history auto flush is on.' },
  );

  // history-force-set to off
  assert.deepEqual(
    executeSceneAdminCommand({
      parsed,
      command: { kind: 'history-force-set', sceneKey: 'tgBot:-1001', enabled: false },
      sceneRegistry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 9,
    }),
    { ok: true, text: 'Set tgBot:-1001 history auto flush to off.' },
  );
  assert.equal(sceneRegistry.get('tgBot:-1001').historyForce, false);

  // non-admin is rejected for history commands
  assert.deepEqual(
    executeSceneAdminCommand({
      parsed: { ...parsed, isAdmin: false },
      command: { kind: 'history-help' },
      sceneRegistry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 10,
    }),
    { ok: false, text: 'Admin permission required.' },
  );
});

test('executeSceneAdminCommand history shortcuts resolve the current private chat scene', () => {
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'allowed',
        platform: 'tgBot',
        userId: '10001',
        lastSeenAt: 1,
      },
    ],
  ]);
  const parsed = {
    isAdmin: true,
    peer: { kind: 'direct' },
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
  };

  assert.deepEqual(
    executeSceneAdminCommand({
      parsed,
      command: { kind: 'history-limit-get', sceneKey: '' },
      sceneRegistry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 2,
    }),
    { ok: true, text: 'Current tgBot:10001 history limit is 50.' },
  );

  assert.deepEqual(
    executeSceneAdminCommand({
      parsed,
      command: { kind: 'history-limit-set', sceneKey: '', limit: 100 },
      sceneRegistry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 3,
    }),
    { ok: true, text: 'Set tgBot:10001 history limit to 100.' },
  );
  assert.equal(sceneRegistry.get('tgBot:10001')?.historyLimit, 100);

  assert.deepEqual(
    executeSceneAdminCommand({
      parsed,
      command: { kind: 'history-force-set', sceneKey: '', enabled: false },
      sceneRegistry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 4,
    }),
    { ok: true, text: 'Set tgBot:10001 history auto flush to off.' },
  );
  assert.equal(sceneRegistry.get('tgBot:10001')?.historyForce, false);
});

test('parseSceneAdminCommand: mode clear', () => {
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr mode clear')), {
    matched: true,
    valid: true,
    command: { kind: 'mode', sceneKey: '', mode: 'clear' },
  });
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr mode clear tgBot:-1001')), {
    matched: true,
    valid: true,
    command: { kind: 'mode', sceneKey: 'tgBot:-1001', mode: 'clear' },
  });
});

test('parseSceneAdminCommand: history-limit clear', () => {
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr history-limit clear')), {
    matched: true,
    valid: true,
    command: { kind: 'history-limit-set', sceneKey: '', limit: 'clear' },
  });
  assert.deepEqual(
    parseSceneAdminCommand(parseBncrNativeCommand('/bncr history-limit clear tgBot:-1001')),
    {
      matched: true,
      valid: true,
      command: { kind: 'history-limit-set', sceneKey: 'tgBot:-1001', limit: 'clear' },
    },
  );
});

test('parseSceneAdminCommand: history-force clear', () => {
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr history-force clear')), {
    matched: true,
    valid: true,
    command: { kind: 'history-force-set', sceneKey: '', enabled: 'clear' },
  });
  assert.deepEqual(
    parseSceneAdminCommand(parseBncrNativeCommand('/bncr history-force clear tgBot:-1001')),
    {
      matched: true,
      valid: true,
      command: { kind: 'history-force-set', sceneKey: 'tgBot:-1001', enabled: 'clear' },
    },
  );
});

test('parseSceneAdminCommand: download-media on/off/clear/default', () => {
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr download-media on')), {
    matched: true,
    valid: true,
    command: { kind: 'download-media-set', sceneKey: '', enabled: true },
  });
  assert.deepEqual(
    parseSceneAdminCommand(parseBncrNativeCommand('/bncr download-media off tgBot:-1001')),
    {
      matched: true,
      valid: true,
      command: { kind: 'download-media-set', sceneKey: 'tgBot:-1001', enabled: false },
    },
  );
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr download-media clear')), {
    matched: true,
    valid: true,
    command: { kind: 'download-media-set', sceneKey: '', enabled: undefined },
  });
  assert.deepEqual(
    parseSceneAdminCommand(parseBncrNativeCommand('/bncr download-media default on')),
    {
      matched: true,
      valid: true,
      command: { kind: 'download-media-global-set', enabled: true },
    },
  );
  assert.deepEqual(parseSceneAdminCommand(parseBncrNativeCommand('/bncr download-media default')), {
    matched: true,
    valid: true,
    command: { kind: 'download-media-global-get' },
  });
});

test('executeSceneAdminCommand: mode clear removes groupReplyMode', () => {
  const sceneRegistry = new Map([
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1001',
        groupReplyMode: 'all',
        lastSeenAt: 1,
      },
    ],
  ]);
  const result = executeSceneAdminCommand({
    parsed: { isAdmin: true, userId: '1' },
    command: { kind: 'mode', sceneKey: 'tgBot:-1001', mode: 'clear' },
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 2,
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /Cleared/);
  const scene = sceneRegistry.get('tgBot:-1001');
  assert.equal(scene.groupReplyMode, undefined);
});

test('executeSceneAdminCommand: history-limit clear removes historyLimit', () => {
  const sceneRegistry = new Map([
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1001',
        historyLimit: 100,
        lastSeenAt: 1,
      },
    ],
  ]);
  const result = executeSceneAdminCommand({
    parsed: { isAdmin: true, userId: '1' },
    command: { kind: 'history-limit-set', sceneKey: 'tgBot:-1001', limit: 'clear' },
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 2,
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /Cleared/);
  const scene = sceneRegistry.get('tgBot:-1001');
  assert.equal(scene.historyLimit, undefined);
});

test('executeSceneAdminCommand: history-force clear removes historyForce', () => {
  const sceneRegistry = new Map([
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1001',
        historyForce: false,
        lastSeenAt: 1,
      },
    ],
  ]);
  const result = executeSceneAdminCommand({
    parsed: { isAdmin: true, userId: '1' },
    command: { kind: 'history-force-set', sceneKey: 'tgBot:-1001', enabled: 'clear' },
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 2,
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /Cleared/);
  const scene = sceneRegistry.get('tgBot:-1001');
  assert.equal(scene.historyForce, undefined);
});

test('executeSceneAdminCommand: download-media set/clear', () => {
  const sceneRegistry = new Map([
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1001',
        lastSeenAt: 1,
      },
    ],
  ]);
  // Set on
  let result = executeSceneAdminCommand({
    parsed: { isAdmin: true, userId: '1' },
    command: { kind: 'download-media-set', sceneKey: 'tgBot:-1001', enabled: true },
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 2,
  });
  assert.equal(result.ok, true);
  assert.equal(sceneRegistry.get('tgBot:-1001').downloadMedia, true);

  // Clear
  result = executeSceneAdminCommand({
    parsed: { isAdmin: true, userId: '1' },
    command: { kind: 'download-media-set', sceneKey: 'tgBot:-1001', enabled: undefined },
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 3,
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /Cleared/);
  assert.equal(sceneRegistry.get('tgBot:-1001').downloadMedia, undefined);
});

test('executeSceneAdminCommand: download-media global get/set', () => {
  const sceneRegistry = new Map();
  // Set global
  let result = executeSceneAdminCommand({
    parsed: { isAdmin: true, userId: '1' },
    command: { kind: 'download-media-global-set', enabled: true },
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 1,
  });
  assert.equal(result.ok, true);
  const globalScene = sceneRegistry.get('__global__');
  assert.equal(globalScene?.downloadMedia, true);

  // Get global
  result = executeSceneAdminCommand({
    parsed: { isAdmin: true, userId: '1' },
    command: { kind: 'download-media-global-get' },
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 2,
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /on/);
});
