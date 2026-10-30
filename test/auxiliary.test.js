import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { GO_URL, PAYG_URL, SESSION_HEADER, USER_AGENT, preparePayload, inspectDirectRequest } from '../core.js';
import { createBridge, createProfileRequest } from '../bridge.js';
import { installTransport } from '../transport.js';

const options = { enabled: true, sessionId: `ses_st_${'a'.repeat(32)}`, parseYaml: parse };
const messages = [{ role: 'user', content: 'synthetic auxiliary request' }];
const proxy = () => ({ chat_completion_source: 'openai', reverse_proxy: GO_URL,
    proxy_password: 'synthetic-key', model: 'deepseek-v4.1-flash', messages, stream: false });

test('TavernHelper default OpenAI proxy converts generation and status, preserving its key', () => {
    for (const operation of ['generate', 'status']) {
        const original = proxy();
        const before = structuredClone(original);
        const result = preparePayload(original, { ...options, operation });
        assert.equal(result.chat_completion_source, 'custom');
        assert.equal(result.custom_url, operation === 'status' ? 'https://opencode.ai/inference/v1' : GO_URL);
        assert.deepEqual(parse(result.custom_include_headers), {
            Authorization: 'Bearer synthetic-key', [SESSION_HEADER]: options.sessionId, 'User-Agent': USER_AGENT,
        });
        assert.equal(result.proxy_password, undefined);
        assert.equal(result.reverse_proxy, undefined);
        assert.equal(result.messages, original.messages);
        assert.deepEqual(original, before);
    }
});

test('converted proxy cannot inherit inactive Custom credentials or preset overrides', () => {
    for (const key of ['', undefined]) {
        const result = preparePayload({ ...proxy(), proxy_password: key, secret_id: 'different-secret',
            custom_url: 'https://unrelated.test/v1', custom_include_headers: '[invalid stale YAML',
            custom_include_body: 'model: wrong', custom_exclude_body: '- messages' }, options);
        assert.equal(parse(result.custom_include_headers).Authorization, 'Bearer ');
        for (const field of ['secret_id', 'custom_include_body', 'custom_exclude_body']) assert.equal(result[field], undefined);
    }
});

test('routing follows the source, never a stale endpoint from the other API mode', () => {
    const values = [
        { ...proxy(), reverse_proxy: 'https://other.test/v1', custom_url: GO_URL },
        { ...proxy(), reverse_proxy: '', custom_url: GO_URL },
        { ...proxy(), chat_completion_source: 'claude' },
        { ...proxy(), chat_completion_source: 'deepseek' },
        { ...proxy(), chat_completion_source: 'custom', custom_url: 'https://other.test/v1' },
    ];
    for (const value of values) assert.equal(preparePayload(value, options), value);
    assert.equal(preparePayload(proxy(), { ...options, enabled: false }).chat_completion_source, 'openai');
    assert.equal(preparePayload({ ...proxy(), reverse_proxy: PAYG_URL }, options).custom_url, PAYG_URL);
});

test('tool calls, schema, reasoning and stream flags survive auxiliary request conversion', () => {
    const original = { ...proxy(), stream: true, tools: [{ type: 'function', function: { name: 'update' } }],
        tool_choice: 'required', json_schema: { name: 'update', value: { type: 'object' } }, include_reasoning: true,
        reasoning_effort: 'low', max_tokens: 900, custom_prompt_post_processing: 'merge' };
    const result = preparePayload(original, options);
    for (const key of ['tools', 'tool_choice', 'json_schema', 'include_reasoning', 'reasoning_effort', 'max_tokens', 'stream', 'custom_prompt_post_processing']) {
        assert.equal(result[key], original[key]);
    }
    assert.deepEqual(preparePayload(result, options), result);
});

test('direct route allowlist excludes other hosts, protocols, credentials and query strings', () => {
    assert.equal(inspectDirectRequest(`${GO_URL}/chat/completions`, { method: 'POST' }).operation, 'generate');
    assert.equal(inspectDirectRequest(`${GO_URL}/models`).operation, 'status');
    assert.equal(inspectDirectRequest('https://opencode.ai/inference/v1/models').operation, 'status');
    for (const url of [`${GO_URL}/responses`, `${GO_URL}/chat/completions?secret=x`,
        `${GO_URL}/chat/completions#x`, 'https://opencode.ai.evil.test/inference/go/openai/v1/chat/completions',
        'https://user:pass@opencode.ai/inference/go/openai/v1/chat/completions',
        'http://opencode.ai/inference/go/openai/v1/chat/completions',
        'https://opencode.ai/inference/go/anthropic/v1/messages']) {
        assert.equal(inspectDirectRequest(url, { method: 'POST' }), null);
    }
    assert.equal(inspectDirectRequest(`${GO_URL}/chat/completions`, { method: 'GET' }), null);
});

