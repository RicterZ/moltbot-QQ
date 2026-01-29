# moltbot-napcat-bridge

CLI relay that sends messages from moltbot to a Napcat WebSocket backend. Includes a watch mode to dump QQ messages from Napcat as JSON.

## Usage
- Install with Poetry: `poetry install`
- Run CLI via Poetry: `poetry run nap-msg --help`

Napcat backend: set env `NAPCAT_URL` (or pass `--napcat-url`).

### Watch QQ messages
`poetry run nap-msg watch [--from-group <gid>] [--from-user <uid>]`

Connects to `NAPCAT_URL`, filters optional group/user, and prints each message event as pretty JSON to stdout.
