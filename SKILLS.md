# QQ Message Skill

Use `nap-msg` to send / receive QQ messages for moltbot.
Read necessary environment variables from `.env` file.

- `NAPCAT_URL`
- `ALLOW_SENDERS` (optional for send)

## Send Messages
#### Commands

- Private: `nap-msg send $SEND_PERSON [segments...]`
- Group: `nap-msg send-group $SEND_GROUP [segments...]`
- Forward (group multimodal): `nap-msg send-group <group_id> --forward [segments...]`

#### Segments
Segment flags can be mixed/repeated; the order you type is the order sent.

- `-t/--text "<text>"`
- `-i/--image "<path_or_url>"`
- `-v/--video "<path_or_url>"`
- `-f/--file "<path>"`
- `-r/--reply "<message_id>"`

#### Options

- `--napcat-url <ws>`: Napcat WebSocket (or set env `NAPCAT_URL`, required).
- `--timeout <seconds>`: response wait timeout (env `NAPCAT_TIMEOUT`, default 10).
- `--verbose`: debug logs.

## Receive Messages
#### Commands

- Watch incoming QQ messages as JSON: `nap-msg watch [--from-group <gid>] [--from-user <uid>] [--ignore-startswith <pfx>]`

#### Output
- Default: one-line JSON per message, only key fields kept (`user_id`, `group_id`, `message_type`, `message_id`, `raw_message`, `message`, `resolved_text`, `post_type`, `time`, `target_id`). CQ 表情/图片段会被剔除，空消息会被忽略。
- 默认忽略前缀：`/`（可用 `--ignore-startswith` 覆盖）。
- `resolved_text` includes ASR transcription when Tencent creds are set (`TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`); otherwise voice messages are ignored.
- Logs are suppressed by default to avoid interfering with consumers; add `--verbose` to debug.
