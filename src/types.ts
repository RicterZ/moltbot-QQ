import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

/** Matches BlockStreamingCoalesceConfig from openclaw core config types. */
export type BlockStreamingCoalesceConfig = {
  minChars?: number;
  idleMs?: number;
};

export type NapcatTextSplitConfig = {
  enabled?: boolean;
  minDelayMs?: number;
  maxDelayMs?: number;
};

export type ResolvedNapcatTextSplitConfig = {
  enabled: boolean;
  minDelayMs: number;
  maxDelayMs: number;
};

export type NapcatReplyToMode = "off" | "first" | "all" | "batched";

export type NapcatAsrConfig = {
  secretId: string;
  secretKey: string;
  region?: string;
  engine?: string;
};

export type NapcatAccountConfig = {
  name?: string;
  enabled?: boolean;
  url?: string;
  timeoutMs?: number;
  ignorePrefixes?: string[];
  fromGroup?: string | number | (string | number)[];
  fromUser?: string | number | (string | number)[];
  blockStreaming?: boolean;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  replyToMode?: NapcatReplyToMode;
  textSplit?: NapcatTextSplitConfig;
  asr?: NapcatAsrConfig;
};

export type NapcatRootConfig = NapcatAccountConfig & {
  accounts?: Record<string, NapcatAccountConfig>;
};

export type ResolvedNapcatAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  napcatUrl?: string;
  timeoutMs?: number;
  ignorePrefixes: string[];
  fromGroup?: string[];
  fromUser?: string[];
  blockStreaming?: boolean;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  replyToMode: NapcatReplyToMode;
  textSplit: ResolvedNapcatTextSplitConfig;
  asr?: NapcatAsrConfig;
};

function normalizeIds(value?: string | number | (string | number)[]): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const arr = Array.isArray(value) ? value : [value];
  const cleaned = arr.map((v) => String(v).trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

function normalizePrefixes(prefixes?: string[]): string[] {
  if (!Array.isArray(prefixes)) return ["/"];
  const cleaned = prefixes.map((p) => p.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : ["/"];
}

function normalizeAsr(asr?: NapcatAsrConfig): NapcatAsrConfig | undefined {
  if (!asr) return undefined;
  const secretId = asr.secretId?.trim() ?? "";
  const secretKey = asr.secretKey?.trim() ?? "";
  if (!secretId || !secretKey) return undefined;
  return {
    secretId,
    secretKey,
    region: asr.region?.trim() || undefined,
    engine: asr.engine?.trim() || undefined,
  };
}

function normalizeDelayMs(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

function normalizeTextSplit(textSplit?: NapcatTextSplitConfig): ResolvedNapcatTextSplitConfig {
  const minDelayMs = normalizeDelayMs(textSplit?.minDelayMs, 1000);
  const maxDelayMs = normalizeDelayMs(textSplit?.maxDelayMs, 3000);
  return {
    enabled: textSplit?.enabled ?? true,
    minDelayMs: Math.min(minDelayMs, maxDelayMs),
    maxDelayMs: Math.max(minDelayMs, maxDelayMs),
  };
}

export function listNapcatAccountIds(cfg: OpenClawConfig): string[] {
  const napcatCfg = (cfg.channels?.napcat ?? {}) as NapcatRootConfig;
  const ids = new Set<string>([DEFAULT_ACCOUNT_ID]);
  Object.keys(napcatCfg.accounts ?? {}).forEach((id) => ids.add(id));
  return Array.from(ids);
}

export function resolveNapcatAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedNapcatAccount {
  const napcatCfg = (params.cfg.channels?.napcat ?? {}) as NapcatRootConfig;
  const resolvedId = params.accountId ?? DEFAULT_ACCOUNT_ID;
  const { accounts: _ignoredAccounts, ...baseCfg } = napcatCfg;
  const accountCfg =
    resolvedId === DEFAULT_ACCOUNT_ID ? baseCfg : (napcatCfg.accounts?.[resolvedId] ?? {});

  const merged: NapcatAccountConfig = {
    ...baseCfg,
    ...accountCfg,
  };

  const napcatUrl = merged.url?.trim() || undefined;

  return {
    accountId: resolvedId,
    name: merged.name ?? resolvedId,
    enabled: merged.enabled ?? true,
    configured: Boolean(napcatUrl),
    napcatUrl,
    timeoutMs: merged.timeoutMs,
    ignorePrefixes: normalizePrefixes(merged.ignorePrefixes),
    fromGroup: normalizeIds(merged.fromGroup),
    fromUser: normalizeIds(merged.fromUser),
    blockStreaming: merged.blockStreaming,
    blockStreamingCoalesce: merged.blockStreamingCoalesce,
    replyToMode: merged.replyToMode ?? "off",
    textSplit: normalizeTextSplit(merged.textSplit),
    asr: normalizeAsr(merged.asr),
  };
}