function harness(overrides = {}) {
    const calls = [], events = [];
    const response = new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { headers: { 'Content-Type': 'application/json' } });
    const state = { enabled: true, active: true, sessionId: options.sessionId };
    const bridge = createBridge({ origin: 'http://localhost:8000', snapshot: () => ({ ...options, ...state }),
        isActive: () => state.active, getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'local-csrf' }),
        fetchHost: async (input, init) => { calls.push([input, init]); return response; }, onApplied: data => events.push(data), ...overrides });
    return { bridge, calls, events, response, state };
}
const directInit = (body = {}) => ({ method: 'POST', headers: { Authorization: 'Bearer direct-key' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages, ...body }) });

test('direct bridge preserves full JSON, own auth and structured output without exposing CSRF upstream', async () => {
    const h = harness();
    const init = directInit({ temperature: 0.2, response_format: { type: 'json_object' },
        tools: [{ type: 'function', function: { name: 'update' } }], tool_choice: 'auto', reasoning: { effort: 'low' } });
    init.headers.Cookie = 'local-cookie';
    init.headers['X-CSRF-Token'] = 'must-not-forward';
    const result = await h.bridge(`${GO_URL}/chat/completions`, init);
    assert.equal(result, h.response);
    const [url, request] = h.calls[0];
    assert.equal(url, 'http://localhost:8000/api/backends/chat-completions/generate');
    assert.equal(request.headers.Authorization, undefined);
    assert.equal(request.headers['X-CSRF-Token'], 'local-csrf');
    const sent = JSON.parse(request.body);
    assert.deepEqual(parse(sent.custom_include_body), JSON.parse(init.body));
    const headers = parse(sent.custom_include_headers);
    assert.equal(headers.Authorization, 'Bearer direct-key');
    assert.equal(headers.Cookie, undefined);
    assert.equal(headers['X-CSRF-Token'], undefined);
    assert.equal(headers[SESSION_HEADER], options.sessionId);
    assert.equal(sent.secret_id, undefined);
    assert.equal(sent.custom_prompt_post_processing, undefined);
    assert.deepEqual(h.events, [{ stream: false, operation: 'generate', kind: 'bridge' }]);
});

test('anonymous direct model checks override the saved Custom key and use the public catalog', async () => {
    const h = harness();
    for (const url of [`${GO_URL}/models`, 'https://opencode.ai/inference/v1/models']) {
        await h.bridge(url);
        const sent = JSON.parse(h.calls.at(-1)[1].body);
        assert.equal(sent.custom_url, 'https://opencode.ai/inference/v1');
        assert.equal(parse(sent.custom_include_headers).Authorization, '');
        assert.ok(parse(sent.custom_include_headers)[SESSION_HEADER]);
    }
});

test('native profile bridge uses an explicit secret reference without retrieving keys or changing connections', async () => {
    const h = harness();
    const profile = { id: 'profile-test', api: 'custom', 'api-url': GO_URL, model: 'saved-model', 'secret-id': 'secret-reference' };
    const before = structuredClone(profile);
    const request = createProfileRequest({ bridgeFetch: h.bridge, getProfile: id => id === profile.id ? profile : null });
    await request(profile.id, { messages, response_format: { type: 'json_object' } });
    const payload = JSON.parse(h.calls[0][1].body);
    assert.equal(payload.secret_id, 'secret-reference');
    assert.equal(Object.hasOwn(parse(payload.custom_include_headers), 'Authorization'), false);
    assert.equal(parse(payload.custom_include_body).model, profile.model);
    assert.deepEqual(profile, before);
    await assert.rejects(request('missing', { messages }), /连接档案/);
    profile['api-url'] = 'https://unrelated.test/v1';
    await assert.rejects(request(profile.id, { messages }), /连接档案/);
    await assert.rejects(h.bridge(`${GO_URL}/chat/completions`, directInit(), { secretId: 'secret-reference' }), /Authorization/);
    assert.equal(h.calls.length, 1);
});

