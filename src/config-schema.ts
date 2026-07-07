// ChannelConfigSchema is not directly exported from a narrow plugin-sdk subpath.
// Use the same shape inline (schema + optional uiHints).
type ChannelConfigSchema = { schema: Record<string, unknown>; uiHints?: Record<string, unknown> };

const asrSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    secretId: { type: "string" },
    secretKey: { type: "string" },
    region: { type: "string" },
    engine: { type: "string" },
  },
  required: ["secretId", "secretKey"],
} as const;

const accountShape = {
  name: { type: "string" },
  enabled: { type: "boolean" },
  url: { type: "string" },
  timeoutMs: { type: "number" },
  ignorePrefixes: {
    type: "array",
    items: { type: "string" },
  },
  fromGroup: {
    oneOf: [
      { type: ["string", "number"] },
      { type: "array", items: { type: ["string", "number"] } },
    ],
  },
  fromUser: {
    oneOf: [
      { type: ["string", "number"] },
      { type: "array", items: { type: ["string", "number"] } },
    ],
  },
  blockStreaming: { type: "boolean" },
  blockStreamingCoalesce: {
    type: "object",
    additionalProperties: false,
    properties: {
      minChars: { type: "number" },
      idleMs: { type: "number" },
    },
  },
  replyToMode: {
    type: "string",
    enum: ["off", "first", "all", "batched"],
  },
  textSplit: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      minDelayMs: { type: "number" },
      maxDelayMs: { type: "number" },
    },
  },
  asr: asrSchema,
} as const;

export const napcatChannelConfigSchema: ChannelConfigSchema = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...accountShape,
      accounts: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: accountShape,
        },
      },
    },
  },
};
