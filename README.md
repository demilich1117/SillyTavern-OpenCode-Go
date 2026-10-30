# OpenCode Go 连接助手

为 SillyTavern 1.19.0 的主聊天和辅助模型请求补充 OpenCode 会话请求头，并修复模型列表地址。版本 **0.2.0**：支持原生连接档案、酒馆助手独立 API、可选插件直连转发，以及脚本统一入口。可用于填表、MVU 更新、总结等辅助生成的连接适配；具体输出质量仍取决于模型和调用方。

## 你应填写的 URL

**OpenCode Go：**

```text
https://opencode.ai/inference/go/openai/v1
```

`https://opencode.ai/inference/openai/v1` 是按量计费路径。不要用它代替 Go 路径。URL 末尾不要添加 `/chat/completions`，酒馆会自动追加。

连接档案的 API 密钥填在酒馆原生「自定义 API 密钥」栏；使用插件独立 API 时沿用该插件的凭据配置。模型 ID 使用你的 Go 套餐支持的模型。本扩展不保存密钥，也不需要手填会话请求头。

**只用作子模型时，不要点击「应用 Go 地址」：该按钮用于切换主聊天连接。** 在填表、变量更新或其他插件中选用 Go 连接档案，或填写上方独立 API 地址即可，主聊天可以继续使用其他服务。

## 安装

推荐在酒馆「扩展 → 安装扩展」中粘贴仓库地址：

```text
https://github.com/demilich1117/SillyTavern-OpenCode-Go
```

安装完成后刷新页面，打开「OpenCode Go 连接助手」，保持「自动附加会话请求头」启用。主聊天使用 Go 时可点击「应用 Go 地址」，然后选择模型并填写原生自定义 API 密钥；仅用于子模型时按下节配置。

