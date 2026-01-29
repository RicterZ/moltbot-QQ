# QQ Message Skill (nap-msg)

Env vars load automatically (including from a local `.env`).

## CLI
- Private: `nap-msg send <user_id> [segments...]`
- Group: `nap-msg send-group <group_id> [segments...]`
- Group forward: `nap-msg send-group <group_id> --forward [segments...]`
- Watch events: `nap-msg watch`
- Segments (order preserved): `-t/--text`, `-i/--image`, `-v/--video`, `-f/--file`, `-r/--reply`

## JSON-RPC (stdio)
- Start server: `nap-msg rpc`
- Methods:
  - `initialize` → responds with capabilities `{streaming:true, attachments:true}`
  - `message.send` (`to`/`chatId`, optional `isGroup`, `text`)
  - `watch.subscribe` → returns `subscription` id; events are notifications `method: "message", params: {subscription, message: {sender, chatId, isGroup, text, messageId}}`
  - `watch.unsubscribe`
  - `messages.history` → returns `{messages: []}`
  - `chats.list` → returns `[]`
