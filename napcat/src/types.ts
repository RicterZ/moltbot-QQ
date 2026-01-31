import type { BlockStreamingCoalesceConfig, OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";

export type NapcatAccountConfig = {
  name?: string;
  enabled?: boolean;
  url?: string;
  cliPath?: string;
  timeoutMs?: number;
  ignorePrefixes?: string[];
  fromGroup?: string | number;
  fromUser?: string | number;
  blockStreaming?: boolean;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  env?: Record<string, string>;
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
  cliPath?: string;
  timeoutMs?: number;
  ignorePrefixes: string[];
  fromGroup?: string;
  fromUser?: string;
  blockStreaming?: boolean;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  env?: Record<string, string>;
};

function normalizeId(value?: string | number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function normalizePrefixes(prefixes?: string[]): string[] {
  if (!Array.isArray(prefixes)) return ["/"];
  const cleaned = prefixes.map((p) => p.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : ["/"];
}

export function listNapcatAccountIds(cfg: OpenClawConfig): string[] {
  const napcatCfg = (cfg.channels?.napcat ?? {}) as NapcatRootConfig;
  const ids = new Set<string>([DEFAULT_ACCOUNT_ID]);
  Object.keys(napcatCfg.accounts ?? {}).forEach((id) => ids.add(id));
    return Array.from(ids);
}

function normalizeEnv(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env || typeof env !== "object") return undefined;
  const entries = Object.entries(env)
    .map(([k, v]) => [String(k).trim(), String(v).trim()] as [string, string])
    .filter(([k, v]) => k && v);
  return entries.length ? Object.fromEntries(entries) : undefined;
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

  const napcatUrl = merged.url?.trim() || process.env.NAPCAT_URL?.trim() || undefined;

  return {
    accountId: resolvedId,
    name: merged.name ?? resolvedId,
    enabled: merged.enabled ?? true,
    configured: Boolean(napcatUrl),
    napcatUrl,
    cliPath: merged.cliPath?.trim() || undefined,
    timeoutMs: merged.timeoutMs,
    ignorePrefixes: normalizePrefixes(merged.ignorePrefixes),
    fromGroup: normalizeId(merged.fromGroup),
    fromUser: normalizeId(merged.fromUser),
    blockStreaming: merged.blockStreaming,
    blockStreamingCoalesce: merged.blockStreamingCoalesce,
    env: normalizeEnv(merged.env),
  };
}
