import { emptyPluginConfigSchema, getChatChannelMeta, type ChannelLogSink, type ChannelPlugin, type MoltbotConfig } from "clawdbot/plugin-sdk";
import { getNapcatRuntime } from "./runtime.js";
import { connectionManager } from "./connection-manager.js";

const meta = getChatChannelMeta("napcat");

type NapcatRawMessage = {
  sender?: string | number;
  chatId?: string | number;
  isGroup?: boolean;
  text?: string | null;
  messageId?: string | number;
};

const normalizeId = (value?: string | number | null): string | null => {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  return str ? str : null;
};

const parseTarget = (raw?: string | number | null): { chatId: string; isGroup: boolean } | null => {
  const id = normalizeId(raw);
  if (!id) return null;
  const stripped = id.replace(/^napcat:/i, "");
  const groupMatch = stripped.match(/^group:(.+)$/i);
  if (groupMatch) return { chatId: groupMatch[1], isGroup: true };
  return { chatId: stripped, isGroup: false };
};

async function sendNapcatMessage(params: { chatId: string; isGroup: boolean; text: string }) {
  await connectionManager.ensureConnected();
  await connectionManager.send("message.send", {
    chatId: params.chatId,
    to: params.chatId,
    isGroup: params.isGroup,
    text: params.text,
  });
}

function formatNapcatPayloadText(
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string },
  tableMode: string,
): string | null {
  const runtime = getNapcatRuntime();
  const parts: string[] = [];
  if (payload.text?.trim()) parts.push(payload.text);
  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];
  if (mediaList.length) {
    parts.push(mediaList.join("\n"));
  }
  const joined = parts.join("\n").trim();
  if (!joined) return null;
  return runtime.channel.text.convertMarkdownTables(joined, tableMode);
}

async function handleNapcatInbound(params: {
  raw: NapcatRawMessage;
  cfg: MoltbotConfig;
  accountId: string;
  setStatus: (next: any) => void;
  log?: ChannelLogSink;
}) {
  const runtime = getNapcatRuntime();
  const chatId = normalizeId(params.raw.chatId);
  const senderId = normalizeId(params.raw.sender);
  const messageId = normalizeId(params.raw.messageId);
  const rawBody = typeof params.raw.text === "string" ? params.raw.text.trim() : "";
  if (!chatId || !senderId || !rawBody) {
    params.log?.debug?.("napcat drop inbound: missing chatId/sender/text");
    return;
  }
  const isGroup = Boolean(params.raw.isGroup);
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: "napcat",
    accountId: params.accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: chatId,
    },
  });

  const storePath = runtime.channel.session.resolveStorePath(params.cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(params.cfg);
  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const fromLabel = isGroup ? `group:${chatId}` : `user:${senderId}`;
  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: "Napcat",
    from: fromLabel,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `napcat:group:${chatId}` : `napcat:${senderId}`,
    To: `napcat:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderId,
    SenderId: senderId,
    CommandAuthorized: true,
    Provider: "napcat",
    Surface: "napcat",
    MessageSid: messageId ?? undefined,
    OriginatingChannel: "napcat",
    OriginatingTo: `napcat:${chatId}`,
  });

  await runtime.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      params.log?.error?.(`napcat: failed to update session meta: ${String(err)}`);
    },
  });

  params.setStatus({ accountId: route.accountId, lastInboundAt: Date.now(), lastError: null });

  const tableMode = runtime.channel.text.resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "napcat",
    accountId: route.accountId,
  });

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: params.cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        const text = formatNapcatPayloadText(payload, tableMode);
        if (!text) return;
        await sendNapcatMessage({ chatId, isGroup, text });
        params.setStatus({ accountId: route.accountId, lastOutboundAt: Date.now() });
      },
      onError: (err, info) => {
        params.log?.error?.(
          `[${route.accountId}] napcat ${info.kind} reply failed: ${String(err)}`,
        );
      },
    },
  });
}

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
  outbound: {
    deliveryMode: "direct",
    chunker: (text) => [text],
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendText: async ({ to, text }) => {
      const target = parseTarget(to);
      if (!target) {
        throw new Error("napcat target is required");
      }
      const message = text?.trim();
      if (!message) {
        throw new Error("napcat message text is empty");
      }
      try {
        await sendNapcatMessage({
          chatId: target.chatId,
          isGroup: target.isGroup,
          text: message,
        });
        return { channel: "napcat", to: target.chatId, text: message };
      } catch (error) {
        console.error("Error sending message:", error);
        throw error;
      }
    },
    sendMedia: async ({ to, mediaUrl, text }) => {
      const target = parseTarget(to);
      if (!target) {
        throw new Error("napcat target is required");
      }
      const payloadText = [text, mediaUrl].filter(Boolean).join("\n").trim();
      if (!payloadText) {
        throw new Error("napcat message text is empty");
      }
      try {
        await sendNapcatMessage({
          chatId: target.chatId,
          isGroup: target.isGroup,
          text: payloadText,
        });
        return { channel: "napcat", to: target.chatId, mediaUrl, text: payloadText };
      } catch (error) {
        console.error("Error sending media:", error);
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

      // Subscribe to incoming messages from nap-msg RPC
      const unsubscribe = connectionManager.subscribe((message) => {
        try {
          void handleNapcatInbound({
            raw: message as NapcatRawMessage,
            cfg: ctx.cfg,
            accountId: ctx.account.accountId,
            setStatus: ctx.setStatus,
            log: ctx.log,
          });
        } catch (err) {
          ctx.log?.error?.(
            `napcat inbound dispatch failed: ${(err as Error).stack || (err as Error).message}`
          );
        }
      });

      // Ensure the connection is established
      await connectionManager.ensureConnected();

      return async () => {
        ctx.log?.info(`[${ctx.account.accountId}] napcat plugin stopping`);
        try {
          unsubscribe();
        } catch (e) {
          ctx.log?.warn?.(`napcat unsubscribe failed: ${(e as Error).message}`);
        }
        await connectionManager.disconnect();
      };
    },
  },
};
