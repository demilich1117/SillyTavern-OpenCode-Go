export const MODULE_ID = 'opencode_go_helper';
export const VERSION = '0.2.0';
export const GO_URL = 'https://opencode.ai/inference/go/openai/v1';
export const PAYG_URL = 'https://opencode.ai/inference/openai/v1';
export const SESSION_HEADER = 'x-opencode-session';
export const USER_AGENT = `SillyTavern-OpenCode-Go/${VERSION}`;

/** Only official, explicitly recognized Chat Completions endpoints are eligible. */
export function inspectEndpoint(raw) {
    let url;
    try { url = new URL(raw); } catch { return null; }
    if (url.protocol !== 'https:' || url.hostname !== 'opencode.ai' || url.port
        || url.username || url.password || url.search || url.hash) return null;
    const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    const plans = new Map([
        ['/inference/go/openai/v1', 'go'],
        ['/inference/openai/v1', 'payg'],
        ['/zen/go/v1', 'go-legacy'],
        ['/zen/v1', 'payg-legacy'],
    ]);
    const plan = plans.get(path);
    return plan ? { baseUrl: `https://opencode.ai${path}`, plan } : null;
}

/** Names stay local. The returned value is hashed before going upstream. */
export function conversationKey(context) {
    const chatId = context.chatId;
    if (chatId === undefined || chatId === null || chatId === '') return null;
    if (context.groupId !== undefined && context.groupId !== null && context.groupId !== '') {
        return JSON.stringify(['group', String(context.groupId), String(chatId)]);
    }
    const avatar = context.characters?.[context.characterId]?.avatar;
    if (!avatar) return null;
    return JSON.stringify(['character', avatar, String(chatId)]);
}

export function sessionIdFor(context, namespace, hash) {
    const key = conversationKey(context);
    // Connection tests without a chat use one stable installation-scoped session.
    return `ses_st_${hash(JSON.stringify([namespace, key ?? 'connection-test'])).slice(0, 32)}`;
}

/** Match the host's YAML object / array-of-objects convention, preserving other headers. */
export function mergeHeaders(source, sessionId, parseYaml, overrides = {}) {
    let parsed;
    try { parsed = source?.trim() ? parseYaml(source) : {}; }
    catch { throw new Error('OpenCode Go：附加请求头不是有效的 YAML / JSON，请先在酒馆连接设置中修正。'); }
    const entries = Array.isArray(parsed) ? parsed : [parsed ?? {}];
    if (entries.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
        throw new Error('OpenCode Go：附加请求头应是 YAML / JSON 对象，或对象列表。');
    }
    const headers = Object.create(null);
    for (const item of entries) {
        for (const [key, value] of Object.entries(item)) {
            // Case-insensitive replacement avoids node-fetch joining two session values.
            if (key.toLowerCase() !== SESSION_HEADER && key.toLowerCase() !== 'user-agent') {
                headers[key] = value;
            }
        }
    }
    for (const [key, value] of Object.entries({ ...overrides, [SESSION_HEADER]: sessionId, 'User-Agent': USER_AGENT })) {
        for (const existing of Object.keys(headers)) {
            if (existing.toLowerCase() === key.toLowerCase()) delete headers[existing];
        }
        headers[key] = value;
    }
    // JSON is valid YAML, and safely quotes user-provided header values.
    return JSON.stringify(headers);
}

export function preparePayload(payload, { enabled, sessionId, parseYaml, operation = 'generate' }) {
    if (!enabled || !payload) return payload;
    const proxy = payload.chat_completion_source === 'openai';
    if (!proxy && payload.chat_completion_source !== 'custom') return payload;
    // The request's source decides its actual destination. Ignore stale custom_url
    // on OpenAI requests, and stale reverse_proxy on Custom requests.
    const endpoint = inspectEndpoint(proxy ? payload.reverse_proxy : payload.custom_url);
    if (!endpoint) return payload;
    const prepared = {
        ...payload,
        chat_completion_source: 'custom',
        // OpenCode's protocol-prefixed /openai/v1/models returns 404. ST appends
        // /models, so status checks use the documented shared catalog base.
        custom_url: operation === 'status' && !endpoint.plan.endsWith('legacy')
            ? 'https://opencode.ai/inference/v1' : endpoint.baseUrl,
        custom_include_headers: mergeHeaders(proxy ? '' : payload.custom_include_headers, sessionId, parseYaml,
            // ST's OpenAI branch cannot forward custom headers. Convert just this
            // request to Custom and explicitly override its otherwise unrelated key.
            proxy ? { Authorization: `Bearer ${payload.proxy_password ?? ''}` } : {}),
    };
    if (proxy) {
        // These settings were inactive in the original OpenAI request. Do not
        // suddenly apply inherited Custom presets or change its credential store.
        for (const key of ['reverse_proxy', 'proxy_password', 'secret_id', 'custom_include_body', 'custom_exclude_body']) {
            delete prepared[key];
        }
    }
    return prepared;
}

// Request objects supplied by same-origin iframes have a different constructor.
export function isRequest(input) {
    return input instanceof Request || Object.prototype.toString.call(input) === '[object Request]';
}

export function isHostRequest(input, init, origin) {
    const raw = isRequest(input) ? input.url : input;
    let url;
    try { url = new URL(raw, origin); } catch { return false; }
    const method = init?.method ?? (isRequest(input) ? input.method : 'GET');
    return method.toUpperCase() === 'POST' && url.origin === origin
        && ['/api/backends/chat-completions/generate', '/api/backends/chat-completions/status'].includes(url.pathname);
}

/** Recognize only the two public HTTP operations the ST bridge can represent. */
export function inspectDirectRequest(input, init) {
    let url;
    try { url = new URL(isRequest(input) ? input.url : input); } catch { return null; }
    const method = (init?.method ?? (isRequest(input) ? input.method : 'GET')).toUpperCase();
    const path = url.pathname.replace(/\/+$/, '');
    const operation = method === 'GET' && path.endsWith('/models') ? 'status'
        : method === 'POST' && path.endsWith('/chat/completions') ? 'generate' : null;
    if (!operation) return null;
    url.pathname = path.replace(operation === 'status' ? /\/models$/ : /\/chat\/completions$/, '');
    // The public catalog is also a valid read-only destination.
    const catalog = operation === 'status' && url.href === 'https://opencode.ai/inference/v1';
    const endpoint = inspectEndpoint(url.href);
    return endpoint || catalog ? { operation, baseUrl: endpoint?.baseUrl ?? url.href } : null;
}
