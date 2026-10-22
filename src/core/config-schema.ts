export const DEFAULT_BNCR_MEDIA_MAX_MB = 2048;

export const BncrConfigSchema = {
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      enabled: { type: 'boolean' },
      allowFrom: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Owner/pairing list used by the host surface. It does not admit inbound messages; private-chat admission is controlled by scene status.',
      },
      allowBridgeCall: {
        type: 'boolean',
        description:
          'Allow the message tool to forward bridgeMethod calls verbatim to the connected Bncr client. Defaults to on; set false to disable the raw passthrough.',
      },
      debug: {
        type: 'object',
        additionalProperties: true,
        properties: {
          verbose: {
            type: 'boolean',
            default: false,
            description: 'Enable verbose debug logs for bncr channel runtime.',
          },
        },
      },
      allowTool: {
        type: 'boolean',
        default: false,
        description:
          'Allow tool messages to be forwarded when streaming is enabled. Defaults to false; only explicit true enables forwarding. When enabled, bncr also requests upstream tool summaries/results.',
      },
      requireMention: {
        type: 'boolean',
        default: false,
        description:
          'Whether group messages must explicitly mention the bot before bncr handles them. Default false. Current version keeps this as a reserved field and does not enforce it yet.',
      },
      outboundRequireAck: {
        type: 'boolean',
        default: true,
        description:
          'Whether outbound text waits for bncr.ack before leaving the retry queue. Default true to preserve current ack/dead-letter behavior.',
      },
      mediaMaxMb: {
        type: 'number',
        exclusiveMinimum: 0,
        default: DEFAULT_BNCR_MEDIA_MAX_MB,
        description:
          'Maximum Bncr media/file size in MiB. Default 2048 (2 GiB). This is the single Bncr size limit.',
      },
      accounts: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          additionalProperties: true,
          properties: {
            enabled: { type: 'boolean' },
            name: { type: 'string' },
            mediaMaxMb: {
              type: 'number',
              exclusiveMinimum: 0,
              description:
                'Optional per-account override for the Bncr media/file size limit in MiB.',
            },
          },
        },
      },
    },
  },
};
