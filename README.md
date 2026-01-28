# moltbot-napcat-bridge

CLI relay that sends messages from moltbot to a Napcat WebSocket backend, plus an optional daemon to forward QQ inbound messages into moltbot and relay responses back.

## Usage
- Install with Poetry: `poetry install`
- Run CLI via Poetry: `poetry run nap-msg --help`
- Run daemon to relay QQ -> moltbot: `poetry run nap-msg-daemon` (requires `NAPCAT_URL`, optional `NAPCAT_EVENT_URL`; moltbot config via `MOLTBOT_URL`, `MOLTBOT_TOKEN`/`MOLTBOT_PASSWORD`, `MOLTBOT_WAIT_TIMEOUT`)

Napcat backend: set env `NAPCAT_URL` (or pass `--napcat-url`).

## Daemon (QQ -> moltbot)
`poetry run nap-msg-daemon`

Env config:
- `NAPCAT_URL` (required): Napcat websocket for commands.
- `MOLTBOT_URL` (default `ws://127.0.0.1:18789`)
- `MOLTBOT_TOKEN` / `MOLTBOT_PASSWORD` (gateway auth)
- `MOLTBOT_WAIT_TIMEOUT` (default `60`)
- `ALLOW_SENDERS` (optional): space/comma-separated QQ user_ids allowed to trigger relay (others ignored)
