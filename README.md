# moltbot-napcat-bridge

CLI relay that sends messages from moltbot to a Napcat WebSocket backend.

## Usage

- Install with pip: `pip install .`
- Run cli command: `nap-msg rpc`

Napcat backend: set env `NAPCAT_URL` (or pass `--napcat-url`).

## Install into Clawdbot (moltbot)
1) Copy the Napcat plugin folder to the Clawdbot extensions path:
   - `cp -r napcat ~/.clawdbot/extensions/napcat`
2) Enable the channel and plugin in your Clawdbot config (e.g. `~/.clawdbot/config.json`):
   ```json
   {
     "channels": {
       "napcat": {
         "enabled": true
       }
     },
     "plugins": {
       "entries": {
         "napcat": {
           "enabled": true
         }
       }
     }
   }
   ```
3) Place your `.env` (with `NAPCAT_URL` and any related variables) in the Clawdbot working directory so the runtime picks it up when launching.
4) Install the CLI/bridge into your environment (installs `nap-msg` entrypoint):
   ```bash
   pip install .
   ```

## Test (manual RPC receive)
1. Export Napcat URL in the shell: `set NAPCAT_URL=ws://<host>:<port>` (PowerShell) or `export NAPCAT_URL=...` (bash).
2. Terminal A: start RPC server and leave it running: `poetry run nap-msg rpc`.
3. In the same terminal, type a subscribe request and press Enter on one line:
   ```
   {"jsonrpc":"2.0","id":1,"method":"watch.subscribe","params":{}}
   ```
   You should see a `{"result":{"subscription":...},"id":1,...}` response.
4. Trigger a QQ message on Napcat; the RPC server should print a notification:
   ```
   {"jsonrpc":"2.0","method":"message","params":{"subscription":1,"message":{...}}}
   ```
5. To test sending, type:
   ```
   {"jsonrpc":"2.0","id":2,"method":"message.send","params":{"to":"<qq_id>","text":"hello","isGroup":false}}
   ```
   A `result` response means the send call was accepted.
