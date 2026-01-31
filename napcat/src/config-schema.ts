import type { ChannelConfigSchema } from "openclaw/plugin-sdk";

export const napcatChannelConfigSchema: ChannelConfigSchema = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string" },
      enabled: { type: "boolean" },
      url: { type: "string" },
      cliPath: { type: "string" },
      timeoutMs: { type: "number" },
      ignorePrefixes: {
        type: "array",
        items: { type: "string" },
      },
      fromGroup: { type: ["string", "number"] },
      fromUser: { type: ["string", "number"] },
      blockStreaming: { type: "boolean" },
      blockStreamingCoalesce: {
        type: "object",
        additionalProperties: false,
        properties: {
          minChars: { type: "number" },
          idleMs: { type: "number" },
        },
      },
      accounts: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            enabled: { type: "boolean" },
            url: { type: "string" },
            cliPath: { type: "string" },
            timeoutMs: { type: "number" },
            ignorePrefixes: {
              type: "array",
              items: { type: "string" },
            },
            fromGroup: { type: ["string", "number"] },
            fromUser: { type: ["string", "number"] },
            blockStreaming: { type: "boolean" },
            blockStreamingCoalesce: {
              type: "object",
              additionalProperties: false,
              properties: {
                minChars: { type: "number" },
                idleMs: { type: "number" },
              },
            },
          },
        },
      },
    },
  },
};
