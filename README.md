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
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

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
