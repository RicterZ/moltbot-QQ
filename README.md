# openclaw-napcat

Napcat channel plugin for OpenClaw. Connects directly to a Napcat WebSocket server (OneBot v11) — no Python bridge required.

## Architecture

```
TypeScript Plugin (napcat/)
    ↕ WebSocket (Node.js built-in, Node 22+)
Napcat WebSocket Server (ws://napcat:3001)
```

## Quick Start

### Install

Install the OpenClaw plugin (Napcat channel):
```bash
openclaw plugins install .
```
This copies the plugin into `~/.openclaw/extensions/napcat` and registers it.

### Configure

In `~/.openclaw/config.json`, enable and configure the channel.

Minimal example (accept all messages):
```json
{
  "channels": {
    "napcat": {
      "enabled": true,
      "url": "ws://napcat:3001"
    }
  },
  "plugins": {
    "entries": {
      "napcat": { "enabled": true }
    }
  }
}
```

Single-user example (only accept messages from one QQ user):
```json
{
  "channels": {
    "napcat": {
      "enabled": true,
      "url": "ws://napcat:3001",
      "fromUser": "123456789"
    }
  },
  "plugins": {
    "entries": {
      "napcat": { "enabled": true }
    }
  }
}
```

Multi-user example (accept messages from multiple QQ users):
```json
{
  "channels": {
    "napcat": {
      "enabled": true,
      "url": "ws://napcat:3001",
      "fromUser": ["123456789", "987654321"]
    }
  },
  "plugins": {
    "entries": {
      "napcat": { "enabled": true }
    }
  }
}
```

Single-group example (only accept messages from one QQ group):
```json
{
  "channels": {
    "napcat": {
      "enabled": true,
      "url": "ws://napcat:3001",
      "fromGroup": "987654321"
    }
  },
  "messages": {
    "groupChat": {
      "visibleReplies": "automatic"
    }
  },
  "plugins": {
    "entries": {
      "napcat": { "enabled": true }
    }
  }
}
```

> **Note:** OpenClaw defaults group chat replies to `message_tool_only` (the AI must explicitly call a message tool to send). For Napcat group chats to receive automatic replies, you **must** set `messages.groupChat.visibleReplies` to `"automatic"` in your OpenClaw config.

After saving, restart the gateway:
```bash
openclaw gateway restart
```

---

## Configuration Reference

All fields can be set at the root level (applies to the default account) or inside `accounts.<id>` for multi-account setups.

### Connection

| Field | Type | Default | Description |
|---|---|---|---|
| `url` | string | — | **Required.** Napcat WebSocket endpoint, e.g. `ws://napcat:3001` |
| `timeoutMs` | number | `10000` | Per-request timeout in milliseconds |

### Message Filtering

| Field | Type | Default | Description |
|---|---|---|---|
| `ignorePrefixes` | string[] | `["/"]` | Skip messages whose first non-empty line starts with any of these prefixes. `/new` and `/reset` are always passed through regardless. Set to `[]` to disable filtering. |
| `fromGroup` | string \| string[] | — | Only accept messages from this group ID (or any group ID in the array) |
| `fromUser` | string \| string[] | — | Only accept messages from this user ID (or any user ID in the array) |

### Voice Recognition (ASR)

Voice messages are transcribed automatically when `asr` is configured. Powered by Tencent Cloud SentenceRecognition.

```json
{
  "channels": {
    "napcat": {
      "url": "ws://napcat:3001",
      "asr": {
        "secretId": "<your-tencent-secret-id>",
        "secretKey": "<your-tencent-secret-key>",
        "region": "ap-shanghai",
        "engine": "16k_zh"
      }
    }
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `asr.secretId` | string | — | **Required.** Tencent Cloud secret ID |
| `asr.secretKey` | string | — | **Required.** Tencent Cloud secret key |
| `asr.region` | string | — | API region, e.g. `ap-shanghai` (optional) |
| `asr.engine` | string | `16k_zh` | Engine type. Common values: `16k_zh` (Mandarin), `16k_en` (English), `16k_yue` (Cantonese) |

### Streaming / Formatting

| Field | Type | Default | Description |
|---|---|---|---|
| `blockStreaming` | boolean | `false` | Enable block streaming replies. Disabled by default so text+media replies are delivered only after final media normalization. |
| `blockStreamingCoalesce` | object | `{minChars:80,idleMs:250}` | Coalescing config for streaming chunks |
| `textSplit` | object | `{enabled:true,minDelayMs:1000,maxDelayMs:3000}` | Split outbound text on blank lines and wait between split messages |

### Multi-account

```json
{
  "channels": {
    "napcat": {
      "url": "ws://napcat:3001",
      "asr": {
        "secretId": "<tencent-secret-id>",
        "secretKey": "<tencent-secret-key>"
      },
      "accounts": {
        "work": {
          "url": "ws://napcat-work:3001",
          "fromGroup": "123456789"
        },
        "personal": {
          "fromUser": "987654321",
          "asr": {
            "secretId": "<tencent-secret-id>",
            "secretKey": "<tencent-secret-key>",
            "engine": "16k_yue"
          }
        }
      }
    }
  }
}
```

Per-account fields override the root-level defaults. `asr` at the account level fully replaces the root `asr` (no partial merge).

---

## Debugging

### Enable debug logging

The plugin emits structured log output through OpenClaw's log sink. Enable debug mode to see full detail:

| Source | What is logged |
|---|---|
| `[napcat/ws-client]` | Raw outbound (`→`) and inbound (`←`) WebSocket frames, response echo matching, timeout/error details |
| `[napcat/watcher]` | Per-message filter decisions (skipped/accepted with reason), segment parsing steps, media/ASR progress |
| `[napcat/media]` | Download URL, resolved extension, byte count, destination path |
| `[napcat/asr]` | Engine/format params, recognized text result |

### Common issues

**Connection refused / timeout**
- Verify `url` points to the correct host and port.
- Check that Napcat is running and its WebSocket server is enabled.

**Group messages received but no reply sent**
- OpenClaw defaults group chat replies to `message_tool_only`. Add `"messages": {"groupChat": {"visibleReplies": "automatic"}}` to your OpenClaw config to enable automatic replies in groups.

**Messages not received**
- Check `fromGroup` / `fromUser` — they must match exactly (string comparison).
- Check `ignorePrefixes` — the default `["/"]` drops all `/command` style messages except `/new` and `/reset`. Set to `[]` to disable.
- Enable debug logging to see filter decisions per message.

**Voice messages not transcribed**
- Ensure `asr.secretId` and `asr.secretKey` are set in config.
- Check `asr.engine` matches your audio language.
- Enable debug logging to see ASR call details and any error codes from Tencent Cloud.

**Media not downloaded**
- Files are saved to `<cwd>/napcat/<image|video|file>/<YYYY-MM>/` relative to the OpenClaw working directory.
- Ensure the process has write permission to that path.
- Enable debug logging to see the exact URL being fetched and any HTTP errors.
