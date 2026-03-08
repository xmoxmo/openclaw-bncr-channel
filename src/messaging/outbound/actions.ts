export async function sendBncrReplyAction(params: {
  accountId: string;
  to: string;
  text: string;
  replyToMessageId?: string;
  sendText: (params: {
    accountId: string;
    to: string;
    text: string;
    replyToMessageId?: string;
  }) => Promise<any>;
}) {
  return params.sendText({
    accountId: params.accountId,
    to: params.to,
    text: params.text,
    replyToMessageId: params.replyToMessageId,
  });
}

export async function deleteBncrMessageAction(_params: {
  accountId: string;
  targetMessageId: string;
}) {
  return { ok: false, unsupported: true, reason: 'delete not implemented yet' };
}

export async function reactBncrMessageAction(_params: {
  accountId: string;
  targetMessageId: string;
  emoji: string;
}) {
  return { ok: false, unsupported: true, reason: 'react not implemented yet' };
}

export async function editBncrMessageAction(_params: {
  accountId: string;
  targetMessageId: string;
  text: string;
}) {
  return { ok: false, unsupported: true, reason: 'edit not implemented yet' };
}
