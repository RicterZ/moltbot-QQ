# Napcat Relay Skill

Use `nap-msg` to send QQ messages via Napcat for moltbot.
Read necessary environment variables from `.env` file.

- `NAPCAT_URL`
- `ALLOW_SENDERS`

Commands
- Private: `nap-msg send <user_id> [segments...]`
- Group: `nap-msg send-group <group_id> [segments...]`
- Forward (group multimodal): `nap-msg send-group <group_id> --forward [segments...]`

Segments (order = send order)
- `-t/--text "<text>"`
- `-i/--image "<path_or_url>"` (local files are sent as `base64://...`)
- `-v/--video "<path_or_url>"` (local → `base64://...`)
- `-f/--file "<path>"` (local → `base64://...`)
- `-r/--reply "<message_id>"`

Options
- `--napcat-url <ws>`: Napcat WebSocket (or set env `NAPCAT_URL`, required).
- `--timeout <seconds>`: response wait timeout (env `NAPCAT_TIMEOUT`, default 10).
- `--verbose`: debug logs.

Notes
- Segment flags can be mixed/repeated; the order you type is the order sent.
- Group ID can be reterived from environment variable `SEND_GROUP`
