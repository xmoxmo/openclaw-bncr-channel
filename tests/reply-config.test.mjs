import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBncrReplyConfig,
  resolveBncrAllowTool,
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

test('resolveBncrAllowTool defaults to false when nothing is configured', () => {
  assert.equal(resolveBncrAllowTool({}), false);
});

test('resolveBncrAllowTool only enables on explicit true', () => {
  assert.equal(
    resolveBncrAllowTool({
      channels: { bncr: { allowTool: true } },
    }),
    true,
  );
});

test('resolveBncrAllowTool treats missing/false/non-boolean values as false', () => {
  assert.equal(
    resolveBncrAllowTool({
      channels: { bncr: { allowTool: false } },
    }),
    false,
  );

  assert.equal(
    resolveBncrAllowTool({
      channels: { bncr: { allowTool: 'true' } },
    }),
    false,
  );

  assert.equal(
    resolveBncrAllowTool({
      channels: { bncr: { allowTool: 1 } },
    }),
    false,
  );
});

test('buildBncrReplyConfig fills missing blockStreamingBreak with message_end', () => {
  const result = buildBncrReplyConfig({});
  assert.equal(result.blockStreaming, true);
  assert.equal(result.allowTool, false);
  assert.equal(result.replyCfg.agents.defaults.blockStreamingBreak, 'message_end');
  assert.deepEqual(result.replyCfg.agents.defaults.blockStreamingChunk, {
    minChars: 500,
    maxChars: 4096,
  });
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

test('buildBncrReplyConfig preserves explicit blockStreamingChunk', () => {
  const result = buildBncrReplyConfig({
    agents: {
      defaults: {
        blockStreamingChunk: {
          minChars: 800,
          maxChars: 1200,
          breakPreference: 'paragraph',
        },
      },
    },
  });
  assert.deepEqual(result.replyCfg.agents.defaults.blockStreamingChunk, {
    minChars: 800,
    maxChars: 1200,
    breakPreference: 'paragraph',
  });
});

test('buildBncrReplyConfig includes explicit allowTool=true', () => {
  const result = buildBncrReplyConfig({
    channels: {
      bncr: {
        allowTool: true,
      },
    },
  });
  assert.equal(result.allowTool, true);
});

test('buildBncrReplyConfig does not mutate the original cfg', () => {
  const cfg = {};
  const result = buildBncrReplyConfig(cfg);
  assert.equal(cfg.agents, undefined);
  assert.notEqual(result.replyCfg, cfg);
});
