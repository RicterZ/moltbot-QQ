import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ChunkMode, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

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
};

type NapcatSegment =
  | { type: "text"; data: { text: string } }
  | { type: "reply"; data: { id: string } }
  | { type: "image" | "video"; data: { file: string } }
  | { type: "file"; data: { file: string; name?: string } };

function inferMediaType(url: string): "image" | "video" | "file" {
  const lower = url.toLowerCase();
  if (lower.match(/\.(png|jpe?g|gif|webp|avif)(\?|$)/)) return "image";
  if (lower.match(/\.(mp4|mov|mkv|webm)(\?|$)/)) return "video";
  return "file";
}

/**
 * Derive a display filename for Napcat file segments.
 * base64:// payloads have no name; without `name` Napcat falls back to a UUID.
 */
function inferFileName(url: string): string | undefined {
  if (url.startsWith("base64://")) return undefined;
  try {
    if (
      url.startsWith("http://") ||
      url.startsWith("https://") ||
      url.startsWith("file://")
    ) {
      const name = decodeURIComponent(basename(new URL(url).pathname));
      return name && name !== "/" ? name : undefined;
    }
  } catch {
    // fall through for plain paths
  }
  const name = basename(url.split("?")[0] ?? url);
  return name || undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs(config: ResolvedNapcatTextSplitConfig): number {
  if (config.maxDelayMs <= config.minDelayMs) return config.minDelayMs;
  return Math.floor(
    config.minDelayMs + Math.random() * (config.maxDelayMs - config.minDelayMs + 1),
  );
}

function splitTextSections(text: string, config: ResolvedNapcatTextSplitConfig): string[] {
  if (!text.trim()) return [];
  if (!config.enabled) return [text];
  return text
    .split(/\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function stripMediaDirectiveLines(text: string): string {
  if (!text.includes("MEDIA:")) return text;
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trim().match(/^MEDIA:\s*\S+/))
    .join("\n")
    .trim();
}

/**
 * Napcat requires media file references to be valid URIs (http://, file://, base64://).
 * For local paths (e.g. /tmp/foo.png), read the file and encode as base64:// so that
 * Napcat receives the raw bytes — the Napcat server may be a remote container that has
 * no access to this machine's filesystem.
 */
async function toNapcatFileRef(url: string): Promise<string> {
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
    const buf = await readFile(url);
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
}): Promise<void> {
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
  await opts.client.request(action, params, { timeoutMs: opts.timeoutMs });
}

async function sendTextSections(opts: {
  sections: string[];
  includeReply: boolean;
  replyToId?: string;
  target: NapcatTarget;
  client: NapcatWsClient;
  account: ResolvedNapcatAccount;
  chunkText: (text: string) => string[];
}): Promise<boolean> {
  let replySent = false;
  for (let sectionIndex = 0; sectionIndex < opts.sections.length; sectionIndex += 1) {
    if (sectionIndex > 0) {
      await sleep(randomDelayMs(opts.account.textSplit));
    }
    const section = opts.sections[sectionIndex] ?? "";
    const chunks = opts.chunkText(section);
    for (const chunk of chunks.length > 0 ? chunks : [section]) {
      const segments: NapcatSegment[] = [];
      if (opts.includeReply && !replySent && opts.replyToId) {
        segments.push({ type: "reply", data: { id: opts.replyToId } });
        replySent = true;
      }
      if (chunk.trim()) {
        segments.push({ type: "text", data: { text: chunk } });
      }
      await sendNapcatMessage({
        client: opts.client,
        account: opts.account,
        target: opts.target,
        segments,
        timeoutMs: opts.account.timeoutMs,
      });
    }
  }
  return replySent;
}

export async function deliverNapcatReplies(params: DeliverNapcatParams): Promise<void> {
  const { replies, target, client, account, cfg, runtime } = params;
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

  for (const reply of replies) {
    const mediaList = reply.mediaUrls ?? (reply.mediaUrl ? [reply.mediaUrl] : []);
    const rawText = reply.text ?? "";
    const visibleText = stripMediaDirectiveLines(rawText);
    const convertedText = runtime.channel.text.convertMarkdownTables(visibleText, tableMode);
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
        await sendNapcatMessage({
          client,
          account,
          target,
          segments,
          timeoutMs: account.timeoutMs,
        });
      } else {
        await sendTextSections({
          sections: textSections,
          includeReply,
          replyToId: reply.replyToId,
          target,
          client,
          account,
          chunkText,
        });
      }
      continue;
    }

    const leadingTextSections = textSections.length > 1 ? textSections.slice(0, -1) : [];
    const mediaText = textSections.length > 1
      ? textSections[textSections.length - 1]
      : convertedText;
    if (leadingTextSections.length > 0) {
      const replySent = await sendTextSections({
        sections: leadingTextSections,
        includeReply,
        replyToId: reply.replyToId,
        target,
        client,
        account,
        chunkText,
      });
      if (replySent) includeReply = false;
      await sleep(randomDelayMs(account.textSplit));
    }

    let first = true;
    for (const url of mediaList) {
      const segments: NapcatSegment[] = [];
      if (includeReply && reply.replyToId) {
        segments.push({ type: "reply", data: { id: reply.replyToId } });
        includeReply = false;
      }
      if (first && mediaText.trim()) {
        segments.push({ type: "text", data: { text: mediaText } });
      }
      first = false;
      const mediaType = inferMediaType(url);
      const file = await toNapcatFileRef(url);
      if (mediaType === "file") {
        const name = inferFileName(url);
        segments.push(
          name
            ? { type: "file", data: { file, name } }
            : { type: "file", data: { file } },
        );
      } else {
        segments.push({ type: mediaType, data: { file } });
      }
      await sendNapcatMessage({
        client,
        account,
        target,
        segments,
        timeoutMs: account.timeoutMs,
      });
    }
  }
}
