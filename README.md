# OpenCode Go 连接助手

为 SillyTavern 1.19.0 的「聊天补全 → 自定义（OpenAI 兼容）」连接补充 OpenCode 会话请求头，并修复新版 OpenCode 模型列表地址不匹配的问题。版本 0.1.0，已用真实 Go 账号和 DeepSeek 4.1 Flash 验证。

## 你应填写的 URL

**OpenCode Go：**

```text
https://opencode.ai/inference/go/openai/v1
```

`https://opencode.ai/inference/openai/v1` 是按量计费路径。不要用它代替 Go 路径。URL 末尾不要添加 `/chat/completions`，酒馆会自动追加。

API 密钥填在酒馆原生「自定义 API 密钥」栏，模型 ID 使用你的 Go 套餐支持的模型。不需要把密钥放进扩展，也不需要填写额外请求头。

## 安装

推荐在酒馆「扩展 → 安装扩展」中粘贴仓库地址：

```text
https://github.com/demilich1117/SillyTavern-OpenCode-Go
```

安装完成后刷新页面，打开「OpenCode Go 连接助手」，点击「应用 Go 地址」，然后选择模型并填写酒馆原生自定义 API 密钥。

也可从 [Releases](https://github.com/demilich1117/SillyTavern-OpenCode-Go/releases) 下载 ZIP，手动安装：

1. 解压安装包，把 `SillyTavern-OpenCode-Go` 文件夹放入酒馆的 `data/<用户目录>/extensions/`。单用户默认目录通常是 `data/default-user/extensions/`。
2. 确认 `manifest.json` 直接位于该文件夹内，而不是再套一层同名目录。
3. 刷新酒馆，打开「扩展 → OpenCode Go 连接助手」。
4. 点击「应用 Go 地址」，核对原生密钥和模型，然后发送测试消息。

也可放入 `public/scripts/extensions/third-party/SillyTavern-OpenCode-Go/`，作为所有用户可见的安装。两种方式只选一种。

这是纯前端扩展，安装不需要运行 npm、不需要修改酒馆核心、不需要服务端插件。

## 自动处理的内容

- 向每次匹配的请求添加 `x-opencode-session`；同一聊天的普通生成、续写、重生成、滑动回复及标准辅助请求复用标识。
- 使用真实客户端标识 `User-Agent: SillyTavern-OpenCode-Go/0.1.0`。
- 保留其他 YAML / JSON 附加请求头；只替换上述两个字段，避免大小写不同产生重复会话头。
- 清理官方 Chat Completions 地址的多余末尾斜线和重复 `/chat/completions` 后缀。
- 模型检查改用公共目录 `https://opencode.ai/inference/v1/models`；聊天生成继续走原来的 Go 或按量计费路径，扩展不会自动更换计费路径。
- 设置面板识别误填按量计费地址的情况，提供 Go 地址应用按钮。

2026-10-30 匿名只读检查：`/inference/go/openai/v1/models` 返回 404，`/inference/v1/models` 返回 200。酒馆 1.19.0 会把 `/models` 追加到 API 基础地址，所以仅填写正确生成地址仍可能在连接检查时遇到 404。公共目录包括套餐以外的模型，列表可见不代表你的 Go 账号有权限调用。

## 会话标识与范围

扩展在酒馆用户设置中保存一个随机命名空间；使用它与角色头像文件名 / 群组标识、聊天文件名做 SHA-256 摘要，生成 `ses_st_…` 标识。角色名、聊天名和对话正文不会写入请求头。设置随酒馆原生保存流程持久化，刷新后继续复用标识。

新聊天、新分支、不同角色或群组使用不同标识。聊天重命名、角色头像文件名更换或扩展命名空间重置也会改变标识。没有打开聊天时，连接测试使用该用户独立的固定测试标识。当前版本不写聊天元数据或聊天正文。

只处理同源的酒馆 `/api/backends/chat-completions/generate` 和 `/status` JSON POST，请求来源必须是 `custom`，目标必须是明确识别的 `https://opencode.ai` 官方路径。其他来源、本地 OpenCode server、任意中转和插件自行直连的 HTTP 请求不在范围内。

主聊天之外，使用酒馆 `ChatCompletionService` 且请求在本页面发起的辅助调用也会被覆盖。辅助调用使用发起请求时页面的当前聊天标识；跨聊天后台任务若自行管理另一聊天，需要调用方另行传递会话上下文。

## 验证结果与限制

- 核验宿主：本机 SillyTavern **1.19.0 / `06bde939f`**。
- 15 项 Node 测试通过：URL、不同会话隔离、刷新一致性、附加头保留、模型目录修正、Request 对象、流式响应透传、取消信号、停用和其他扩展 fetch 包装共存。
- 在真实酒馆页面中以隔离上下文验证挂载、重复初始化、切换聊天、停用 / 重启及真实宿主 YAML 库。合成请求在浏览器中截获，没有发送真实聊天或使用账号密钥。
- **2026-10-30 已完成真实 Go 账号测试**：使用酒馆保存的 OCG 密钥和 `deepseek-v4.1-flash`，普通、流式及原生主生成路径均有有效回复；非流式用量返回 `billing_source: go`。三次请求会话标识一致。模型列表返回 200，并包含该模型。详见 [实机验证记录](validation-2026-10-30.md)。该结果不代表所有模型或未来的账号额度、区域状态。
- 尚未验证 TauriTavern 或其他版本。当前仅支持 Chat Completions 入口；OpenCode 官方说明新版网关可转换付费 / Go 文本模型协议，但本扩展没有单独验证全部模型。
- OpenCode Go 官方定位是编码代理流量，并要求客户端自报身份及稳定会话标识；扩展只补充真实标识，不改变服务的使用范围或模型权限。

## 排错

| 现象 | 检查 |
|---|---|
| 模型列表 404 | 确认扩展启用、选择「自定义」来源。新版请求应被转到公共模型目录。 |
| 缺少 session header | 展开扩展的「请求状态」。若仍显示未处理，检查请求是否来自本页面的标准酒馆接口。 |
| 401 / 403 | 检查 Go 账号密钥、权限、区域及所选模型；仅补请求头不会解决账号鉴权问题。 |
| 429 | 检查套餐额度和并发限制。 |
| 附加请求头格式错误 | 在酒馆自定义连接的附加参数中修正 YAML / JSON；扩展会停止该请求，避免丢弃已有头。 |

## 开发

```sh
npm ci
npm test
npm run check
```

运行时使用 `SillyTavern.libs.yaml` 和 `SillyTavern.libs.sha256`；npm 的 YAML 依赖只用于测试。`test/browser-smoke.pw.js` 是 Playwright CLI 的隔离烟测脚本，从仓库根目录执行。合成请求的浏览器检查不代替 Go 账号实测。

采用 [MIT 许可证](LICENSE)。

## 核验来源

- [OpenCode Harnesses：Go 基础地址、协议转换与 Sessions](https://opencode.ai/v2/docs/console/harnesses)
- [OpenCode Go：客户端与会话要求](https://opencode.ai/v2/docs/console/go/)
- [OpenCode Inference API：认证与模型目录](https://opencode.ai/v2/docs/console/api/inference)
- [SillyTavern 06bde939f 前端生成与连接逻辑](https://github.com/SillyTavern/SillyTavern/blob/06bde939f/public/scripts/openai.js)
- [SillyTavern 06bde939f 服务端转发](https://github.com/SillyTavern/SillyTavern/blob/06bde939f/src/endpoints/backends/chat-completions.js)
