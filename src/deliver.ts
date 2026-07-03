import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ChunkMode, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { readFile } from "node:fs/promises";

import type { NapcatLogger } from "./logger.js";
import type { NapcatWsClient } from "./ws-client.js";
import type { ResolvedNapcatAccount, ResolvedNapcatTextSplitConfig } from "./types.js";

export type NapcatTarget = {
  channel: "group" | "private";
  id: string;
};

export type DeliverNapcatParams = {
  replies: ReplyPayload[];
  target: NapcatTarget;
  client: NapcatWsClient;
  account: ResolvedNapcatAccount;
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  abortSignal?: AbortSignal;
  log?: NapcatLogger;
  waitForSend?: boolean;
};

type NapcatSegment =
  | { type: "text"; data: { text: string } }
  | { type: "reply"; data: { id: string } }
  | { type: "image" | "video" | "file"; data: { file: string } };

type QueuedNapcatMessage = {
  client: NapcatWsClient;
  account: ResolvedNapcatAccount;
  target: NapcatTarget;
  segments: NapcatSegment[];
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  log?: NapcatLogger;
  delayBeforeMs: number;
  delayLogMessage?: string;
};

type ScheduledNapcatMessage = QueuedNapcatMessage & {
  resolve: () => void;
  reject: (err: unknown) => void;
};

type TargetSchedulerState = {
  queue: ScheduledNapcatMessage[];
  running: boolean;
  currentSleepStartedAt?: number;
  lastExternalEnqueueAt?: number;
};

const targetSchedulers = new Map<string, TargetSchedulerState>();

function inferMediaType(url: string): "image" | "video" | "file" {
  const lower = url.toLowerCase();
  if (lower.match(/\.(png|jpe?g|gif|webp|avif)(\?|$)/)) return "image";
  if (lower.match(/\.(mp4|mov|mkv|webm)(\?|$)/)) return "video";
  return "file";
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (!abortSignal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (abortSignal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(timeout);
      abortSignal.removeEventListener("abort", finish);
      resolve();
    };
    timeout = setTimeout(finish, ms);
    abortSignal.addEventListener("abort", finish, { once: true });
  });
}

function randomDelayMs(config: ResolvedNapcatTextSplitConfig): number {
  if (config.maxDelayMs <= config.minDelayMs) return config.minDelayMs;
  return Math.floor(
    config.minDelayMs + Math.random() * (config.maxDelayMs - config.minDelayMs + 1),
  );
}

function formatTarget(target: NapcatTarget): string {
  return target.channel === "group" ? `group:${target.id}` : `private:${target.id}`;
}

function schedulerKey(account: ResolvedNapcatAccount, target: NapcatTarget): string {
  return `${account.accountId}:${target.channel}:${target.id}`;
}

