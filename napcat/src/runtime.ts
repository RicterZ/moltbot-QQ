import type { PluginRuntime } from "clawdbot/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setNapcatRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getNapcatRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Napcat runtime not initialized");
  }
  return runtime;
}
