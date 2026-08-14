<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/8997f192-d0c0-42c6-a864-d4af18f13b7e

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Copy [.env.example](.env.example) to `.env.local` and fill your LLM provider key:
   - 默认 Gemini：填 `GEMINI_API_KEY`
   - 或 DeepSeek：`LLM_PROVIDER=openai-compatible` + `OPENAI_API_KEY`（见下方示例）
3. Run the app:
   `npm run dev`

## LLM 提供商配置

应用默认使用 **Gemini**，也支持切换到任意 **OpenAI 兼容** 提供商
（OpenAI / DeepSeek / Moonshot(Kimi) / OpenRouter / 本地 vLLM、Ollama 等）。
全部通过环境变量控制（参考 [.env.example](.env.example)）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLM_PROVIDER` | `gemini` | `gemini` 或 `openai-compatible` |
| `GEMINI_API_KEY` | — | Gemini 必填 |
| `GEMINI_MODELS` | 内置 5 个模型 | 逗号分隔，按顺序回退 |
| `OPENAI_API_KEY` | — | openai-compatible 必填 |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | 兼容端点（DeepSeek/Kimi/Ollama 等） |
| `OPENAI_MODEL` | `gpt-4o-mini` | 使用的模型名 |
| `OPENAI_MAX_TOKENS` | `8192` | openai-compatible 的 max_tokens 上限（DeepSeek=8192，超限会被 400 拒绝） |

### 示例：改用 DeepSeek

```bash
# .env.local
LLM_PROVIDER=openai-compatible
OPENAI_API_KEY=sk-xxxx
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_MODEL=deepseek-chat
OPENAI_MAX_TOKENS=8192   # deepseek-chat 上限 8192
```

### 示例：本地 Ollama（无需云 API Key）

```bash
# 先启动 ollama serve 并拉取模型，例如 ollama pull qwen2.5:14b
LLM_PROVIDER=openai-compatible
OPENAI_API_KEY=ollama            # 任意非空值即可
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=qwen2.5:14b
```

### 说明

- 所有步骤的 prompt 与 JSON 契约与提供商无关，切换后无需改代码。
- openai-compatible 模式下请求会带上 `response_format: {type:"json_object"}`（结构化输出），
  若你的端点不支持可忽略（模型仍会尽力输出 JSON）。
- 健康检查 `/api/health` 会返回当前 `provider` 与 `hasKey`，前端据此显示配置提示。

## Logging

项目内置结构化日志系统（`src/server/logger.ts`），通过环境变量控制。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LOG_LEVEL` | `debug`(dev) / `info`(prod) | 日志级别: debug / info / warn / error |
| `LOG_TO_FILE` | `false` | 是否将日志写入 `logs/` 目录 |

### 日志输出

- **控制台**：按级别染色输出（error→红色, warn→黄色, info/debug→普通）
- **文件**：`logs/app-YYYY-MM-DD.log`，JSON 格式，每行一条

### 对话导出

开发阶段可通过 API 导出对话为 Markdown：

```bash
# 导出整个会话
curl http://localhost:3000/api/log/session/{sessionId} > session.md

# 导出单个轮次
curl http://localhost:3000/api/log/turn/{turnId} > turn.md
```

导出的 Markdown 包含：用户消息、Coach 回复、LLM 调用详情、Progress Update 数据、日志时间线。
