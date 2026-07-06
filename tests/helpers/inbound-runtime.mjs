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
    replyDispatchStarts: [],
    replyDispatchCompletions: [],
    requests: [],
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
    async request(method, params) {
      calls.requests.push({ method, params });
      if (typeof options.onRequest === 'function') {
        return await options.onRequest({ method, params, calls });
      }
      return { ok: true };
    },
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
            return { path: `/tmp/bncr-inbound-media-${calls.savedMediaBuffers.length}.bin` };
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
            calls.replyDispatchStarts.push({
              sessionKey: ctx?.SessionKey,
              to: ctx?.To,
              messageSid: ctx?.MessageSid,
            });
            if (typeof options.onReplyDispatchStart === 'function') {
              await options.onReplyDispatchStart({ ctx, dispatcherOptions, calls });
            }
            if (ctx?.CommandTurn?.kind === 'native' && !nativeCommandProducesReply) {
              calls.delivered.push({ text: null, kind: 'native-noop' });
              calls.replyDispatchCompletions.push({
                sessionKey: ctx?.SessionKey,
                to: ctx?.To,
                messageSid: ctx?.MessageSid,
              });
              return;
            }
            await dispatcherOptions.deliver({ text: 'reply from agent' }, { kind: 'final' });
            calls.delivered.push({ text: 'reply from agent', kind: 'final' });
            calls.replyDispatchCompletions.push({
              sessionKey: ctx?.SessionKey,
              to: ctx?.To,
              messageSid: ctx?.MessageSid,
            });
          },
        },
        inbound: {
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
              From: args.from,
              OwnerAllowFrom: args.extra?.OwnerAllowFrom,
              MessageSid: args.messageId,
              To: args.reply.to,
              OriginatingTo: args.reply.originatingTo,
              OriginatingChannel: args.extra?.OriginatingChannel,
              EnvelopeFrom: args.message.envelopeFrom,
              ConversationLabel: args.conversation.label,
              SessionKey: args.route.dispatchSessionKey,
              RouteSessionKey: args.route.routeSessionKey,
              DispatchSessionKey: args.route.dispatchSessionKey,
              MainSessionKey: args.route.mainSessionKey,
              CommandTurn: args.commandTurn,
              CommandAuthorized: args.commandTurn?.authorized,
              CommandSource: args.commandTurn?.source,
              AccessCommands: args.access?.commands,
              UntrustedStructuredContext: args.supplemental?.untrustedContext,
            };
            calls.builtContexts.push(ctx);
            return ctx;
          },
          async run({ adapter }) {
            const input = adapter.ingest();
            const preflight = await adapter.preflight?.(input);
            const turn = adapter.resolveTurn(input, { kind: 'message' }, preflight);
            calls.turnRuns.push(turn);
            await turn.recordInboundSession({
              storePath: turn.storePath,
              sessionKey: turn.routeSessionKey,
              ctx: turn.ctxPayload,
              updateLastRoute: turn.record.updateLastRoute,
              onRecordError: turn.record.onRecordError,
              trackSessionMetaTask: turn.record.trackSessionMetaTask,
            });
            if (preflight?.admission?.kind !== 'observeOnly') {
              await turn.runDispatch();
            }
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
    protocolVersion: 'scene-routing-v1',
    capabilities: ['scene-routing-v1'],
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    isGroup: true,
    isAdmin: false,
    type: 'text',
    msg: 'hello inbound',
    mimeType: 'text/plain',
    msgId: 'inbound-msg-1',
    ...overrides,
  };
}
