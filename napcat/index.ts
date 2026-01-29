import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import { napcatPlugin } from "./src/channel.js";
import { setNapcatRuntime } from "./src/runtime.js";

const plugin = {
  id: "napcat",
  name: "Napcat",
  description: "Napcat channel plugin (JSON-RPC over stdin/stdout)",
  configSchema: emptyPluginConfigSchema(),
  register(api: ClawdbotPluginApi) {
    setNapcatRuntime(api.runtime);
    api.registerChannel({ plugin: napcatPlugin });
  },
};

export default plugin;
