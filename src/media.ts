import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { type NapcatLogger } from "./logger.js";

/**
 * Parse the filename from a Content-Disposition header value.
 * Supports RFC 5987 `filename*=utf-8''...` and plain `filename=...`.
 */
function parseContentDispositionFilename(headerValue: string | null | undefined): string | null {
  if (!headerValue) return null;
  const parts = headerValue.split(";").map((p) => p.trim()).filter(Boolean);

  // RFC 5987: filename*=utf-8''encoded-filename
  for (const part of parts) {
    if (part.toLowerCase().startsWith("filename*=")) {
      const value = part.slice("filename*=".length).trim().replace(/^"|"$/g, "");
      try {
        const encoded = value.includes("''") ? value.split("''").slice(1).join("''") : value;
        const decoded = decodeURIComponent(encoded);
        const name = decoded.split(/[\\/]/).pop() ?? "";
        if (name) return name;
      } catch {
        continue;
      }
    }
  }

  // Plain: filename=...
  for (const part of parts) {
    if (part.toLowerCase().startsWith("filename=")) {
      const value = part.slice("filename=".length).trim().replace(/^"|"$/g, "");
      const name = value.split(/[\\/]/).pop() ?? "";
      if (name) return name;
    }
  }

  return null;
}

/**
 * Determine the best file extension for a downloaded resource.
 * Priority: Content-Disposition filename → URL path extension → MIME type → ".bin"
 */
function chooseDownloadSuffix(
  urlPath: string,
  contentDisposition: string | null | undefined,
  contentType: string | null | undefined,
): string {
  // 1. Content-Disposition filename
  const dispositionName = parseContentDispositionFilename(contentDisposition);
  if (dispositionName) {
    const ext = extname(dispositionName);
    if (ext) return ext;
  }

  // 2. URL path extension
  const urlExt = extname(urlPath.split("?")[0] ?? "");
  if (urlExt) return urlExt;

  // 3. MIME type
  if (contentType) {
    const mime = contentType.split(";")[0].trim();
    const mimeMap: Record<string, string> = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/avif": ".avif",
      "video/mp4": ".mp4",
      "video/webm": ".webm",
      "video/quicktime": ".mov",
      "audio/mpeg": ".mp3",
      "audio/ogg": ".ogg",
      "audio/wav": ".wav",
      "audio/mp4": ".m4a",
      "audio/aac": ".aac",
      "audio/opus": ".opus",
      "application/pdf": ".pdf",
      "application/zip": ".zip",
      "application/octet-stream": ".bin",
    };
    if (mimeMap[mime]) return mimeMap[mime];
  }

  return ".bin";
}

/**
 * Download a media URL to the local filesystem.
 * Files are stored under `<mediaDirRoot>/<mediaType>/<YYYY-MM>/<uuid><ext>`.
 *
 * @param mediaDirRoot – Absolute base directory for media storage
 *   (e.g. `<workspaceDir>/data/tmp/napcat`).
 * @returns Absolute path to the saved file, or null on failure.
 */
export async function downloadMedia(
  url: string,
  mediaType: "image" | "video" | "file",
  mediaDirRoot: string,
  log?: NapcatLogger,
): Promise<string | null> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    log?.warn(`downloadMedia: invalid URL: ${url}`);
    return null;
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    log?.warn(`downloadMedia: unsupported scheme "${parsedUrl.protocol}" for ${url}`);
    return null;
  }

  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const baseDir = join(mediaDirRoot, mediaType, month);

  try {
    await mkdir(baseDir, { recursive: true });
    log?.debug(`Downloading ${mediaType} from ${url}`);

    const resp = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }

    const contentDisposition = resp.headers.get("content-disposition");
    const contentType = resp.headers.get("content-type");
    const suffix = chooseDownloadSuffix(parsedUrl.pathname, contentDisposition, contentType);
    const filename = `${randomUUID().replace(/-/g, "")}${suffix}`;
    const destPath = join(baseDir, filename);

    const bytes = new Uint8Array(await resp.arrayBuffer());
    await writeFile(destPath, bytes);

    log?.info(`Downloaded ${mediaType} → ${destPath} (${bytes.length} bytes, type=${contentType ?? "?"})`);
    return destPath;
  } catch (err) {
    log?.error(`Failed to download ${mediaType} from ${url}: ${String(err)}`);
    return null;
  }
}
