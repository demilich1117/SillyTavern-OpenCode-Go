import { MODULE_ID, GO_URL, inspectEndpoint, sessionIdFor } from './core.js';
import { installTransport } from './transport.js';

let disposeTransport;
let subscriptions = [];
let lastRequest = '';

function context() { return SillyTavern.getContext(); }

function settings() {
    const ctx = context();
    let value = ctx.extensionSettings[MODULE_ID];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        value = ctx.extensionSettings[MODULE_ID] = {};
    }
    let changed = false;
    if (typeof value.enabled !== 'boolean') { value.enabled = true; changed = true; }
    if (typeof value.namespace !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(value.namespace)) {
        value.namespace = ctx.uuidv4();
        changed = true;
    }
    if (changed) ctx.saveSettingsDebounced();
    return value;
}

function requestSnapshot() {
    const value = settings();
    return {
        enabled: value.enabled,
        sessionId: sessionIdFor(context(), value.namespace, SillyTavern.libs.sha256),
        parseYaml: SillyTavern.libs.yaml.parse,
    };
}

function refresh() {
    const root = document.getElementById(MODULE_ID);
    if (!root) return;
    const value = settings();
    const ctx = context();
    const endpoint = inspectEndpoint(ctx.chatCompletionSettings.custom_url);
    root.querySelector('[data-ocg="enabled"]').checked = value.enabled;
    let message = '请在 API 连接中选择「聊天补全 → 自定义（OpenAI 兼容）」。';
    if (!value.enabled) message = '自动请求头已关闭。';
    else if (ctx.mainApi === 'openai' && ctx.chatCompletionSettings.chat_completion_source === 'custom') {
        if (!endpoint) message = '当前 URL 不是支持的 OpenCode 官方接口。可点击下方按钮配置 Go。';
        else if (endpoint.plan.startsWith('payg')) message = '当前是按量计费地址。你使用 Go 订阅，请应用下方 Go 地址。';
        else if (endpoint.plan.endsWith('legacy')) message = '当前是旧版 Go 地址，建议应用下方新版地址。';
        else message = 'Go 地址正确；发送时将自动补充会话请求头。';
    }
    root.querySelector('[data-ocg="status"]').textContent = message;
    root.querySelector('[data-ocg="session"]').textContent = requestSnapshot().sessionId;
    root.querySelector('[data-ocg="last"]').textContent = lastRequest || '尚未处理请求。连接配置正确不等于账号鉴权已通过。';
}

function mount() {
    if (document.getElementById(MODULE_ID)) { refresh(); return; }
    const parent = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!parent) return;
    const root = document.createElement('div');
    root.id = MODULE_ID;
    // Static markup only; all dynamic data is assigned through textContent.
    root.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>OpenCode Go 连接助手</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input type="checkbox" data-ocg="enabled">自动附加会话请求头</label>
                <p data-ocg="status" role="status" aria-live="polite"></p>
                <label for="ocg_base_url">OpenCode Go · API 地址</label>
                <input id="ocg_base_url" class="text_pole" readonly value="${GO_URL}">
                <div class="ocg-actions">
                    <button type="button" class="menu_button" data-ocg="apply">应用 Go 地址</button>
                    <button type="button" class="menu_button" data-ocg="refresh">检查当前配置</button>
                </div>
                <p class="ocg-note">密钥请填在酒馆「自定义 API 密钥」栏。应用地址会切换到聊天补全的自定义来源，保留当前模型和密钥。</p>
                <details>
                    <summary>请求状态</summary>
                    <p>当前会话标识</p><code data-ocg="session"></code>
                    <p data-ocg="last"></p>
                    <p class="ocg-note">同一聊天的续写、重生成和滑动回复共用标识。新聊天或分支使用新标识；聊天重命名也会更换标识。未打开聊天时，测试和模型检查使用独立固定标识。</p>
                    <p class="ocg-note">模型列表来自 OpenCode 公共目录，可能包含 Go 套餐以外的模型；请按自己的 Go 模型权限选择。</p>
                </details>
            </div>
        </div>`;
    parent.append(root);
    root.querySelector('[data-ocg="enabled"]').addEventListener('change', event => {
        settings().enabled = event.target.checked;
        context().saveSettingsDebounced();
        refresh();
    });
    root.querySelector('[data-ocg="refresh"]').addEventListener('click', refresh);
    root.querySelector('[data-ocg="apply"]').addEventListener('click', () => {
        // Host input events keep UI, connection state, and settings in sync.
        const $ = globalThis.jQuery;
        const api = document.getElementById('main_api');
        const source = document.getElementById('chat_completion_source');
        const url = document.getElementById('custom_api_url_text');
        if (!$ || !api || !source || !url) {
            globalThis.toastr?.error('找不到酒馆连接设置，请手动填写上方 Go 地址。');
            return;
        }
        // Set the URL first, because source changes may immediately start a model check.
        $(url).val(GO_URL).trigger('input');
        $(source).val('custom').trigger('change');
        $(api).val('openai').trigger('change');
        refresh();
        globalThis.toastr?.success('已应用 Go 地址。请核对自定义 API 密钥和模型，再发送测试消息。');
    });
    refresh();
}

export function activate() {
    if (disposeTransport) return;
    const ctx = context();
    if (!SillyTavern.libs.yaml?.parse || !SillyTavern.libs.sha256 || !ctx.uuidv4) {
        throw new Error('OpenCode Go 连接助手需要 SillyTavern 1.19.0 的 YAML、SHA-256 和 UUID 接口。');
    }
    settings();
    disposeTransport = installTransport(globalThis, {
        origin: location.origin,
        snapshot: requestSnapshot,
        onApplied: payload => {
            lastRequest = `最近已附加请求头：${payload.stream ? '流式请求' : '普通请求 / 模型检查'}。服务端是否接受，请查看酒馆返回结果。`;
            refresh();
        },
        onError: error => globalThis.toastr?.error(error.message),
    });
    const events = ctx.eventTypes ?? ctx.event_types;
    for (const name of ['APP_READY', 'CHAT_CHANGED', 'CHATCOMPLETION_SOURCE_CHANGED', 'CHATCOMPLETION_PRESET_CHANGED_AFTER']) {
        if (!events[name]) continue;
        const handler = () => { lastRequest = ''; mount(); };
        ctx.eventSource.on(events[name], handler);
        subscriptions.push([ctx.eventSource, events[name], handler]);
    }
    mount();
}

export function deactivate() {
    disposeTransport?.();
    disposeTransport = undefined;
    for (const [source, event, handler] of subscriptions) source.removeListener(event, handler);
    subscriptions = [];
    document.getElementById(MODULE_ID)?.remove();
}
