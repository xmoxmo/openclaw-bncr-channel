export function buildFileAckKey(args: {
  transferId: string;
  stage: string;
  chunkIndex?: number;
}): string {
  const n = Number(args.chunkIndex);
  const idx = Number.isInteger(n) && n >= 0 ? String(n) : '-';
  return `${args.transferId}|${args.stage}|${idx}`;
}
