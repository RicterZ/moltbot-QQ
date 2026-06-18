import { isAsrEnabled, sentenceRecognize } from "./asr.js";
import { createLogger, type LogSink, type NapcatLogger } from "./logger.js";
import { downloadMedia } from "./media.js";
import { type NapcatAsrConfig } from "./types.js";
import { NapcatWsClient, type NapcatEvent } from "./ws-client.js";

// QQ message segment types
type NapcatSegmentType =
  | "text"
  | "at"
  | "face"
  | "image"
  | "video"
  | "file"
  | "record"
  | "json"
  | string;

interface NapcatSegment {
  type: NapcatSegmentType;
  data?: Record<string, unknown>;
  sub_type?: number | string;
}

interface NapcatMessageEvent {
  post_type: "message";
  message_type?: string;
  sub_type?: number | string;
  user_id?: number | string | null;
  group_id?: number | string | null;
  message_id?: number | string | null;
  message?: NapcatSegment[] | string;
  text?: string;
  images?: string[];
  videos?: string[];
  files?: string[];
  [key: string]: unknown;
}

export type WatchedMessage = {
  /** Sending user's QQ number */
  sender: string | number | undefined;
  /** Chat ID: group_id for groups, user_id for private */
  chatId: string | number | undefined;
  isGroup: boolean;
  /** Text content with timestamp prefix */
  text: string;
  /** Unique message ID */
  messageId: string | number | undefined;
  images?: string[];
  videos?: string[];
  files?: string[];
};

export type WatchForeverOptions = {
  url: string;
  timeoutMs?: number;
  fromGroup?: string[] | null;
  fromUser?: string[] | null;
  ignorePrefixes?: string[];
  /** ASR config — when provided, voice messages are transcribed via Tencent Cloud */
  asr?: NapcatAsrConfig;
  /** Absolute base directory for downloaded media (e.g. `<workspace>/data/tmp/napcat`). */
  mediaDirRoot: string;
  /** Called for each well-formed inbound message */
  onMessage: (msg: WatchedMessage) => void | Promise<void>;
  /**
   * Called each time a new WS connection is established (including reconnects).
   * The provided client is the live connection and can be used for outbound requests.
   * Called with null when the connection closes.
   */
  onConnect?: (client: NapcatWsClient | null) => void;
  /** AbortSignal to stop watching */
  abortSignal?: AbortSignal;
  /** Log sink from ctx.log — enables structured, leveled output. */
  log?: LogSink;
};

const PASSTHROUGH_COMMANDS = new Set(["/new", "/reset"]);

function isPassthroughCommand(text: string): boolean {
  return PASSTHROUGH_COMMANDS.has(text.trim());
}

/**
 * Format a timestamp for the text prefix, e.g. "[Wed 2026-03-13 10:00 GMT+8]".
 */
function formatTimestamp(): string {
  const now = new Date();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayName = days[now.getDay()];
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const offsetMinutes = -now.getTimezoneOffset();
  const offsetHours = Math.trunc(offsetMinutes / 60);
  const sign = offsetHours >= 0 ? "+" : "-";
  return `${dayName} ${year}-${month}-${day} ${hours}:${minutes} GMT${sign}${Math.abs(offsetHours)}`;
}

/**
 * Parse a QQ JSON card segment (e.g. shared links) into a human-readable string.
 */
