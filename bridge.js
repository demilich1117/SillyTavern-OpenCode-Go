import { inspectDirectRequest, inspectEndpoint, isRequest, mergeHeaders, preparePayload } from './core.js';

/** Explicit bridge for plugins / same-origin frames; never reads or saves keys. */
export function createBridge({ origin, snapshot, fetchHost, getRequestHeaders, onApplied = () => {}, isActive = () => true }) {
    return async function (input, init, { sessionId, secretId } = {}) {
        const options = { ...snapshot() }; // Capture before any asynchronous body reads.
        if (!isActive() || !options.enabled) throw new Error('OpenCode Go：连接助手已停用。');
        if (sessionId !== undefined) {
            if (typeof sessionId !== 'string' || !/^ses_st_[a-f0-9]{32}$/.test(sessionId)) {
                throw new Error('OpenCode Go：请使用 captureSession() 返回的会话标识。');
            }
            options.sessionId = sessionId;
        }
        const route = inspectDirectRequest(input, init);
        if (!route) throw new Error('OpenCode Go：转发入口只支持官方 Chat Completions 和模型列表地址。');
        const request = isRequest(input) ? input : null;
        const signal = init && Object.hasOwn(init, 'signal') ? init.signal : request?.signal;
        signal?.throwIfAborted();
        const upstreamHeaders = new Headers(init?.headers ?? request?.headers);
        // A direct caller without a key must not inherit ST's Custom API secret.
        // Copy only end-to-end upstream headers; browser/host credentials stay local.
        const headers = { Authorization: upstreamHeaders.get('authorization') ?? '' };
        if (secretId !== undefined) {
            if (typeof secretId !== 'string' || !secretId || upstreamHeaders.has('authorization')) {
                throw new Error('OpenCode Go：请使用一个原生自定义密钥 ID，且不要同时提供 Authorization。');
            }
            delete headers.Authorization;
        }
        for (const [key, value] of upstreamHeaders) {
            if (/^(authorization|accept|content-type|user-agent|x-opencode-[a-z0-9-]+|x-request-id|x-client-request-id|openai-[a-z0-9-]+)$/.test(key)) {
                if (key !== 'authorization') headers[key] = value;
            }
        }
        let body;
        if (route.operation === 'generate') {
            const raw = init?.body ?? (request ? await request.clone().text() : undefined);
            try { body = typeof raw === 'string' ? JSON.parse(raw) : null; } catch { /* validated below */ }
            if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.messages)
                || typeof body.model !== 'string' || !body.model || (body.stream !== undefined && typeof body.stream !== 'boolean')) {
                throw new Error('OpenCode Go：转发请求需要 JSON 字符串、model 和 messages 数组。');
            }
        }
        signal?.throwIfAborted();
        // The entire upstream JSON is applied last by ST. No current model,
        // generation preset, post-processing or API credentials are imported.
        const payload = preparePayload({
            chat_completion_source: 'custom', custom_url: route.baseUrl,
            custom_include_headers: JSON.stringify(headers),
            ...(secretId !== undefined ? { secret_id: secretId } : {}),
            ...(body ? { model: body.model, stream: body.stream ?? false, messages: body.messages,
                custom_include_body: JSON.stringify(body), custom_exclude_body: JSON.stringify(['logprobs', 'top_logprobs'].filter(key => !Object.hasOwn(body, key))) } : {}),
        }, { ...options, operation: route.operation });
        // Public catalog URLs bypass preparePayload's generation allowlist.
        payload.custom_include_headers = mergeHeaders(payload.custom_include_headers, options.sessionId, options.parseYaml);
        onApplied({ stream: Boolean(body?.stream), operation: route.operation, kind: 'bridge' });
        const response = await fetchHost(new URL(`/api/backends/chat-completions/${route.operation}`, origin).href, {
            method: 'POST', headers: getRequestHeaders(), credentials: 'same-origin', cache: 'no-store',
            body: JSON.stringify(payload), signal,
        });
        // ST 1.19 returns HTTP 200 for some upstream errors. A fetch-style caller
        // needs a failed status; the original upstream code is not recoverable.
        if (response.ok && (!body?.stream || response.headers.get('content-type')?.includes('application/json'))) {
            let data;
            try { data = await response.clone().json(); } catch { return response; }
            if (data?.error) return new Response(JSON.stringify(data), {
                status: 502, statusText: 'OpenCode bridge error', headers: { 'Content-Type': 'application/json' },
            });
        }
        // ST's streaming forwarder may omit Content-Type. Supply the SSE type
        // without buffering, teeing or consuming a successful response stream.
        if (response.ok && body?.stream && !response.headers.has('content-type') && response.body) {
            const headers = new Headers(response.headers);
            headers.set('Content-Type', 'text/event-stream; charset=utf-8');
            return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        }
        return response;
    };
}

/** Resolve an explicit native profile without selecting it or exposing its key. */
export function createProfileRequest({ getProfile, bridgeFetch }) {
    return async (profileId, body, { signal, sessionId } = {}) => {
        if (typeof profileId !== 'string' || !profileId) throw new Error('OpenCode Go：请指定连接档案 ID。');
        const profile = getProfile(profileId);
        const endpoint = profile?.api === 'custom' ? inspectEndpoint(profile['api-url']) : null;
        if (!endpoint || !profile['secret-id']) throw new Error('OpenCode Go：连接档案必须使用官方自定义地址并关联原生密钥。');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('OpenCode Go：请提供 Chat Completions 请求体。');
        return bridgeFetch(`${endpoint.baseUrl}/chat/completions`, {
            method: 'POST', body: JSON.stringify({ model: profile.model, ...body }), signal,
        }, { sessionId, secretId: profile['secret-id'] });
    };
}
