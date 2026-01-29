# QQ Message Skill

Use `nap-msg` to send / receive QQ messages for moltbot.
Read necessary environment variables from `.env` file.

## Send Messages
#### Commands

- Private: `nap-msg send <user_id> [segments...]`
- Group: `nap-msg send-group <group_id> [segments...]`
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

- Default: one-line JSON, key fields only (`user_id`, `group_id`, `message_type`, `message_id`, `raw_message`, `time`, `target_id`). CQ 表情/图片段会被剔除，空消息会被忽略。默认忽略前缀 `/`（可用 `--ignore-startswith` 覆盖）。
- Voice: 如果设置 `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`，通过 `NAPCAT_URL` 请求语音并转写到 `raw_message`；否则语音消息会被静默跳过。
- 例子：
  - Private: `{"user_id": 312641104, "time": 1769674967, "message_id": 455927154, "message_type": "private", "raw_message": "hello", "target_id": 312641104}`
  - Group: `{"user_id": 312641104, "time": 1769674973, "message_id": 2131810936, "message_type": "group", "raw_message": "hello", "group_id": 2158015541}`
