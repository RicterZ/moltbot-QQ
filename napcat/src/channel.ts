import {
  DEFAULT_ACCOUNT_ID,
  createReplyPrefixContext,
  type ChannelGatewayContext,
  type ChannelPlugin,
  type ChannelStatusIssue,
  type OpenClawConfig,
  type ReplyPayload,
} from "openclaw/plugin-sdk";

import { napcatChannelConfigSchema } from "./config-schema.js";
import { deliverNapcatReplies, type NapcatTarget } from "./deliver.js";
import { NapcatRpcClient, type NapcatRpcNotification } from "./rpc-client.js";
import { getNapcatRuntime } from "./runtime.js";
import {
  listNapcatAccountIds,
  resolveNapcatAccount,
  type ResolvedNapcatAccount,
} from "./types.js";

type NapcatInboundMessage = {
  sender?: string | number | null;
  chatId?: string | number | null;
  isGroup?: boolean | null;
  text?: string | null;
  messageId?: string | number | null;
  images?: string[] | null;
  videos?: string[] | null;
  files?: string[] | null;
};

const activeClients = new Map<string, NapcatRpcClient>();

function inferMediaKind(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if (lower.match(/\.(png|jpe?g|gif|webp|avif)(\?|$)/)) return "image";
  if (lower.match(/\.(mp4|mov|mkv|webm)(\?|$)/)) return "video";
  if (lower.match(/\.(mp3|wav|m4a|aac|flac|ogg|opus)(\?|$)/)) return "audio";
  return "file";
}

function normalizeNapcatTarget(raw: string): NapcatTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let text = trimmed.replace(/^napcat:/i, "");
  let channel: NapcatTarget["channel"] = "private";
  if (text.toLowerCase().startsWith("group:")) {
    channel = "group";
    text = text.slice("group:".length);
  } else if (text.toLowerCase().startsWith("group-")) {
    channel = "group";
    text = text.slice("group-".length);
  } else if (text.toLowerCase().startsWith("user:")) {
    channel = "private";
    text = text.slice("user:".length);
  } else if (text.toLowerCase().startsWith("user-")) {
    channel = "private";
    text = text.slice("user-".length);
  }
  const id = text.trim();
  if (!id) return null;
  return { channel, id };
}

async function getClient(account: ResolvedNapcatAccount): Promise<{
  client: NapcatRpcClient;
  release?: () => Promise<void>;
}> {
  const existing = activeClients.get(account.accountId);
  if (existing) {
    return { client: existing };
  }

  const client = new NapcatRpcClient({
    cliPath: account.cliPath,
    napcatUrl: account.napcatUrl,
    timeoutMs: account.timeoutMs,
    env: account.env,
  });
  await client.start();
  return {
    client,
    release: async () => {
      await client.stop().catch(() => {});
    },
  };
}

function buildInboundTarget(message: NapcatInboundMessage): NapcatTarget | null {
  const chatId = message.chatId ?? message.sender;
  if (chatId === undefined || chatId === null) return null;
  const id = String(chatId).trim();
  if (!id) return null;
  return {
    channel: message.isGroup ? "group" : "private",
    id,
  };
}

