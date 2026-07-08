import { CHANNEL_ID } from '../core/accounts.ts';

export const BNCR_CHANNEL_META = {
  id: CHANNEL_ID,
  label: 'Bncr',
  selectionLabel: 'Bncr Client',
  docsPath: '/channels/bncr',
  blurb: 'Bncr Channel.',
  aliases: ['bncr'],
  preferSessionLookupForAnnounceTarget: true,
};
