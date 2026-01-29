import { emptyPluginConfigSchema, getChatChannelMeta, type ChannelPlugin, type IncomingMessage } from "clawdbot/plugin-sdk";
import { getNapcatRuntime } from "./runtime.js";
import { connectionManager } from "./connection-manager.js";

const meta = getChatChannelMeta("napcat");

// Napcat channel plugin implementation
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
    mapIncomingMessage: (raw: any): IncomingMessage | null => {
      // Handle incoming messages from nap-msg RPC
      // The raw object here comes from the RPC notification when a message is received
      if (raw && typeof raw === 'object') {
        return {
          id: raw.messageId?.toString() || Date.now().toString(),
          from: {
            id: raw.sender?.id?.toString() || "unknown",
            name: raw.sender?.name || raw.sender?.id?.toString() || "Unknown",
            channelUserId: raw.sender?.id?.toString()
          },
          to: [{
            id: raw.chatId?.toString() || "unknown",
            type: raw.isGroup ? "group" : "direct"
          }],
          text: raw.text,
          receivedAt: new Date().toISOString(),
          original: raw
        };
      }
      return null;
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text) => [text],
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendText: async ({ to, text }) => {
      // Use the connection manager to send via nap-msg RPC
      try {
        const result = await connectionManager.send('message.send', {
          to: to.toString(),
          text: text,
          isGroup: to.toString().includes('group') // Simplified logic
        });
        return { channel: "napcat", to, text, result };
      } catch (error) {
        console.error('Error sending message:', error);
        throw error;
      }
    },
    sendMedia: async ({ to, mediaUrl, text }) => {
      // Use the connection manager to send media via nap-msg RPC
      try {
        const result = await connectionManager.send('message.send', {
          to: to.toString(),
          text: text,
          mediaUrl: mediaUrl,
          isGroup: to.toString().includes('group') // Simplified logic
        });
        return { channel: "napcat", to, mediaUrl, text, result };
      } catch (error) {
        console.error('Error sending media:', error);
        throw error;
      }
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
    probeAccount: async () => {
      try {
        const connected = await connectionManager.ensureConnected();
        return { ok: connected };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
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
      ctx.log?.info(`[${ctx.account.accountId}] napcat plugin starting`);
      
      // Subscribe to incoming messages using the connection manager
      const unsubscribe = connectionManager.subscribe((message) => {
        ctx.handleInboundMessage(message);
      });
      
      // Ensure the connection is established
      await connectionManager.ensureConnected();
      
      return () => {
        ctx.log?.info(`[${ctx.account.accountId}] napcat plugin stopping`);
        unsubscribe(); // Unsubscribe from messages
      };
    },
  },
};