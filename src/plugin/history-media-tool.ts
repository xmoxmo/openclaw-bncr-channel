import { imageResultFromFile } from 'openclaw/plugin-sdk/channel-actions';
import type { OpenClawPluginToolFactory } from 'openclaw/plugin-sdk/plugin-entry';
import { Type } from 'typebox';
import { normalizeAccountId } from '../core/accounts.ts';
import { BncrMediaSourceError } from '../messaging/inbound/media-assets.ts';
import { openClawJsonResult } from '../openclaw/sdk-helpers.ts';
import type { BncrChannelPluginBridge } from './channel-plugin-bridge-group.ts';

export const BNCR_HISTORY_MEDIA_TOOL_NAME = 'bncr_download_media';

type HistoryMediaToolBridge = Pick<BncrChannelPluginBridge, 'downloadHistoryMedia'>;

/**
 * Historical media remains in conversation context. The model receives its
 * explicit source metadata and passes that source back to this plugin-owned
 * tool; the tool never searches history or asks the host for targetless media.
 */
export function createBncrHistoryMediaToolFactory(args: {
  getBridge: () => HistoryMediaToolBridge | undefined;
}): OpenClawPluginToolFactory<2> {
  return {
    contextVersion: 2,
    create(ctx) {
      return [
        {
          name: BNCR_HISTORY_MEDIA_TOOL_NAME,
          label: 'BNCR historical media',
          description:
            'Download one historical BNCR media attachment into the current agent workspace. Pass source, sourceKind, mediaRef, contentType, and fileName exactly as shown in historical media metadata. Local sources must belong to the current agent workspace or the host media store. Current-turn media is already attached.',
          parameters: Type.Object(
            {
              source: Type.String({
                description:
                  'The exact URL or absolute local path from historical media metadata. Local paths must be in the current agent workspace or host media store.',
                minLength: 1,
              }),
              sourceKind: Type.Union([Type.Literal('url'), Type.Literal('local')], {
                description: 'Where the historical media source lives.',
              }),
              mediaRef: Type.Optional(
                Type.String({
                  description: 'Historical mediaRef for result correlation.',
                  minLength: 1,
                }),
              ),
              contentType: Type.Optional(
                Type.String({
                  description: 'MIME type from historical media metadata.',
                  minLength: 1,
                }),
              ),
              fileName: Type.Optional(
                Type.String({
                  description: 'Original file name from historical media metadata.',
                  minLength: 1,
                }),
              ),
            },
            { additionalProperties: false },
          ),
          async execute(_toolCallId, rawParams) {
            const bridge = args.getBridge();
            if (!bridge) throw new Error('BNCR runtime is not available');

            const params =
              rawParams && typeof rawParams === 'object'
                ? (rawParams as Record<string, unknown>)
                : {};
            const source = readOptionalString(params.source).trim();
            const mediaRef = readOptionalString(params.mediaRef).trim();
            const sourceKind = readOptionalString(params.sourceKind).trim();
            const contentType = readOptionalString(params.contentType).trim();
            const fileName = readOptionalString(params.fileName).trim();

            const agentId = ctx.agentId?.trim() || '';
            const sessionKey = ctx.sessionKey?.trim() || '';
            const accountId = normalizeAccountId(
              ctx.agentAccountId?.trim() || ctx.deliveryContext?.accountId?.trim() || '',
            );
            if (!agentId) throw new Error('bncr_download_media requires a trusted agent context');
            if (!sessionKey)
              throw new Error('bncr_download_media requires a trusted session context');

            if (!source) {
              return openClawJsonResult({
                ok: false,
                code: 'SOURCE_REQUIRED',
                message: 'media source is required',
              });
            }
            if (sourceKind !== 'url' && sourceKind !== 'local') {
              return openClawJsonResult({
                ok: false,
                code: 'SOURCE_KIND_INVALID',
                message: 'sourceKind must be either url or local',
              });
            }

            ctx.assertInvocationCurrent();
            let downloaded: Awaited<ReturnType<HistoryMediaToolBridge['downloadHistoryMedia']>>;
            try {
              downloaded = await bridge.downloadHistoryMedia({
                accountId,
                agentId,
                sessionKey,
                source,
                sourceKind,
                ...(mediaRef ? { mediaRef } : {}),
                ...(contentType ? { contentType } : {}),
                ...(fileName ? { fileName } : {}),
                assertCurrent: ctx.assertInvocationCurrent,
              });
            } catch (error) {
              if (error instanceof BncrMediaSourceError) {
                return openClawJsonResult({
                  ok: false,
                  code: error.code,
                  message: error.message,
                });
              }
              throw error;
            }
            ctx.assertInvocationCurrent();

            const details = {
              ok: true,
              ...(downloaded.mediaRef ? { mediaRef: downloaded.mediaRef } : {}),
              source,
              sourceKind,
              path: downloaded.mediaUri,
              ...(downloaded.contentType ? { contentType: downloaded.contentType } : {}),
              ...(downloaded.fileName ? { fileName: downloaded.fileName } : {}),
              ...(downloaded.sizeBytes !== undefined ? { sizeBytes: downloaded.sizeBytes } : {}),
            };
            if (downloaded.contentType?.startsWith('image/')) {
              return imageResultFromFile({
                label: downloaded.mediaRef
                  ? `BNCR media ${downloaded.mediaRef}`
                  : 'BNCR historical media',
                path: downloaded.localPath,
                details,
              });
            }
            return openClawJsonResult(details);
          },
        },
      ];
    },
  };
}

function readOptionalString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