async function handleInboundNapcatMessage(params: {
  message: NapcatInboundMessage;
  account: ResolvedNapcatAccount;
  cfg: OpenClawConfig;
  client: NapcatRpcClient;
  ctx: ChannelGatewayContext<ResolvedNapcatAccount>;
}) {
  const { message, account, cfg, client, ctx } = params;
  const runtime = getNapcatRuntime();
  const target = buildInboundTarget(message);
  if (!target) return;

  const senderId = message.sender != null ? String(message.sender).trim() : "";
  const chatId = message.chatId != null ? String(message.chatId).trim() : undefined;
  const text = message.text?.trim() ?? "";
  const attachments = [
    ...(message.images ?? []),
    ...(message.videos ?? []),
    ...(message.files ?? []),
  ].filter(Boolean);

  if (!text && attachments.length === 0) return;

  const mediaKind = inferMediaKind(attachments[0]);
  const mediaPlaceholder = mediaKind ? `<media:${mediaKind}>` : "<media:attachment>";

  ctx.setStatus({
    ...ctx.getStatus(),
    accountId: account.accountId,
    lastInboundAt: Date.now(),
    lastError: null,
  });

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "napcat",
    accountId: account.accountId,
    peer: {
      kind: message.isGroup ? "group" : "dm",
      id: message.isGroup ? chatId ?? "unknown" : senderId || "unknown",
    },
  });

  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const fromLabel = message.isGroup
    ? `Napcat Group ${chatId ?? "unknown"}`
    : `Napcat ${senderId || "unknown"}`;
  const attachmentLines = attachments.map((file) => `<media:${mediaKind ?? "attachment"}>${file}`);
  const bodyContent = [text || mediaPlaceholder, ...attachmentLines].filter(Boolean).join("\n");
  const body = runtime.channel.reply.formatInboundEnvelope({
    channel: "Napcat",
    from: fromLabel,
    timestamp: Date.now(),
    body: bodyContent,
    chatType: message.isGroup ? "group" : "direct",
    sender: { name: senderId || "unknown", id: senderId || "unknown" },
    envelope: envelopeOptions,
  });

  const to =
    target.channel === "group"
      ? `napcat:group:${target.id}`
      : `napcat:${senderId || target.id}`;

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: text,
    CommandBody: text,
    From: target.channel === "group" ? `napcat:group:${target.id}` : `napcat:${senderId || target.id}`,
    To: to,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: target.channel === "group" ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderId || "unknown",
    SenderId: senderId || target.id,
    Provider: "napcat",
    Surface: "napcat",
    MessageSid: message.messageId != null ? String(message.messageId) : undefined,
    MediaUrls: attachments.length > 0 ? attachments : undefined,
    MediaPaths: attachments.length > 0 ? attachments : undefined,
    WasMentioned: true,
    CommandAuthorized: true,
    OriginatingChannel: "napcat" as const,
    OriginatingTo: to,
    MediaUrl: attachments[0],
    MediaUrls: attachments.length > 0 ? attachments : undefined,
    MediaPaths: attachments.length > 0 ? attachments : undefined,
    MediaTypes: mediaKind ? [mediaKind] : undefined,
    MediaType: mediaKind,
  });

  const prefixContext = createReplyPrefixContext({ cfg, agentId: route.agentId });

  const { dispatcher, replyOptions, markDispatchIdle } =
    runtime.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: runtime.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
      deliver: async (payload: ReplyPayload) => {
        const parsedTarget = normalizeNapcatTarget(ctxPayload.To ?? to) ?? target;
        await deliverNapcatReplies({
          replies: [payload],
          target: parsedTarget,
          client,
          account,
          cfg,
          runtime,
        });
        ctx.setStatus({
          ...ctx.getStatus(),
          accountId: account.accountId,
          lastOutboundAt: Date.now(),
          lastError: null,
        });
      },
      onError: (err, info) => {
        ctx.log?.error(`napcat ${info.kind} reply failed: ${String(err)}`);
      },
    });

  // Always allow streaming by default; set channels.napcat.blockStreaming=true to disable.
  const disableBlockStreaming =
    typeof account.blockStreaming === "boolean" ? account.blockStreaming : false;

  const { queuedFinal } = await runtime.channel.reply.dispatchReplyFromConfig({
    ctx: ctxPayload,
    cfg,
    dispatcher,
    replyOptions: {
      ...replyOptions,
      disableBlockStreaming,
      onModelSelected: prefixContext.onModelSelected,
    },
  });

  markDispatchIdle();
  await dispatcher.waitForIdle();
}

