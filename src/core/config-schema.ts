export const BncrConfigSchema = {
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      enabled: { type: 'boolean' },
      dmPolicy: {
        type: 'string',
        enum: ['open', 'allowlist', 'disabled'],
      },
      groupPolicy: {
        type: 'string',
        enum: ['open', 'allowlist', 'disabled'],
      },
      allowFrom: {
        type: 'array',
        items: { type: 'string' },
      },
      groupAllowFrom: {
        type: 'array',
        items: { type: 'string' },
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
      accounts: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          additionalProperties: true,
          properties: {
            enabled: { type: 'boolean' },
            name: { type: 'string' },
          },
        },
      },
    },
  },
};