function parseJsonCard(segData: Record<string, unknown>): string | null {
  const raw = segData["data"];
  if (typeof raw !== "string") return null;

  let card: Record<string, unknown>;
  try {
    card = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const parts: string[] = [];
  const meta = card["meta"] as Record<string, unknown> | undefined;
  const news = meta?.["news"] as Record<string, unknown> | undefined;

  const title = ((news?.["title"] ?? "") as string).trim();
  const desc = ((news?.["desc"] ?? "") as string).trim();
  const jumpUrl = ((news?.["jumpUrl"] ?? "") as string).trim();
  const tag = ((news?.["tag"] ?? "") as string).trim();
  const prompt = ((card["prompt"] ?? "") as string).trim();

  if (title) parts.push(`标题: ${title}`);
  if (desc) parts.push(`描述: ${desc}`);
  if (tag) parts.push(`来源: ${tag}`);
  if (jumpUrl) parts.push(`链接: ${jumpUrl}`);
  if (parts.length === 0 && prompt) parts.push(prompt);

  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Fetch a voice recording via get_record API and return raw audio bytes.
 * Returns null if the call fails or returns no data.
 */
async function fetchVoice(
  filePath: string,
  client: NapcatWsClient,
  log: NapcatLogger,
): Promise<Buffer | null> {
  try {
    log.debug(`get_record for file=${filePath}`);
    const result = await client.request<Record<string, unknown>>(
      "get_record",
      { file: filePath, out_format: "mp3" },
      { timeoutMs: 10_000 },
    );
    const b64 = result?.["base64"] as string | undefined;
    if (!b64) {
      log.warn(`get_record returned no base64 data for file=${filePath}`);
      return null;
    }
    const buf = Buffer.from(b64, "base64");
    log.debug(`get_record ok: ${buf.length} bytes`);
    return buf;
  } catch (err) {
    log.error(`get_record failed for file=${filePath}: ${String(err)}`);
    return null;
  }
}

/**
 * Look up a referenced message by ID via get_msg API.
 * Returns null if lookup fails or returns empty text.
 */
async function fetchReferencedMessage(
  messageId: string,
  client: NapcatWsClient,
  log: NapcatLogger,
): Promise<{ senderId: string; senderNick: string; text: string } | null> {
  log.debug(`Fetching referenced message_id=${messageId}`);
  try {
    const resp = await client.request<Record<string, unknown>>(
      "get_msg",
      { message_id: Number(messageId) },
      { timeoutMs: 5_000 },
    );

    const sender = (resp?.["sender"] ?? {}) as Record<string, unknown>;
    const senderId = String(sender["user_id"] ?? "unknown");
    const senderNick = String(sender["nickname"] ?? senderId);

    // 优先使用 raw_message（纯文本），降级到递归解析 message 段
    let text: string;
    const rawMessage = resp?.["raw_message"];
    if (typeof rawMessage === "string" && rawMessage.trim()) {
      // raw_message 可能含 CQ 码，提取纯文本部分
      text = rawMessage.replace(/\[CQ:[^\]]*\]/g, "").trim();
    } else {
      // 降级：从 message 段提取 text 类型
      const segments = resp?.["message"];
      if (Array.isArray(segments)) {
        text = (segments as NapcatSegment[])
          .filter((s) => s.type === "text")
          .map((s) => String((s.data?.["text"] ?? "")))
          .join("")
          .trim();
      } else {
        text = "";
      }
    }

    if (!text) {
      log.debug(`get_msg returned empty text for message_id=${messageId}`);
      return null;
    }

    return { senderId, senderNick, text };
  } catch (err) {
    log.warn(`get_msg failed for message_id=${messageId}: ${String(err)}`);
    return null;
  }
}

/**
 * Parse the message array from a Napcat event and extract:
 *  - plain text (concatenated from text/json/record/asr segments)
 *  - media paths (images, videos, files)
 */
async function extractMessageContent(
  event: NapcatMessageEvent,
  client: NapcatWsClient,
  asr: NapcatAsrConfig | undefined,
  mediaDirRoot: string,
  log: NapcatLogger,
): Promise<{
  textContent: string | null;
  media: { images: string[]; videos: string[]; files: string[] };
}> {
  const message = event.message;
  const media = { images: [] as string[], videos: [] as string[], files: [] as string[] };

  if (typeof message === "string") {
    return { textContent: message, media };
  }
  if (!Array.isArray(message)) {
    return { textContent: null, media };
  }

  const textParts: string[] = [];
  let recordText: string | null = null;
  let replySegmentId: string | null = null;

  for (const item of message as NapcatSegment[]) {
    if (typeof item !== "object" || item === null) continue;

    const segType = item.type ?? "";
    const segData = (item.data ?? {}) as Record<string, unknown>;

    // sub_type 1 = emoji/face — skip
    const rawSubType = item.sub_type ?? segData["sub_type"] ?? 0;
    let subType: number;
    try {
      subType = Number(rawSubType);
    } catch {
      subType = 0;
    }
    if (subType === 1) continue;

    if (segType === "reply") {
      const refId = segData["id"];
      if (typeof refId === "string" || typeof refId === "number") {
        replySegmentId = String(refId);
      }
      continue;
    }

    if (segType === "at" || segType === "face") continue;

    if (segType === "text") {
      const txt = segData["text"];
      if (typeof txt === "string") textParts.push(txt);
    } else if (segType === "json") {
      const cardText = parseJsonCard(segData);
      if (cardText) textParts.push(cardText);
    } else if (segType === "record" && recordText === null) {
      const recPath = segData["file"];
      if (typeof recPath === "string" && recPath.trim()) {
        if (asr && isAsrEnabled(asr)) {
          const audioBytes = await fetchVoice(recPath.trim(), client, log);
          if (audioBytes) {
            try {
              recordText = await sentenceRecognize(audioBytes, "mp3", asr, log);
            } catch (err) {
              log.warn(`ASR failed: ${String(err)}`);
              recordText = null;
            }
          }
        } else {
          log.debug(`record segment skipped (ASR not configured), file=${recPath}`);
        }
      }
    } else if (segType === "image" || segType === "video" || segType === "file") {
      const url = (segData["url"] ?? "") as string;
      if (!url) {
        log.debug(`${segType} segment has no url, skipping`);
        continue;
      }
      const localPath = await downloadMedia(
        url,
        segType as "image" | "video" | "file",
        mediaDirRoot,
        log,
      );
      if (localPath) {
        if (segType === "image") media.images.push(localPath);
        else if (segType === "video") media.videos.push(localPath);
        else media.files.push(localPath);
      }
    }
  }

  if (recordText) textParts.push(recordText);

  // 解析引用消息，拼到文本最前面
  if (replySegmentId) {
    const ref = await fetchReferencedMessage(replySegmentId, client, log);
    if (ref) {
      const refLine = ref.text
        .split("\n")
        .map((line, i) =>
          i === 0 ? `> 引用 ${ref.senderNick}(${ref.senderId}): ${line}` : `> ${line}`,
        )
        .join("\n");
      textParts.unshift(refLine, "");
    }
  }

  const cleaned = textParts
    .filter((line, i) => (line && line.trim()) || (i > 0 && textParts[i - 1]?.startsWith(">")))
    .map((line) => line.trim())
    .join("\n");

  return { textContent: cleaned || null, media };
}

/**
 * Normalize a raw Napcat message event into the shape expected by channel.ts.
 */
function eventToWatchedMessage(
  event: NapcatMessageEvent,
  textContent: string | null,
  media: { images: string[]; videos: string[]; files: string[] },
): WatchedMessage {
  const messageType = String(event.message_type ?? "").toLowerCase();
  const groupId = event.group_id;
  const userId = event.user_id;

  const hasGroupId =
    groupId !== undefined &&
    groupId !== null &&
    String(groupId).trim() !== "" &&
    String(groupId).trim() !== "0";
  const isGroup = messageType === "group" || hasGroupId;
  const chatId = isGroup ? groupId : userId;

  const timestamp = formatTimestamp();
  const text = textContent
    ? `[${timestamp}]\n${textContent}`
    : `[${timestamp}]`;

  return {
    sender: userId ?? undefined,
    chatId: chatId ?? undefined,
    isGroup,
    text,
    messageId: event.message_id ?? undefined,
    images: media.images.length > 0 ? media.images : undefined,
    videos: media.videos.length > 0 ? media.videos : undefined,
    files: media.files.length > 0 ? media.files : undefined,
  };
}

/**
 * Connect to Napcat WebSocket, listen for messages, apply filters, and call
 * `opts.onMessage` for each accepted message.
 *
 * Automatically reconnects after a 3-second delay on connection loss.
 * Respects `opts.abortSignal` for clean shutdown.
 */
export async function watchForever(opts: WatchForeverOptions): Promise<void> {
  const {
    url,
    timeoutMs,
    fromGroup,
    fromUser,
    ignorePrefixes = ["/"],
    asr,
    mediaDirRoot,
    onMessage,
    onConnect,
    abortSignal,
  } = opts;

  const log = createLogger("watcher", opts.log);

  while (true) {
    if (abortSignal?.aborted) return;

    // Promise that resolves when the WS connection closes
    let resolveClose!: () => void;
    const closedPromise = new Promise<void>((res) => {
      resolveClose = res;
    });

    const client = new NapcatWsClient({
      url,
      timeoutMs,
      log: opts.log,
      onClose: () => {
        onConnect?.(null);
        resolveClose();
      },
      onEvent: (event: NapcatEvent) => {
        // Fire-and-forget; errors are logged inside
        void processEvent(event as NapcatMessageEvent, client).catch((err) => {
          log.error(`processEvent error: ${String(err)}`);
        });
      },
    });

    async function processEvent(
      event: NapcatMessageEvent,
      wsClient: NapcatWsClient,
    ): Promise<void> {
      if (event.post_type !== "message") return;

      const msgId = event.message_id ?? "?";
      const userId = event.user_id ?? "?";
      const groupId = event.group_id;
      const origin = groupId ? `group=${groupId} user=${userId}` : `user=${userId}`;
      log.debug(`Inbound message id=${msgId} from ${origin}`);

      // Group filter
      if (fromGroup?.length && !fromGroup.includes(String(event.group_id))) {
        log.debug(`Skipped: group_id=${event.group_id} not in fromGroup=[${fromGroup}]`);
        return;
      }
      // User filter
      if (fromUser?.length && !fromUser.includes(String(event.user_id))) {
        log.debug(`Skipped: user_id=${event.user_id} not in fromUser=[${fromUser}]`);
        return;
      }

      const { textContent, media } = await extractMessageContent(
        event,
        wsClient,
        asr,
        mediaDirRoot,
        log,
      );

      const hasMedia =
        media.images.length > 0 ||
        media.videos.length > 0 ||
        media.files.length > 0;

      // Prefix filter
      if (textContent) {
        const firstLine =
          textContent.split("\n").find((ln) => ln.trim() && !ln.startsWith("> 引用 ")) ?? textContent;
        const checkText = firstLine.trimStart();
        if (
          ignorePrefixes.length > 0 &&
          !isPassthroughCommand(checkText) &&
          ignorePrefixes.some((pfx) => checkText.startsWith(pfx))
        ) {
          log.debug(`Skipped: text starts with ignored prefix (text="${checkText.slice(0, 40)}")`);
          return;
        }
      }

      if (!textContent && !hasMedia) {
        log.debug(`Skipped: empty content (no text, no media)`);
        return;
      }

      log.debug(
        `Accepted message id=${msgId} from ${origin}` +
        (textContent ? ` text="${textContent.slice(0, 60).replace(/\n/g, "↵")}"` : "") +
        (hasMedia ? ` media=[${[...media.images, ...media.videos, ...media.files].join(", ")}]` : ""),
      );

      const msg = eventToWatchedMessage(event, textContent, media);

      try {
        const result = onMessage(msg);
        if (result instanceof Promise) await result;
      } catch (err) {
        log.warn(`onMessage failed: ${String(err)}`);
      }
    }

    try {
      log.debug(`Connecting to ${url}`);
      await client.connect();
      // Notify caller that a live client is now available for outbound sends
      onConnect?.(client);

      // Wait until the WS closes or abort is signalled
      await Promise.race([
        closedPromise,
        new Promise<void>((resolve) => {
          abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
    } catch (err) {
      if (abortSignal?.aborted) return;
      log.warn(`Watch loop error: ${String(err)}, reconnecting in 3s`);
    } finally {
      await client.disconnect().catch(() => {});
    }

    if (abortSignal?.aborted) return;
    log.debug("Waiting 3s before reconnecting...");
    // Wait 3 seconds before reconnecting
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      abortSignal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