test('explicit background session is stable after chat changes and does not mutate snapshot', async () => {
    const h = harness();
    const captured = h.state.sessionId;
    h.state.sessionId = `ses_st_${'b'.repeat(32)}`;
    await h.bridge(`${GO_URL}/chat/completions`, directInit(), { sessionId: captured });
    const sent = JSON.parse(h.calls[0][1].body);
    assert.equal(parse(sent.custom_include_headers)[SESSION_HEADER], captured);
    assert.notEqual(h.state.sessionId, captured);
    await assert.rejects(h.bridge(`${GO_URL}/chat/completions`, directInit(), { sessionId: 'bad\r\nheader' }), /captureSession/);
});

test('bridge streams are not consumed; Request auth, cancellation and original body are preserved', async () => {
    const response = new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    let forwarded;
    const h = harness({ fetchHost: async (input, init) => { forwarded = init; return response; } });
    const controller = new AbortController();
    const input = new Request(`${GO_URL}/chat/completions`, { ...directInit({ stream: true }), signal: controller.signal });
    assert.equal(await h.bridge(input), response);
    assert.equal(response.bodyUsed, false);
    assert.equal(input.bodyUsed, false);
    assert.equal(parse(JSON.parse(forwarded.body).custom_include_headers).Authorization, 'Bearer direct-key');
    controller.abort();
    assert.equal(forwarded.signal.aborted, true);
    await assert.rejects(h.bridge(input), { name: 'AbortError' });
});

test('invalid, disabled and deactivated bridge calls fail before network access', async () => {
    const h = harness();
    for (const body of ['not json', '[]', '{}', JSON.stringify({ model: 'm', messages, stream: 'yes' })]) {
        await assert.rejects(h.bridge(`${GO_URL}/chat/completions`, { method: 'POST', body }), /JSON/);
    }
    await assert.rejects(h.bridge('https://unrelated.test/v1/models'), /官方/);
    h.state.enabled = false;
    await assert.rejects(h.bridge(`${GO_URL}/models`), /停用/);
    h.state.enabled = true; h.state.active = false;
    await assert.rejects(h.bridge(`${GO_URL}/models`), /停用/);
    assert.equal(h.calls.length, 0);
});

test('bridge restores missing SSE content type without pre-reading the host stream', async () => {
    const encoder = new TextEncoder();
    const source = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); } });
    const upstream = new Response(source);
    const h = harness({ fetchHost: async () => upstream });
    const response = await h.bridge(`${GO_URL}/chat/completions`, directInit({ stream: true }));
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.equal(response.body, upstream.body);
    assert.equal(response.bodyUsed, false);
    assert.equal(await response.text(), 'data: [DONE]\n\n');
});

test('ST upstream errors inside HTTP 200 become explicit bridge errors without guessing upstream status', async () => {
    const h = harness({ fetchHost: async () => new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), {
        headers: { 'Content-Type': 'application/json' },
    }) });
    for (const stream of [false, true]) {
        const response = await h.bridge(`${GO_URL}/chat/completions`, directInit({ stream }));
        assert.equal(response.status, 502);
        assert.deepEqual(await response.json(), { error: { message: 'Unauthorized' } });
    }
});

test('direct interception is opt-in and disable restores pass-through; diagnostics exclude secrets', async () => {
    const calls = [], diagnostics = [];
    let directRequests = false, enabled = true;
    const original = async (...args) => { calls.push(args); return 'original'; };
    const target = { fetch: original };
    const dispose = installTransport(target, { origin: 'http://localhost:8000',
        snapshot: () => ({ ...options, directRequests, enabled }), directFetch: async () => 'bridge', onApplied: x => diagnostics.push(x) });
    const url = `${GO_URL}/chat/completions`;
    assert.equal(await target.fetch(url, directInit()), 'original');
    directRequests = true;
    assert.equal(await target.fetch(url, directInit()), 'bridge');
    assert.equal(await target.fetch('https://other.test/v1/chat/completions', directInit()), 'original');
    await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(proxy()) });
    assert.deepEqual(diagnostics, [{ stream: false, operation: 'generate', kind: 'proxy' }]);
    enabled = false;
    assert.equal(await target.fetch(url, directInit()), 'original');
    dispose(); assert.equal(target.fetch, original);
});
