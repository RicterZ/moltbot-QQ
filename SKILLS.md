# QQ Message Skill

Use `nap-msg` to send / receive QQ messages for moltbot.
Read necessary environment variables from `.env` file.

- `NAPCAT_URL`
- `ALLOW_SENDERS`

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

- Watch incoming QQ messages as JSON: `nap-msg watch --from-user $ALLOW_SENDERS [--ignore-startswith <pfx>]`

#### Notes
- Ignore messages startswith `/` by default