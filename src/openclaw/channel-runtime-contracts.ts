import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import type { BncrRoute } from '../core/types.ts';

export type OpenClawChannelRuntimeContext = Record<string, unknown> & {
  BodyForAgent?: string;
  CommandBody?: string;
};

export type OpenClawChannelPeer = {
  kind: 'direct' | 'group';
  id: string;
};

export type OpenClawResolvedAgentRoute = {
  sessionKey?: string;
  mainSessionKey?: string;
  route?: BncrRoute;
  agentId?: string;
  [key: string]: unknown;
};

export type OpenClawReplyDispatcherPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
};

export type OpenClawReplyDispatchInfo = { kind?: 'tool' | 'block' | 'final' };

export type OpenClawInboundRuntimeIngested = {
  id: string;
  timestamp: number;
  rawText: string;
  textForAgent?: string;
  textForCommands?: string;
  raw: unknown;
};

export type OpenClawInboundRuntimeResolvedTurn = {
  channel: string;
  accountId: string;
  routeSessionKey: string;
  storePath: string;
  ctxPayload: OpenClawChannelRuntimeContext;
  recordInboundSession: (...args: unknown[]) => Promise<unknown> | unknown;
  record: {
    updateLastRoute: unknown;
    onRecordError: (err: unknown) => void;
    trackSessionMetaTask?: (task: Promise<unknown>) => void;
  };
  runDispatch: () => Promise<unknown> | unknown;
};

export type OpenClawInboundRuntimeAdapter = {
  ingest: () => OpenClawInboundRuntimeIngested;
  resolveTurn: () => OpenClawInboundRuntimeResolvedTurn;
};

export type OpenClawInboundRuntimeRunParams = {
  channel: string;
  accountId: string;
  raw: unknown;
  adapter: OpenClawInboundRuntimeAdapter;
  onFinalize?: () => void;
};

export type OpenClawInboundRuntime = {
  buildContext: (
    params: unknown,
  ) => OpenClawChannelRuntimeContext | Promise<OpenClawChannelRuntimeContext>;
  run: (params: unknown) => Promise<unknown> | unknown;
  runPreparedReply?: (params: unknown) => Promise<unknown> | unknown;
  dispatchReply?: (params: unknown) => Promise<unknown> | unknown;
};

export type OpenClawChannelRuntimeApiHolder = OpenClawPluginApi;
