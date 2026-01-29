import { emptyPluginConfigSchema, getChatChannelMeta, type ChannelPlugin } from "clawdbot/plugin-sdk";
import { getNapcatRuntime } from "./runtime.js";

const meta = getChatChannelMeta("napcat");

// Minimal stub plugin to register Napcat channel. It advertises capabilities but delegates
// actual provider wiring to the runtime (not implemented here).
export const napcatPlugin: ChannelPlugin<any> = {
  id: "napcat",
  meta: { ...meta, aliases: ["nap"] },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
  },
  configSchema: emptyPluginConfigSchema(),
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: (_cfg, accountId) => ({
      accountId,
      name: accountId,
      enabled: true,
      configured: true,
      config: {},
    }),
    defaultAccountId: () => "default",
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const existing = cfg.channels?.napcat?.accounts || {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          napcat: {
            ...(cfg.channels?.napcat || {}),
            accounts: {
              ...existing,
              [accountId]: { ...(existing[accountId] || {}), enabled },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const existing = { ...(cfg.channels?.napcat?.accounts || {}) };
      delete existing[accountId];
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          napcat: {
            ...(cfg.channels?.napcat || {}),
            accounts: existing,
          },
        },
      };
    },
    isConfigured: (account) => Boolean(account?.configured ?? true),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name ?? account.accountId,
      enabled: Boolean(account.enabled ?? true),
      configured: Boolean(account.configured ?? true),
    }),
    resolveAllowFrom: () => [],
    resolveRequireAttentionPrefix: () => null,
    resolveToolPolicy: () => "allow",
  },
  inbound: {
    schemaVersion: 1,
    mapIncomingMessage: () => null,
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text) => [text],
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendText: async ({ to, text }) => {
      // Placeholder: real implementation should bridge to nap-msg RPC.
      return { channel: "napcat", to, text } as any;
    },
    sendMedia: async ({ to, mediaUrl, text }) => {
      // Placeholder: real implementation should bridge to nap-msg RPC.
      return { channel: "napcat", to, mediaUrl, text } as any;
    },
  },
  status: {
    defaultRuntime: {
      accountId: "default",
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      cliPath: null,
      dbPath: null,
    },
    collectStatusIssues: () => [],
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? true,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      cliPath: snapshot.cliPath ?? null,
      dbPath: snapshot.dbPath ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async () => ({ ok: true }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name ?? account.accountId,
      enabled: Boolean(account.enabled ?? true),
      configured: Boolean(account.configured ?? true),
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      cliPath: runtime?.cliPath ?? null,
      dbPath: runtime?.dbPath ?? null,
      probe: runtime?.probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
    resolveAccountState: ({ enabled }) => (enabled ? "enabled" : "disabled"),
  },
  gateway: {
    startAccount: async (ctx) => {
      ctx.log?.info(`[${ctx.account.accountId}] napcat plugin stub started`);
      // No-op; wire actual provider process here as needed.
      return () => {
        getNapcatRuntime();
      };
    },
  },
};
