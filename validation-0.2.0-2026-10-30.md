# OpenCode Go 0.2.0 · 辅助模型兼容验证

核验环境：Windows / Chrome，SillyTavern 1.19.0（`06bde939f`），本机酒馆助手 4.11.3。只修改连接助手项目。

## 请求适配

- 原生 Custom 主生成与辅助请求继续工作。
- 新增 OpenAI `reverse_proxy` 请求转换，覆盖酒馆助手独立 API 默认来源及模型列表。只按请求实际目标匹配，不依赖主连接。
- 转换显式使用原请求的 `proxy_password`；清除原本未生效的 Custom 请求体设置和密钥 ID，防止错误继承。普通 Custom 请求保留原来的密钥引用和附加参数。
- 新增本页直连 fetch 可选转发，默认关闭；只接受官方 Chat Completions JSON POST 和模型目录 GET。
- 新增 `OpenCodeGo.request`、`fetch`、`captureSession`。原生档案入口只传密钥 ID，不读取明文密钥；同源 iframe 可显式调用，后台任务可捕获原会话标识。
- 成功 SSE 缺少 Content-Type 时补齐；不预读流。宿主以 HTTP 200 包装的 JSON 错误转换为 502，不能恢复上游原始错误码。

## 离线与真实页面

- `npm test`：29 项通过；`npm run check` 通过。
- 回归涵盖不同来源与目标的交叉配置、凭据隔离、匿名目录、原生档案引用、JSON/工具字段、大小写请求头、流式、取消、会话捕获、停用、旧入口失效和第三方 fetch 包装共存。
- `test/browser-smoke.pw.js` 在真实酒馆页面加载本地候选代码，用独立上下文和合成响应验证真实宿主库及 API。
- 助手 `generateRaw` 默认独立 API、`getModelList`、原生 `ChatCompletionService`、同源 iframe `Request`、可选直连转发、初始化/停用/重启和聊天切换全部通过。
- 浏览器合成检查捕获生成请求和保存接口；未提交真实剧情或修改现有聊天内容。

## 真实 Go 账号

使用既有 `OCG` Custom 档案、`deepseek-v4.1-flash` 和原生密钥引用，发送三个短合成提示词。服务端使用保存的密钥，测试脚本没有取得或持久化密钥值。

| 检查 | 结果 |
|---|---|
| 统一入口模型目录 | HTTP 200，包含目标模型。 |
| 原生档案入口 + JSON Schema | HTTP 200，解析为 `ok=true, count=2`，`billing_source: go`。 |
| 原生档案入口 + 强制工具调用 | HTTP 200，返回 `update_state`，参数 `count=2`，`billing_source: go`。未执行工具或写入变量。 |
| 原生档案入口 + 流式 | HTTP 200，包含正文增量和 `[DONE]`。 |

实测发现 ST 的流式转发遗漏 Content-Type，已在统一入口补齐并加入不预读流的回归测试。安装后追加一条真实流式测试，确认响应类型为 `text/event-stream; charset=utf-8`、返回时流未被预读、正文与 `[DONE]` 完整，主连接档案未改变。

本机禁用前端查看密钥。OpenAI 代理模式的真实助手调用链使用合成密钥和截获响应验证；真实认证验证走原生密钥引用。两者不可混称为助手独立密钥模式的真实账号端到端实测。

## 适用范围

尚未逐个测试填表插件、MVU 更新脚本、长上下文、各个 Go 模型或 TauriTavern。结构化输出与工具调用的成功样例不保证所有角色卡的变量更新正确率。自动拦截不覆盖 XHR、提前缓存的 fetch、Worker 或跨源 iframe；需由调用方接入公开入口。插件始终负责提示词、重试和跨聊天结果写回校验。

## 本机交付

- 已将 0.2.0 更新到本机已安装的同名扩展，更新前逐文件确认安装版与原 0.1.0 一致并备份；运行文件哈希核对通过。只更新本项目文件。
- 刷新后统一入口报告 0.2.0，设置面板只挂载一次。新增直连转发开关默认关闭。
- 在真实宿主皮肤中检查 1280、375、320 像素视口，设置面板无横向溢出；截图已目视核对，保留于本地 `output/playwright/`。
- 独立浏览器检查页关闭后，用户现有页面刷新即可加载新版。

本记录描述 0.2.0 发布前的验证与本机交付结果。公开版本与安装包见 [Releases](https://github.com/demilich1117/SillyTavern-OpenCode-Go/releases)。
