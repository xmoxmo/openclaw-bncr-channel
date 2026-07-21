import type { NormalizedReplyPayload } from './reply-enqueue.ts';

export function hasReplyMediaEntries(payload: NormalizedReplyPayload) {
  return payload.mediaList.length > 0;
}