也可从 [Releases](https://github.com/demilich1117/SillyTavern-OpenCode-Go/releases) 下载 ZIP，手动安装：

1. 解压安装包，把 `SillyTavern-OpenCode-Go` 文件夹放入酒馆的 `data/<用户目录>/extensions/`。单用户默认目录通常是 `data/default-user/extensions/`。
2. 确认 `manifest.json` 直接位于该文件夹内，而不是再套一层同名目录。
3. 刷新酒馆，打开「扩展 → OpenCode Go 连接助手」。
4. 主聊天使用 Go 时点击「应用 Go 地址」，核对原生密钥和模型；仅用作子模型时，在对应插件中配置 Go 连接。

也可放入 `public/scripts/extensions/third-party/SillyTavern-OpenCode-Go/`，作为所有用户可见的安装。两种方式只选一种。

这是纯前端扩展，安装不需要运行 npm、不需要修改酒馆核心、不需要服务端插件。

## 子模型与插件兼容

| 调用方式 | 0.2.0 的行为 |
|---|---|
| 酒馆连接档案 / `ChatCompletionService` 的 Custom 请求 | 自动补头和修正模型目录，不要求主连接也是 Go。 |
| 酒馆助手 `generate` / `generateRaw` 独立 API，默认 OpenAI 来源 | 自动适配 `openai + reverse_proxy`，保留该次请求的密钥、模型与生成参数。 |
| 酒馆助手 `getModelList` | 自动将官方生成基础地址的模型查询转到公共模型目录。 |
| 本页插件用 `fetch` 直连官方 `/chat/completions` 或 `/models` | 在设置中启用「转发本页插件的 OpenCode 直连请求」后，经酒馆后端转发。此开关默认关闭。 |
| 同源 iframe / 自编脚本 | 使用 `window.parent.OpenCodeGo.request` 或 `.fetch`；详见下节。 |
| XHR、提前缓存的旧 fetch、Worker、其他服务端插件或跨源 iframe 自行请求 | 不会自动接管，需要调用方接入统一入口。Worker 需要其宿主页面代为调用；不提供跨源消息代理。 |

只识别官方 Chat Completions 路径，不处理任意中转、Responses、Anthropic Messages 或本地 OpenCode server。旧版 `/zen/go/v1` 与 `/zen/v1` 继续按原路径兼容。官方 Go 与按量计费路径不会互换。

OpenAI 代理模式会在**单次转发请求**中改为酒馆 Custom 来源，因为宿主 OpenAI 来源不转发附加请求头。它使用该次 `proxy_password`，不会借用主聊天的自定义密钥，也不会启用原先未生效的 Custom 请求体覆盖。请求变换不修改酒馆连接设置或调用者的原对象。

## 脚本统一入口

推荐通过已保存的原生 Custom 连接档案调用。密钥始终由酒馆服务端读取，前端无需开启“查看密钥”：

```js
// 原生扩展使用 window；同源助手 iframe 使用 window.parent。
const host = window.parent;
const api = host.OpenCodeGo;
if (!api) throw new Error('请先启用 OpenCode Go 连接助手');
const profile = host.SillyTavern.getContext().extensionSettings.connectionManager.profiles
    .find(p => p.name === 'OCG'); // 换成你保存的档案名称
if (!profile) throw new Error('未找到 Go 连接档案');

// 在任务开始时捕获；排队后切换聊天也能继续使用原会话标识。
const sessionId = api.captureSession();
const response = await api.request(profile.id, {
    messages: [{ role: 'user', content: '返回 JSON：{"count":2}' }],
    max_tokens: 256,
    response_format: { type: 'json_object' },
}, { sessionId, signal: AbortSignal.timeout(60000) });
const result = await response.json();
if (!response.ok || result.error) throw new Error('子模型生成失败');
const text = result.choices[0].message.content;
```

`request(profileId, body, options)` 接受 OpenAI Chat Completions 请求体，返回 `Response`。默认模型取自该档案，也可在 `body.model` 显式覆盖；不加载当前预设、不自动拼接聊天或世界书、不写回消息或 MVU。`stream: true` 时由调用方读取 SSE；`tools`、`tool_choice`、`response_format` 和其他 JSON 参数透传。

调用方已有独立凭据或原生 Custom 密钥 ID 时，可使用 fetch 形式：

```js
const response = await api.fetch(
    'https://opencode.ai/inference/go/openai/v1/chat/completions',
    {
        method: 'POST',
        body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages, stream: false }),
        signal: controller.signal,
    },
    { sessionId, secretId: profile['secret-id'] },
);
```

- `secretId` 必须是酒馆原生 Custom 密钥引用；也可由已有凭据管理器在 `init.headers.Authorization` 提供 Bearer 头，两者不能同时使用。不要把明文密钥写入脚本源码。
- 未指定凭据时不会自动借用当前主连接的密钥；公共模型目录可匿名请求。
- `fetch` 只接受官方完整的 `/chat/completions` POST（JSON 字符串）或 `/models` GET。它支持本页及同源 iframe 的 `Request`、`Headers` 与取消信号。
- 此入口依赖「自动附加会话请求头」总开关，不依赖可选的本页直连拦截开关。停用或卸载后，已缓存的入口也会拒绝新请求；已发送请求由调用方的 AbortSignal 取消。
- 会话标识只解决上游路由。后台结果写回前，调用方仍须核对原聊天和楼层身份，避免将旧结果写入新聊天。
- 转发使用酒馆认证与 CSRF 头；Cookie、CSRF 等本地凭据不会传给 OpenCode。只转发 Authorization、Accept、Content-Type、User-Agent、`x-opencode-*`、请求 ID 和 `openai-*` 头；自定义代理专用头不在范围内。
- 酒馆可能把上游错误转换为 HTTP 200。统一入口将其中的 JSON `error` 转为 502；无法还原上游原始状态码、响应头或 Retry-After，不保证所有 SDK 的自动重试行为相同。成功的 JSON 和 SSE 按酒馆响应返回；流式响应缺失 Content-Type 时补为 `text/event-stream`，不预读流。

## 自动处理的内容

- 向每次匹配的请求添加 `x-opencode-session`；同一聊天的普通生成、续写、重生成、滑动回复及标准辅助请求复用标识。
- 使用真实客户端标识 `User-Agent: SillyTavern-OpenCode-Go/0.2.0`。
- 保留其他 YAML / JSON 附加请求头；只替换上述两个字段，避免大小写不同产生重复会话头。
- 清理官方 Chat Completions 地址的多余末尾斜线和重复 `/chat/completions` 后缀。
- 模型检查改用公共目录 `https://opencode.ai/inference/v1/models`；聊天生成继续走原来的 Go 或按量计费路径，扩展不会自动更换计费路径。
- 设置面板识别误填按量计费地址的情况，提供 Go 地址应用按钮。

2026-10-30 匿名只读检查：`/inference/go/openai/v1/models` 返回 404，`/inference/v1/models` 返回 200。酒馆 1.19.0 会把 `/models` 追加到 API 基础地址，所以仅填写正确生成地址仍可能在连接检查时遇到 404。公共目录包括套餐以外的模型，列表可见不代表你的 Go 账号有权限调用。

## 会话标识与范围

扩展在酒馆用户设置中保存一个随机命名空间；使用它与角色头像文件名 / 群组标识、聊天文件名做 SHA-256 摘要，生成 `ses_st_…` 标识。角色名、聊天名和对话正文不会写入请求头。设置随酒馆原生保存流程持久化，刷新后继续复用标识。

新聊天、新分支、不同角色或群组使用不同标识。聊天重命名、角色头像文件名更换或扩展命名空间重置也会改变标识。没有打开聊天时，连接测试使用该用户独立的固定测试标识。当前版本不写聊天元数据或聊天正文。

自动处理同源的酒馆 `/api/backends/chat-completions/generate` 和 `/status` JSON POST，请求来源为 `custom` 或带官方 `reverse_proxy` 的 `openai`。目标按本次请求判断，不根据面板当前选中的模型猜测。可选直连转发仅覆盖本页全局 fetch，其他环境按上表接入。

自动适配的辅助调用使用发起请求时页面的当前聊天标识。统一入口支持 `captureSession()`，让跨聊天后台任务显式携带任务开始时的标识；不把任务名称、角色名或聊天正文传入会话头。

## 验证结果与限制

- 核验宿主：本机 SillyTavern **1.19.0 / `06bde939f`**。
- 0.2.0：29 项 Node 测试通过，覆盖旧版路径及独立 API 转换、密钥隔离、原生档案引用、JSON/工具参数、统一入口、会话捕获、流式透传、SSE 响应类型、取消、停用和错误状态转换。
- 在真实酒馆页面中以隔离上下文验证挂载、重复初始化、切换聊天、停用 / 重启及真实宿主 YAML 库。合成请求在浏览器中截获，没有发送真实聊天或使用账号密钥。
- 0.2.0 进一步检查本机酒馆助手 4.11.3 的真实 `generateRaw` / `getModelList` 调用链、`ChatCompletionService`、同源 iframe Request 和直连转发开关；合成请求检查通过。详细验证见 [0.2.0 记录](validation-0.2.0-2026-10-30.md)。
- 0.2.0 原生档案统一入口已用真实 Go 账号验证 JSON Schema、强制工具调用和流式输出；两个非流式响应均确认 `billing_source: go`。安装后复测 SSE 响应类型及完整性通过。
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
