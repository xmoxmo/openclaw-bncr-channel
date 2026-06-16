import assert from 'node:assert/strict';
import test from 'node:test';

import { mutateOpenClawRuntimeConfigFile } from '../../src/openclaw/config-runtime.ts';

test('mutateOpenClawRuntimeConfigFile forwards mutate requests to host runtime', async () => {
  const calls = [];
  const api = {
    runtime: {
      config: {
        async mutateConfigFile(params) {
          calls.push(params);
          const draft = { channels: {} };
          params.mutate(draft);
          return draft;
        },
      },
    },
  };

  const result = await mutateOpenClawRuntimeConfigFile(api, {
    afterWrite: { mode: 'auto' },
    mutate(draft) {
      draft.channels.bncr = { enabled: true };
    },
  });

  assert.deepEqual(result, { channels: { bncr: { enabled: true } } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].afterWrite, { mode: 'auto' });
});

test('mutateOpenClawRuntimeConfigFile throws when host mutate api is unavailable', async () => {
  await assert.rejects(
    () => mutateOpenClawRuntimeConfigFile({ runtime: { config: {} } }, { mutate() {} }),
    /mutate API is unavailable/,
  );
});
