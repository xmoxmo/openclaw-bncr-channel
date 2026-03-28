import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBncrReplyConfig,
  resolveBncrBlockStreaming,
} from '../src/messaging/inbound/reply-config.ts';

test('resolveBncrBlockStreaming defaults to true when nothing is configured', () => {
  assert.equal(resolveBncrBlockStreaming({}), true);
});

test('resolveBncrBlockStreaming reads global on/off fallback', () => {
  assert.equal(
    resolveBncrBlockStreaming({ agents: { defaults: { blockStreamingDefault: 'on' } } }),
    true,
  );
  assert.equal(
    resolveBncrBlockStreaming({ agents: { defaults: { blockStreamingDefault: 'off' } } }),
    false,
  );
});

test('resolveBncrBlockStreaming lets channel config override global default', () => {
  assert.equal(
    resolveBncrBlockStreaming({
      channels: { bncr: { blockStreaming: true } },
      agents: { defaults: { blockStreamingDefault: 'off' } },
    }),
    true,
  );
  assert.equal(
    resolveBncrBlockStreaming({
      channels: { bncr: { blockStreaming: false } },
      agents: { defaults: { blockStreamingDefault: 'on' } },
    }),
    false,
  );
});

test('buildBncrReplyConfig fills missing blockStreamingBreak with message_end', () => {
  const result = buildBncrReplyConfig({});
  assert.equal(result.blockStreaming, true);
  assert.equal(result.replyCfg.agents.defaults.blockStreamingBreak, 'message_end');
});

test('buildBncrReplyConfig preserves explicit blockStreamingBreak', () => {
  const result = buildBncrReplyConfig({
    agents: {
      defaults: {
        blockStreamingBreak: 'text_end',
      },
    },
  });
  assert.equal(result.replyCfg.agents.defaults.blockStreamingBreak, 'text_end');
});

test('buildBncrReplyConfig does not mutate the original cfg', () => {
  const cfg = {};
  const result = buildBncrReplyConfig(cfg);
  assert.equal(cfg.agents, undefined);
  assert.notEqual(result.replyCfg, cfg);
});
