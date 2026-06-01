import type { ChatType } from 'openclaw/plugin-sdk';

export const BNCR_CHANNEL_CAPABILITIES = {
  chatTypes: ['direct'] as ChatType[],
  media: true,
  reply: true,
  nativeCommands: true,
};
