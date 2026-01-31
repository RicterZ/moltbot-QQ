# openclaw-napcat

Napcat channel plugin for OpenClaw plus the `nap-msg` CLI bridge to a Napcat WebSocket backend.

## Quick Start

### Install
1) Install the OpenClaw plugin (Napcat channel):
   ```bash
   openclaw plugins install .
   ```
   This copies the plugin into `~/.openclaw/extensions/napcat` and registers it.

2) Install the nap-msg CLI (Napcat WebSocket JSON-RPC bridge):
   ```bash
   pip install .
   ```
   This provides the `nap-msg` executable used by the channel.

### Configure (OpenClaw)
In `~/.openclaw/config.json`, enable and configure the channel. Minimal example:
```json
{
  "channels": {
    "napcat": {
      "enabled": true,
      "url": "ws://<napcat-host>:<port>",
      "ignorePrefixes": ["/"]
    }
  },
  "plugins": {
    "entries": {
      "napcat": { "enabled": true }
    }
  }
}
```
Notes:
- `url`: Napcat WebSocket endpoint (or set env `NAPCAT_URL`).
- `ignorePrefixes`: optional; defaults to `["/"]` to skip slash-prefixed commands.
- Optional: `fromGroup` / `fromUser` (only listen to specific group/user), `cliPath` (path to `nap-msg`), `timeoutMs`.
- Optional `env`: map of extra environment variables passed to `nap-msg` (e.g., proxies).

After saving, restart the gateway:
```bash
openclaw gateway restart
```