function splitTextSections(text: string, config: ResolvedNapcatTextSplitConfig): string[] {
  if (!text.trim()) return [];
  if (!config.enabled) return [text];
  return text
    .split(/\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Napcat requires media file references to be valid URIs (http://, file://, base64://).
 * For local paths (e.g. /tmp/foo.png), read the file and encode as base64:// so that
 * Napcat receives the raw bytes — the Napcat server may be a remote container that has
 * no access to this machine's filesystem.
 */
async function toNapcatFileRef(url: string, abortSignal?: AbortSignal): Promise<string> {
  if (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("file://") ||
    url.startsWith("base64://")
  ) {
    return url;
  }
  // Treat anything starting with / as an absolute local path — encode to base64
  if (url.startsWith("/")) {
    const buf = abortSignal
      ? await readFile(url, { signal: abortSignal })
      : await readFile(url);
    return `base64://${buf.toString("base64")}`;
  }
  return url;
}

async function sendNapcatMessage(opts: {
  client: NapcatWsClient;
  account: ResolvedNapcatAccount;
  target: NapcatTarget;
  segments: NapcatSegment[];
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<void> {
  if (opts.abortSignal?.aborted) return;
  if (opts.segments.length === 0) return;
  const action =
    opts.target.channel === "group" ? "send_group_msg" : "send_private_msg";
  const params: Record<string, unknown> = {
    message: opts.segments,
  };
  if (opts.target.channel === "group") {
    params["group_id"] = opts.target.id;
  } else {
    params["user_id"] = opts.target.id;
  }
  if (opts.abortSignal?.aborted) return;
  await opts.client.request(action, params, { timeoutMs: opts.timeoutMs });
}

async function runTargetScheduler(key: string, state: TargetSchedulerState): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    while (state.queue.length > 0) {
      const item = state.queue.shift();
      if (!item) continue;
      try {
        if (item.abortSignal?.aborted) {
          item.resolve();
          continue;
        }
        if (item.delayBeforeMs > 0) {
          item.log?.info(
            item.delayLogMessage ??
              `Outbound scheduler sleep ${item.delayBeforeMs}ms before send to ` +
                `${formatTarget(item.target)}`,
          );
          state.currentSleepStartedAt = Date.now();
          await sleep(item.delayBeforeMs, item.abortSignal);
          state.currentSleepStartedAt = undefined;
          if (item.abortSignal?.aborted) {
            item.resolve();
            continue;
          }
        }
        await sendNapcatMessage(item);
        item.resolve();
      } catch (err) {
        state.currentSleepStartedAt = undefined;
        item.reject(err);
      }
    }
  } finally {
    state.running = false;
    state.currentSleepStartedAt = undefined;
    if (state.queue.length > 0) {
      void runTargetScheduler(key, state);
    } else if (targetSchedulers.get(key) === state) {
      targetSchedulers.delete(key);
    }
  }
}

function enqueueNapcatMessages(opts: {
  messages: QueuedNapcatMessage[];
  log?: NapcatLogger;
}): Promise<void> {
  if (opts.messages.length === 0) return Promise.resolve();
  const first = opts.messages[0];
  const key = schedulerKey(first.account, first.target);
  const state = targetSchedulers.get(key) ?? { queue: [], running: false };
  targetSchedulers.set(key, state);

  const now = Date.now();
  if (state.currentSleepStartedAt !== undefined && first.delayBeforeMs === 0) {
    const preservedDelayMs = Math.max(
      0,
      now - (state.lastExternalEnqueueAt ?? state.currentSleepStartedAt),
    );
    if (preservedDelayMs > 0) {
      first.delayBeforeMs = preservedDelayMs;
      first.delayLogMessage =
        `Outbound scheduler preserving ${preservedDelayMs}ms natural delay before ` +
        `queued payload to ${formatTarget(first.target)}`;
    }
  }
  state.lastExternalEnqueueAt = now;

  const promises = opts.messages.map(
    (message) =>
      new Promise<void>((resolve, reject) => {
        state.queue.push({ ...message, log: message.log ?? opts.log, resolve, reject });
      }),
  );
  void runTargetScheduler(key, state);
  return Promise.all(promises).then(() => undefined);
}

function pushTextSectionMessages(opts: {
  sections: string[];
  includeReply: boolean;
  replyToId?: string;
  target: NapcatTarget;
  client: NapcatWsClient;
  account: ResolvedNapcatAccount;
  chunkText: (text: string) => string[];
  abortSignal?: AbortSignal;
  messages: QueuedNapcatMessage[];
}): boolean {
  let replySent = false;
  for (let sectionIndex = 0; sectionIndex < opts.sections.length; sectionIndex += 1) {
    if (opts.abortSignal?.aborted) return replySent;
    const delayBeforeMs = sectionIndex > 0 ? randomDelayMs(opts.account.textSplit) : 0;
    const section = opts.sections[sectionIndex] ?? "";
    const chunks = opts.chunkText(section);
    const sectionChunks = chunks.length > 0 ? chunks : [section];
    for (let chunkIndex = 0; chunkIndex < sectionChunks.length; chunkIndex += 1) {
      if (opts.abortSignal?.aborted) return replySent;
      const chunk = sectionChunks[chunkIndex] ?? "";
      const segments: NapcatSegment[] = [];
      if (opts.includeReply && !replySent && opts.replyToId) {
        segments.push({ type: "reply", data: { id: opts.replyToId } });
        replySent = true;
      }
      if (chunk.trim()) {
        segments.push({ type: "text", data: { text: chunk } });
      }
      opts.messages.push({
        client: opts.client,
        account: opts.account,
        target: opts.target,
        segments,
        timeoutMs: opts.account.timeoutMs,
        abortSignal: opts.abortSignal,
        delayBeforeMs: chunkIndex === 0 ? delayBeforeMs : 0,
        delayLogMessage:
          sectionIndex > 0 && chunkIndex === 0
            ? `Text split sleep ${delayBeforeMs}ms before section ` +
              `${sectionIndex + 1}/${opts.sections.length} to ${formatTarget(opts.target)}`
            : undefined,
      });
    }
  }
  return replySent;
}

export async function deliverNapcatReplies(params: DeliverNapcatParams): Promise<void> {
  const { replies, target, client, account, cfg, runtime, abortSignal, log } = params;
  if (abortSignal?.aborted) return;
  const tableMode = runtime.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "napcat",
    accountId: account.accountId,
  });
  const chunkMode: ChunkMode = runtime.channel.text.resolveChunkMode(
    cfg,
    "napcat",
    account.accountId,
  );
  const chunkLimit =
    runtime.channel.text.resolveTextChunkLimit(cfg, "napcat", account.accountId) ?? 4000;
  const queuedMessages: QueuedNapcatMessage[] = [];

  for (const reply of replies) {
    if (abortSignal?.aborted) return;
    const mediaList = reply.mediaUrls ?? (reply.mediaUrl ? [reply.mediaUrl] : []);
    const rawText = reply.text ?? "";
    const convertedText = runtime.channel.text.convertMarkdownTables(rawText, tableMode);
    const textSections = splitTextSections(convertedText, account.textSplit);
    const chunkText = (text: string) =>
      runtime.channel.text.chunkMarkdownTextWithMode(text, chunkLimit, chunkMode);
    let includeReply = Boolean(reply.replyToId);

    if (mediaList.length === 0) {
      if (textSections.length === 0) {
        const segments: NapcatSegment[] = [];
        if (includeReply && reply.replyToId) {
          segments.push({ type: "reply", data: { id: reply.replyToId } });
          includeReply = false;
        }
        queuedMessages.push({
          client,
          account,
          target,
          segments,
          timeoutMs: account.timeoutMs,
          abortSignal,
          delayBeforeMs: 0,
        });
      } else {
        pushTextSectionMessages({
          sections: textSections,
          includeReply,
          replyToId: reply.replyToId,
          target,
          client,
          account,
          chunkText,
          abortSignal,
          messages: queuedMessages,
        });
      }
      continue;
    }

    const leadingTextSections = textSections.length > 1 ? textSections.slice(0, -1) : [];
    const mediaText = textSections.length > 1
      ? textSections[textSections.length - 1]
      : convertedText;
    if (leadingTextSections.length > 0) {
      const replySent = pushTextSectionMessages({
        sections: leadingTextSections,
        includeReply,
        replyToId: reply.replyToId,
        target,
        client,
        account,
        chunkText,
        abortSignal,
        messages: queuedMessages,
      });
      if (replySent) includeReply = false;
    }

    for (let mediaIndex = 0; mediaIndex < mediaList.length; mediaIndex += 1) {
      if (abortSignal?.aborted) return;
      const url = mediaList[mediaIndex];
      if (!url) continue;
      const isFirstMedia = mediaIndex === 0;
      const segments: NapcatSegment[] = [];
      if (includeReply && reply.replyToId) {
        segments.push({ type: "reply", data: { id: reply.replyToId } });
        includeReply = false;
      }
      if (isFirstMedia && mediaText.trim()) {
        segments.push({ type: "text", data: { text: mediaText } });
      }
      const mediaType = inferMediaType(url);
      const delayBeforeMs =
        isFirstMedia && leadingTextSections.length > 0 ? randomDelayMs(account.textSplit) : 0;
      try {
        segments.push({
          type: mediaType,
          data: { file: await toNapcatFileRef(url, abortSignal) },
        });
      } catch (err) {
        if (abortSignal?.aborted || isAbortError(err)) return;
        throw err;
      }
      queuedMessages.push({
        client,
        account,
        target,
        segments,
        timeoutMs: account.timeoutMs,
        abortSignal,
        delayBeforeMs,
        delayLogMessage:
          delayBeforeMs > 0
            ? `Text split sleep ${delayBeforeMs}ms before media payload to ` +
              `${formatTarget(target)}`
            : undefined,
      });
    }
  }

  const scheduled = enqueueNapcatMessages({ messages: queuedMessages, log });
  if (params.waitForSend ?? true) {
    await scheduled;
  } else {
    scheduled.catch((err) => {
      if (abortSignal?.aborted || isAbortError(err)) return;
      log?.error(`Outbound scheduler failed: ${String(err)}`);
    });
  }
}
