import { CLIENT_VERSION } from '/script.js';
import { MODULE_ID, VERSION, GO_URL, hostCapabilities, inspectEndpoint, sessionIdFor } from './core.js';
import { sha256 } from './sha256.js';
import { createBridge, createProfileRequest } from './bridge.js';
import { installTransport } from './transport.js';

let disposeTransport;
let subscriptions = [];
let lastRequest = '';
let bridgeApi;

function context() { return SillyTavern.getContext(); }

function settings() {
    const ctx = context();
    let value = ctx.extensionSettings[MODULE_ID];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        value = ctx.extensionSettings[MODULE_ID] = {};
    }
    let changed = false;
    if (typeof value.enabled !== 'boolean') { value.enabled = true; changed = true; }
    if (typeof value.directRequests !== 'boolean') { value.directRequests = false; changed = true; }
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
        directRequests: value.directRequests,
        sessionId: sessionIdFor(context(), value.namespace, SillyTavern.libs.sha256 ?? sha256),
        parseYaml: SillyTavern.libs.yaml.parse,
        supportsSecretId: hostCapabilities(CLIENT_VERSION).supportsSecretId,
        isTt: Boolean(globalThis.__TAURITAVERN__),
    };
}

function refresh() {
    const root = document.getElementById(MODULE_ID);
    if (!root) return;
    const value = settings();
    const ctx = context();
    const endpoint = inspectEndpoint(ctx.chatCompletionSettings.custom_url);
    root.querySelector('[data-ocg="enabled"]').checked = value.enabled;
    root.querySelector('[data-ocg="direct"]').checked = value.directRequests;
    let message = '主聊天使用其他连接。';
    if (!value.enabled) message = '自动请求头已关闭。';
    else if (ctx.mainApi === 'openai' && ctx.chatCompletionSettings.chat_completion_source === 'custom') {
        if (globalThis.__TAURITAVERN__ && ctx.chatCompletionSettings.custom_api_format && ctx.chatCompletionSettings.custom_api_format !== 'openai_compat') {
            message = '主聊天使用其他协议。Go 需要 Chat Completions。';
        } else if (endpoint?.plan.startsWith('payg')) message = '主聊天使用 OpenCode 按量计费地址。';
        else if (endpoint?.plan.endsWith('legacy')) message = '主聊天使用旧版 Go 地址。';
        else if (endpoint) message = '主聊天已配置 Go 地址。';
    }
    root.querySelector('[data-ocg="status"]').textContent = message;
    root.querySelector('[data-ocg="session"]').textContent = requestSnapshot().sessionId;
    root.querySelector('[data-ocg="last"]').textContent = lastRequest || '暂无请求';
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
                <label class="checkbox_label"><input type="checkbox" data-ocg="direct">转发本页插件的 OpenCode 直连请求</label>
                <p data-ocg="status" role="status" aria-live="polite"></p>
                <label for="ocg_base_url">OpenCode Go · API 地址</label>
                <input id="ocg_base_url" class="text_pole" readonly value="${GO_URL}">
                <div class="ocg-actions">
                    <button type="button" class="menu_button" data-ocg="apply">主聊天切换到 Go</button>
                    <button type="button" class="menu_button" data-ocg="refresh">检查当前配置</button>
                </div>
                <p class="ocg-note">子模型请在对应插件中填写上方地址。</p>
                <details>
                    <summary>请求状态</summary>
                    <p>当前会话标识</p><code data-ocg="session"></code>
                    <p data-ocg="last"></p>
                </details>
            </div>
        </div>`;
    parent.append(root);
    root.querySelector('[data-ocg="enabled"]').addEventListener('change', event => {
        settings().enabled = event.target.checked;
        context().saveSettingsDebounced();
        refresh();
    });
    root.querySelector('[data-ocg="direct"]').addEventListener('change', event => {
        settings().directRequests = event.target.checked;
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
        globalThis.toastr?.success('主聊天已切换到 Go。');
    });
    refresh();
}

export function activate() {
    if (disposeTransport) return;
    const ctx = context();
    if (!SillyTavern.libs?.yaml?.parse || !ctx.uuidv4 || !ctx.getRequestHeaders) {
        throw new Error('OpenCode Go 连接助手缺少宿主的 YAML、UUID 或请求头接口，请核对酒馆版本。');
    }
    if (globalThis.OpenCodeGo !== undefined) throw new Error('OpenCode Go：统一入口名称已被占用，请检查重复安装。');
    settings();
    const onApplied = request => {
        const kind = { custom: '酒馆自定义连接', proxy: '独立 API / OpenAI 代理', bridge: '插件转发' }[request.kind];
        lastRequest = `${kind} · ${request.operation === 'status' ? '模型列表' : request.stream ? '流式生成' : '普通生成'}`;
        refresh();
    };
    const previousFetch = globalThis.fetch.bind(globalThis);
    let active = true;
    const bridgeFetch = createBridge({
        origin: location.href, snapshot: requestSnapshot, fetchHost: previousFetch,
        getRequestHeaders: () => context().getRequestHeaders(), onApplied, isActive: () => active,
    });
    bridgeApi = Object.freeze({ version: VERSION, fetch: bridgeFetch, captureSession: () => requestSnapshot().sessionId,
        request: createProfileRequest({ bridgeFetch, getProfile: id => context().extensionSettings.connectionManager?.profiles?.find(p => p.id === id) }),
    });
    globalThis.OpenCodeGo = bridgeApi;
    const removeTransport = installTransport(globalThis, {
        origin: location.href,
        snapshot: requestSnapshot,
        directFetch: bridgeFetch,
        onApplied,
        onError: error => globalThis.toastr?.error(error.message),
    });
    disposeTransport = () => { active = false; removeTransport(); };
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
    if (globalThis.OpenCodeGo === bridgeApi) delete globalThis.OpenCodeGo;
    bridgeApi = undefined;
    for (const [source, event, handler] of subscriptions) source.removeListener(event, handler);
    subscriptions = [];
    document.getElementById(MODULE_ID)?.remove();
}

// TT installs its own fetch router before extensions can wrap it.
await (globalThis.__TAURITAVERN__?.ready ?? globalThis.__TAURITAVERN_MAIN_READY__);
// ST 1.14–1.16 only execute the module. Later loaders invoke the manifest hook.
if (hostCapabilities(CLIENT_VERSION).legacyLoader) activate();
