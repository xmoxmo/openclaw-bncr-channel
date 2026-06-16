import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setBncrInboundSessionRuntimeForTest } from '../../src/openclaw/inbound-session-runtime.ts';

export function createInboundApiStub(options = {}) {
  const currentConfig = {};
  const storePath =
    options.storePath ||
    path.join(os.tmpdir(), `bncr-test-store-${Date.now()}-${Math.random()}.json`);
  const nativeCommandProducesReply = options.nativeCommandProducesReply ?? true;
  const calls = {
    builtContextArgs: [],
    builtContexts: [],
    recorded: [],
    delivered: [],
    turnRuns: [],
    sessionPatches: [],
    savedMediaBuffers: [],
  };

  const restoreSessionRuntime = setBncrInboundSessionRuntimeForTest({
    resolveStorePath() {
      return storePath;
    },
    async recordInboundSession(args) {
      calls.recorded.push(args);
    },
    readSessionUpdatedAt() {
      return 0;
    },
    async recordSessionMetaFromInbound(args) {
      const existing = fs.existsSync(args.storePath)
        ? JSON.parse(fs.readFileSync(args.storePath, 'utf8'))
        : {};
      existing[args.sessionKey] = {
        ...(existing[args.sessionKey] || {}),
        label: args.ctx?.ConversationLabel,
        channel: args.ctx?.OriginatingChannel,
        chatType: args.ctx?.ChatType,
      };
      fs.writeFileSync(args.storePath, JSON.stringify(existing, null, 2));
    },
    async updateSessionStoreEntry(args) {
      calls.sessionPatches.push(args);
      const existing = fs.existsSync(args.storePath)
        ? JSON.parse(fs.readFileSync(args.storePath, 'utf8'))
        : {};
      const current = existing[args.sessionKey] || {};
      const patch = args.update(current);
      if (patch) {
        existing[args.sessionKey] = { ...current, ...patch };
        fs.writeFileSync(args.storePath, JSON.stringify(existing, null, 2));
      }
    },
  });

  const api = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {
      config: {
        current() {
          return currentConfig;
        },
        get() {
          return currentConfig;
        },
        async loadConfig() {
          return currentConfig;
        },
      },
      channel: {
        routing: {
          resolveAgentRoute() {
            return { sessionKey: 'agent:orion:bncr:direct:demo', agentId: 'orion' };
          },
        },
        session: {
          resolveStorePath() {
            return storePath;
          },
          readSessionUpdatedAt() {
            return 0;
          },
          async recordInboundSession(args) {
            calls.recorded.push(args);
          },
          async recordSessionMetaFromInbound(args) {
            calls.recorded.push(args);
          },
          async updateSessionStoreEntry(args) {
            calls.sessionPatches.push(args);
          },
        },
        media: {
          ...(options.readRemoteMediaBuffer
            ? { readRemoteMediaBuffer: options.readRemoteMediaBuffer }
            : {}),
          async saveMediaBuffer(buffer, mimeType, direction, maxBytes, fileName) {
            calls.savedMediaBuffers.push({ buffer, mimeType, direction, maxBytes, fileName });
            return { path: '/tmp/bncr-inbound-media.bin' };
          },
        },
        reply: {
          resolveEnvelopeFormatOptions() {
            return {};
          },
          formatAgentEnvelope({ body }) {
            return `ENV:${body}`;
          },
          async dispatchReplyWithBufferedBlockDispatcher({ ctx, dispatcherOptions }) {
            if (ctx?.CommandTurn?.kind === 'native' && !nativeCommandProducesReply) {
              calls.delivered.push({ text: null, kind: 'native-noop' });
              return;
            }
            await dispatcherOptions.deliver({ text: 'reply from agent' }, { kind: 'final' });
            calls.delivered.push({ text: 'reply from agent', kind: 'final' });
          },
        },
        turn: {
          buildContext(args) {
            calls.builtContextArgs.push(args);
            const ctx = {
              ...args.extra,
              Body: args.message.body,
              BodyForAgent: args.message.bodyForAgent,
              RawBody: args.message.rawBody,
              CommandBody: args.message.commandBody,
              BodyForCommands: args.message.commandBody,
              MediaPath: args.media?.[0]?.path,
              MediaType: args.media?.[0]?.contentType,
              ChatType: args.conversation.kind,
              SenderId: args.sender.id,
              MessageSid: args.messageId,
              To: args.reply.to,
              OriginatingTo: args.reply.originatingTo,
              EnvelopeFrom: args.message.envelopeFrom,
              ConversationLabel: args.conversation.label,
              SessionKey: args.route.dispatchSessionKey,
              RouteSessionKey: args.route.routeSessionKey,
              DispatchSessionKey: args.route.dispatchSessionKey,
              MainSessionKey: args.route.mainSessionKey,
              CommandTurn: args.commandTurn,
              UntrustedStructuredContext: args.supplemental?.untrustedContext,
            };
            calls.builtContexts.push(ctx);
            return ctx;
          },
          async run({ adapter }) {
            const turn = adapter.resolveTurn();
            calls.turnRuns.push(turn);
            await turn.recordInboundSession({
              storePath: turn.storePath,
              sessionKey: turn.routeSessionKey,
              ctx: turn.ctxPayload,
              updateLastRoute: turn.record.updateLastRoute,
              onRecordError: turn.record.onRecordError,
            });
            await turn.runDispatch();
            adapter.onFinalize?.();
          },
        },
      },
    },
  };

  return { api, calls, storePath, restoreSessionRuntime };
}

export function withInboundSessionRuntimeStub(runtime) {
  return {
    restore: setBncrInboundSessionRuntimeForTest(runtime),
  };
}

export function buildParsedInboundText(overrides = {}) {
  return {
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    type: 'text',
    msg: 'hello inbound',
    mimeType: 'text/plain',
    msgId: 'inbound-msg-1',
    ...overrides,
  };
}
