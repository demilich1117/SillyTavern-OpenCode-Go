# OpenCode Go 实机验证 · 2026-10-30

在本机 SillyTavern 1.19.0（`06bde939f`）安装连接助手 0.1.0 后，使用酒馆保存的 `OCG` 档案和密钥库完成真实请求。密钥内容没有导出到扩展、测试脚本或本报告。

## 结果

| 检查 | 实测结果 |
|---|---|
| 模型列表 | 通过酒馆 `/status` 获取，HTTP 200，包含 `deepseek-v4.1-flash`。 |
| 普通回复 | 成功，约 2.6 秒，模型原文 `OPENCODE_在`，`finish_reason: stop`。模型没有完全照抄测试标记，连接和响应解析正常。 |
| 流式回复 | 成功，约 3.1 秒，收到 24 个流式事件，模型原文「流式连接测试已成功。」。 |
| 原生主生成路径 | 使用酒馆 `sendOpenAIRequest('quiet', …)`，包括主生成的参数构造和事件链；问「2 加 2 等于几？」，约 2.1 秒回复 `4`。 |
| 套餐 | 两个非流式响应的 `usage.opencode.billing_source` 均为 `go`，`usage.cost` 均为 0；请求会消耗 Go 套餐额度。 |
| 会话头 | 三次生成请求的 `x-opencode-session` 相同，客户端标识为 `SillyTavern-OpenCode-Go/0.1.0`。 |
| 刷新持久化 | 刷新后扩展正常加载，OCG 地址和模型保存；重新打开测试聊天后，三条结果摘要及同一会话标识仍在。 |
| 请求 URL | 三次生成均为 `https://opencode.ai/inference/go/openai/v1`，酒馆追加 `/chat/completions`。 |

前两次通过 `ConnectionManagerRequestService` 调用标准辅助请求路径，最后一次使用主生成函数。测试采用独立角色「OpenCode Go 实机测试 2026-10-30」，只提交简短合成文本，结果摘要保留在该聊天。原生函数测试使用 quiet 模式；没有用现有角色的完整剧情上下文进行长篇生成。

## 已保存的配置

`OCG` 档案的地址由 `https://opencode.ai/inference/go/v1` 改为已验证的 `https://opencode.ai/inference/go/openai/v1`，模型保持 `deepseek-v4.1-flash`，密钥关联保持不变。测试结束恢复此前选中的连接档案，保留测试聊天和已安装扩展。

没有修改酒馆核心。没有验证全部 Go 模型、长上下文、工具调用、长时间流式输出或 TauriTavern。