async function startNapcatMonitor(ctx: ChannelGatewayContext<ResolvedNapcatAccount>) {
  const runtime = getNapcatRuntime();
  const cfg = runtime.config.loadConfig();
  const account = ctx.account;
  const client = new NapcatRpcClient({
    cliPath: account.cliPath,
    napcatUrl: account.napcatUrl,
    timeoutMs: account.timeoutMs,
    onNotification: (msg: NapcatRpcNotification) => {
      if (msg.method === "message") {
        void handleInboundNapcatMessage({
          message: (msg.params as { message?: NapcatInboundMessage })?.message ?? {},
          account,
          cfg,
          client,
          ctx,
        }).catch((err) => ctx.log?.error(`napcat inbound failed: ${String(err)}`));
      } else if (msg.method === "error") {
        ctx.log?.error(`napcat watch error ${JSON.stringify(msg.params)}`);
      }
    },
  });

  activeClients.set(account.accountId, client);
  ctx.setStatus({
    ...ctx.getStatus(),
    accountId: account.accountId,
    running: true,
    lastStartAt: Date.now(),
    lastError: null,
  });

  const abort = ctx.abortSignal;
  const onAbort = () => {
    void client.stop().catch(() => {});
  };
  abort?.addEventListener("abort", onAbort, { once: true });

  let subscriptionId: number | null = null;
  try {
    await client.start();
    const subResult = await client.request<{ subscription?: number }>("watch.subscribe", {
      napcat_url: account.napcatUrl,
      ignore_prefixes: account.ignorePrefixes,
      from_group: account.fromGroup,
      from_user: account.fromUser,
    });
    subscriptionId = subResult?.subscription ?? null;
    await client.waitForClose();
  } catch (err) {
    if (!abort?.aborted) {
      ctx.log?.error(`napcat monitor failed: ${String(err)}`);
      ctx.setStatus({
        ...ctx.getStatus(),
        accountId: account.accountId,
        running: false,
        lastError: String(err),
        lastStopAt: Date.now(),
      });
      throw err;
    }
  } finally {
    abort?.removeEventListener("abort", onAbort);
    activeClients.delete(account.accountId);
    if (subscriptionId) {
      void client
        .request("watch.unsubscribe", { subscription: subscriptionId })
        .catch(() => {});
    }
    await client.stop().catch(() => {});
    ctx.setStatus({
      ...ctx.getStatus(),
      accountId: account.accountId,
      running: false,
      lastStopAt: Date.now(),
    });
  }
}

export const napcatPlugin: ChannelPlugin<ResolvedNapcatAccount> = {
  id: "napcat",
  meta: {
    id: "napcat",
    label: "Napcat",
    selectionLabel: "Napcat",
    detailLabel: "QQ (Napcat)",
    docsPath: "/channels/napcat",
    docsLabel: "napcat",
    blurb: "Napcat bridge via nap-msg JSON-RPC.",
    quickstartAllowFrom: true,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
  },
  streaming: {
    // Minimal coalescing so interim replies flush quickly.
    blockStreamingCoalesceDefaults: { minChars: 80, idleMs: 250 },
  },
  reload: { configPrefixes: ["channels.napcat"] },
  configSchema: napcatChannelConfigSchema,
  config: {
    listAccountIds: (cfg) => listNapcatAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveNapcatAccount({ cfg, accountId }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      urlSource: account.napcatUrl ? "config/env" : "unset",
    }),
  },
  messaging: {
    normalizeTarget: (target) => normalizeNapcatTarget(target)?.id ?? target.trim(),
    targetResolver: {
      looksLikeId: (id) => Boolean(normalizeNapcatTarget(id)),
      hint: "<napcat:group:<id>|napcat:<userId>>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getNapcatRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    sendPayload: async ({ to, payload, accountId, cfg }) => {
      const runtime = getNapcatRuntime();
      const account = resolveNapcatAccount({ cfg, accountId });
      if (!account.configured) {
        throw new Error("Napcat URL not configured (set channels.napcat.url or NAPCAT_URL)");
      }
      const parsedTarget = normalizeNapcatTarget(to);
      if (!parsedTarget) {
        throw new Error(`Invalid Napcat target: ${to}`);
      }
      const { client, release } = await getClient(account);
      try {
        await deliverNapcatReplies({
          replies: [payload],
          target: parsedTarget,
          client,
          account,
          cfg,
          runtime,
        });
        return { channel: "napcat", to: parsedTarget.id };
      } finally {
        if (release) {
          await release();
        }
      }
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) return [];
        return [
          {
            channel: "napcat",
            accountId: account.accountId,
            kind: "runtime" as ChannelStatusIssue["kind"],
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
  },
  gateway: {
    startAccount: async (ctx) => {
      if (!ctx.account.configured) {
        throw new Error("Napcat URL not configured (set channels.napcat.url or NAPCAT_URL)");
      }
      await startNapcatMonitor(ctx);
    },
  },
};
