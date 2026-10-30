export const MODULE_ID = 'opencode_go_helper';
export const VERSION = '0.1.0';
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
export function mergeHeaders(source, sessionId, parseYaml) {
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
    headers[SESSION_HEADER] = sessionId;
    headers['User-Agent'] = USER_AGENT;
    // JSON is valid YAML, and safely quotes user-provided header values.
    return JSON.stringify(headers);
}

export function preparePayload(payload, { enabled, sessionId, parseYaml, operation = 'generate' }) {
    if (!enabled || !payload || payload.chat_completion_source !== 'custom') return payload;
    const endpoint = inspectEndpoint(payload.custom_url);
    if (!endpoint) return payload;
    return {
        ...payload,
        // OpenCode's protocol-prefixed /openai/v1/models returns 404. ST appends
        // /models, so status checks use the documented shared catalog base.
        custom_url: operation === 'status' && !endpoint.plan.endsWith('legacy')
            ? 'https://opencode.ai/inference/v1' : endpoint.baseUrl,
        custom_include_headers: mergeHeaders(payload.custom_include_headers, sessionId, parseYaml),
    };
}

export function isHostRequest(input, init, origin) {
    const raw = input instanceof Request ? input.url : input;
    let url;
    try { url = new URL(raw, origin); } catch { return false; }
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    return method.toUpperCase() === 'POST' && url.origin === origin
        && ['/api/backends/chat-completions/generate', '/api/backends/chat-completions/status'].includes(url.pathname);
}
