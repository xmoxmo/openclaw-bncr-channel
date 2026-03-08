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
      requireMention: {
        type: 'boolean',
        default: false,
        description:
          'Whether group messages must explicitly mention the bot before bncr handles them. Default false. Current version keeps this as a reserved field and does not enforce it yet.',
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
