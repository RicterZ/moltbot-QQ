# openclaw-napcat — CLAUDE.md

## 项目概览

OpenClaw 的 QQ 频道插件，通过 WebSocket 直连 [Napcat](https://github.com/NapNeko/NapCatQQ)（OneBot v11 协议）实现：
- **接收 QQ 消息**（私聊/群聊）并转发给 OpenClaw AI 网关
- **发送 AI 回复**回 QQ（流式/非流式）
- **处理富媒体**：图片/视频/文件下载，语音 ASR 转写（腾讯云）

```
OpenClaw AI Gateway
    ↕ TypeScript Plugin (src/)
    ↕ WebSocket (OneBot v11)
Napcat WebSocket Server (ws://napcat:3001)
    ↕  QQ
```

## 两个独立组件

### 1. TypeScript 插件（`src/` + `index.ts`）
OpenClaw 频道插件，**接收**QQ 消息并**发送**AI 回复。
- 运行环境：OpenClaw 网关（Node.js 22+）
- 无构建步骤，OpenClaw 运行时直接解释 `.ts`
- 无第三方依赖，全部使用 Node.js 内置模块 + OpenClaw SDK

### 2. Python CLI（`nap-msg/`）
独立命令行工具，用于**主动发送**消息到 QQ。与 TypeScript 插件无耦合，单独安装使用。
- 入口：`nap-msg` 命令（`nap_msg/cli.py`）
- 依赖：`websockets`, `yt-dlp`, `pycryptodomex`，需 Python ≥ 3.13

## 目录结构

```
.
├── index.ts                  # 插件入口，注册 channel
├── package.json              # 插件包信息（无 scripts，无外部依赖）
├── openclaw.plugin.json      # OpenClaw 插件描述
├── src/
│   ├── channel.ts            # 频道主逻辑：消息接收/发送/多账号/流式回复
│   ├── watcher.ts            # 入站消息处理：过滤、解析、媒体下载、ASR
│   ├── ws-client.ts          # WebSocket 客户端：连接、echo 关联、超时
│   ├── asr.ts                # 腾讯云语音识别（TC3-HMAC-SHA256 自实现）
│   ├── media.ts              # 媒体文件下载（图片/视频/文件）
│   ├── deliver.ts            # 出站消息格式化：流式 coalescing、富媒体序列化
│   ├── config-schema.ts      # 配置 schema 定义与验证
│   ├── types.ts              # 共享类型定义
│   ├── logger.ts             # 作用域日志（[napcat/<scope>]）
│   └── runtime.ts            # 单例 PluginRuntime 持有
├── nap-msg/
│   ├── pyproject.toml        # Python 包配置（Poetry）
│   ├── env.example           # 环境变量示例
│   └── nap_msg/
│       ├── cli.py            # CLI 入口：argparse、命令分发
│       ├── client.py         # WebSocket 客户端（短连接，echo 关联）
│       ├── messages.py       # 消息类型：TextMessage/ImageMessage/VideoMessage/…
│       └── video.py          # 视频下载（yt-dlp）+ 转码（ffmpeg）→ QQ 兼容 MP4
├── SKILLS.md                 # AI 发送 QQ 消息的快速参考
└── README.md                 # 用户配置文档
```

## 常用命令

### 安装与运行 TypeScript 插件
```bash
openclaw plugins install .    # 安装插件
openclaw gateway restart      # 重启网关使配置生效
```

### 安装 Python CLI
```bash
cd nap-msg
poetry install
cp env.example .env           # 填写 NAPCAT_URL
```

### 发送 QQ 消息（nap-msg）
环境变量从 `nap-msg/.env` 读取，也可通过 `--napcat-url` 参数覆盖。

```bash
# 私聊
nap-msg send <user_id> -t "文本"

# 群聊（普通消息）
nap-msg send-group <group_id> -t "文本" -i /path/to/image.jpg

# 群聊（合并转发卡片）
nap-msg send-group <group_id> --forward -t "文本" -i /path/image.jpg

# 视频（本地文件）
nap-msg send-group <group_id> -v /path/to/video.mp4

# 视频（URL，yt-dlp 下载 + 自动转码）
nap-msg send-group <group_id> --video-url "https://..." --video-duration 30

# 回复某条消息
nap-msg send <user_id> -r <message_id> -t "回复内容"
```

Segment 参数可混合、可重复，发送顺序与命令行顺序一致。

## 关键设计决策

### Echo 关联（Request-Response over WebSocket）
两侧的 WS 客户端都用随机 UUID 作为 `echo` 字段，将异步响应与请求对应。TypeScript 侧用 `Map<echo, PendingRequest>` 持久连接；Python 侧用短连接+循环过滤帧。

### 出站媒体用 base64
发送图片/视频/文件时，本地文件统一读取后编码为 `base64://...` 再发给 Napcat，因为 Napcat 可能跑在远程 Docker 中，无法访问宿主文件系统。

### 无扩展名 HLS segment（`video.py`）
小米摄像头等设备的 HLS 流，segment URL 不带文件扩展名。ffmpeg 4.x 默认会拒绝这类 URL（`extension_picky`）。修复方式：yt-dlp 使用 `external_downloader: ffmpeg` + `external_downloader_args["ffmpeg_i"]` 将 `-extension_picky 0` 作为 input option（在 `-i` 之前）传入。`downloader_args["ffmpeg"]` 是 output/global scope，**无效**，不要用。

### 流式回复 Coalescing
AI 流式输出时，积累到 80 字符或空闲 250ms 才合并发送一条 QQ 消息，避免消息碎片化刷屏。参数：`blockStreamingCoalesce: {minChars: 80, idleMs: 250}`。

### 多账号配置合并
根级 `channels.napcat` 为默认值，`accounts.<id>` 中的字段 **浅覆盖**根级。注意：`asr` 对象是**整体替换**，不做深度 merge。

### TypeScript 零外部依赖
`package.json` 的 `dependencies` 为空对象。所有 HTTP、Crypto、文件操作均用 Node.js 内置模块（`node:crypto`、`node:fs/promises`、`node:path`）+ 内置 `WebSocket`（需 Node 22+）+ 内置 `fetch`。

## 消息过滤逻辑

`watcher.ts` 按以下顺序过滤入站消息：

1. 仅处理 `message` 类型事件（丢弃 meta_event、notice 等）
2. `fromGroup` / `fromUser` 白名单过滤（字符串精确匹配）
3. `ignorePrefixes` 前缀过滤（默认 `["/"]`，但 `/new`、`/reset` 始终放行）
4. 解析 segments：文本拼接，图片/视频/文件触发下载，语音触发 ASR

## 目标地址格式

插件内部统一使用以下格式表示发送目标：
- 群消息：`napcat:group:<group_id>`
- 私聊：`napcat:<user_id>`

`normalizeNapcatTarget()` 支持 `channel:`、`group:`、`group-`、`user:`、`user-` 等前缀变体。

## 媒体存储路径

入站媒体下载到 agent workspace 的 `data/tmp/napcat/` 下：
```
<workspaceDir>/data/tmp/napcat/image/<YYYY-MM>/<hash>.<ext>
<workspaceDir>/data/tmp/napcat/video/<YYYY-MM>/<hash>.<ext>
<workspaceDir>/data/tmp/napcat/file/<YYYY-MM>/<hash>.<ext>
```

`workspaceDir` 通过 `runtime.agent.resolveAgentWorkspaceDir(cfg)` 获取。

## 配置速查

完整配置参见 `README.md`。常用字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `url` | string | Napcat WS 端点（必填） |
| `fromGroup` | string \| string[] | 群 ID 白名单 |
| `fromUser` | string \| string[] | 用户 ID 白名单 |
| `ignorePrefixes` | string[] | 忽略前缀（默认 `["/"]`） |
| `asr.secretId/secretKey` | string | 腾讯云语音识别密钥 |
| `blockStreaming` | boolean | 禁用流式回复 |

**重要**：OpenClaw 群聊默认 delivery mode 为 `message_tool_only`（AI 需主动调 message tool 才发送）。要让群聊自动回复，必须在 OpenClaw 配置中设置：
```json
{ "messages": { "groupChat": { "visibleReplies": "automatic" } } }
```

Python CLI 环境变量（`nap-msg/.env`）：

| 变量 | 说明 |
|---|---|
| `NAPCAT_URL` | WebSocket 端点（必填） |
| `NAPCAT_TIMEOUT` | 超时秒数（默认 10） |
| `NAPCAT_FORWARD_USER_ID` | 转发卡片虚拟 user_id |
| `NAPCAT_FORWARD_NICKNAME` | 转发卡片昵称（默认 `メイド`） |
