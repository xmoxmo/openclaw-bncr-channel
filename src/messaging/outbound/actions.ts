type BncrReplyActionSendTextParams = {
  accountId: string;
  to: string;
  text: string;
  replyToMessageId?: string;
};

type BncrReplyActionResult = {
  channel: string;
  messageId: string;
  chatId: string;
};

type BncrUnsupportedActionResult = {
  ok: false;
  unsupported: true;
  reason: string;
};

export async function sendBncrReplyAction(params: {
  accountId: string;
  to: string;
  text: string;
  replyToMessageId?: string;
  sendText: (params: BncrReplyActionSendTextParams) => Promise<BncrReplyActionResult>;
}): Promise<BncrReplyActionResult> {
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
}): Promise<BncrUnsupportedActionResult> {
  return { ok: false, unsupported: true, reason: 'delete not implemented yet' };
}

export async function reactBncrMessageAction(_params: {
  accountId: string;
  targetMessageId: string;
  emoji: string;
}): Promise<BncrUnsupportedActionResult> {
  return { ok: false, unsupported: true, reason: 'react not implemented yet' };
}

export async function editBncrMessageAction(_params: {
  accountId: string;
  targetMessageId: string;
  text: string;
}): Promise<BncrUnsupportedActionResult> {
  return { ok: false, unsupported: true, reason: 'edit not implemented yet' };
}
