import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { GO_URL, PAYG_URL, SESSION_HEADER, USER_AGENT, inspectEndpoint, sessionIdFor, mergeHeaders, preparePayload } from '../core.js';
import { installTransport } from '../transport.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const chat = { chatId: '中文聊天', characterId: 0, characters: [{ avatar: 'alice.png' }] };
const options = { enabled: true, sessionId: 'ses_test', parseYaml: parse };
const payload = () => ({ chat_completion_source: 'custom', custom_url: GO_URL, messages: [{ role: 'user', content: 'test' }], stream: true });

test('correct Go and pay-as-you-go paths remain distinct; remove duplicated endpoint suffix', () => {
    assert.equal(inspectEndpoint(GO_URL).plan, 'go');
    assert.equal(inspectEndpoint(PAYG_URL).plan, 'payg');
    assert.equal(inspectEndpoint(`${GO_URL}/chat/completions/`).baseUrl, GO_URL);
    assert.equal(inspectEndpoint(`${GO_URL}///`).baseUrl, GO_URL);
    assert.equal(inspectEndpoint('https://opencode.ai/zen/go/v1').plan, 'go-legacy');
});

test('never inject into unrelated origins, credentials in URLs, or different API protocols', () => {
    for (const url of ['http://opencode.ai/inference/go/openai/v1', 'https://opencode.ai.evil.test/inference/go/openai/v1',
        'https://opencode.ai@evil.test/inference/go/openai/v1', `${GO_URL}?token=abc`, `${GO_URL}#fragment`,
        'https://user:pass@opencode.ai/inference/go/openai/v1', `${GO_URL}/responses`, 'http://localhost:4096',
        'https://opencode.ai:8443/inference/go/openai/v1', 'https://opencode.ai/inference/go/anthropic/v1']) {
        assert.equal(inspectEndpoint(url), null, url);
    }
});

test('stable conversation ID across reload, swipe, regeneration, and character array reorder', () => {
    const first = sessionIdFor(chat, 'namespace-a', hash);
    assert.equal(first, sessionIdFor(JSON.parse(JSON.stringify(chat)), 'namespace-a', hash));
    assert.equal(first, sessionIdFor({ ...chat, swipe_id: 4 }, 'namespace-a', hash));
    assert.equal(first, sessionIdFor({ ...chat, characterId: 1, characters: [{ avatar: 'bob.png' }, chat.characters[0]] }, 'namespace-a', hash));
    assert.match(first, /^ses_st_[a-f0-9]{32}$/);
    assert.ok(!first.includes(chat.chatId));
});

test('new chat, branch, different character, group, and installation are isolated', () => {
    const variants = [chat, { ...chat, chatId: '新聊天' }, { ...chat, chatId: 'branch', chatMetadata: { main_chat: chat.chatId } },
        { ...chat, characters: [{ avatar: 'bob.png' }] }, { ...chat, groupId: 0 }, { ...chat, groupId: 1 }, {}];
    const ids = variants.map(value => sessionIdFor(value, 'namespace-a', hash));
    assert.equal(new Set(ids).size, variants.length);
    assert.notEqual(ids[0], sessionIdFor(chat, 'namespace-b', hash));
    assert.equal(sessionIdFor({}, 'namespace-a', hash), sessionIdFor({}, 'namespace-a', hash));
});

test('YAML headers preserve unrelated values while replacing all case variants of owned headers', () => {
    const source = 'X-Trace: keep\nX-OpenCode-Session: old\nx-opencode-session: older\nuser-agent: old-client\n';
    const result = parse(mergeHeaders(source, 'ses_new', parse));
    assert.deepEqual(result, { 'X-Trace': 'keep', 'x-opencode-session': 'ses_new', 'User-Agent': USER_AGENT });
    assert.equal(mergeHeaders(JSON.stringify(result), 'ses_new', parse), JSON.stringify(result));
});

test('host-supported YAML arrays and JSON header maps keep their values', () => {
    for (const source of ['- X-Trace: keep\n- X-Number: 7', '{"X-Trace":"keep","X-Number":7}']) {
        const result = parse(mergeHeaders(source, 'ses_new', parse));
        assert.equal(result['X-Trace'], 'keep');
        assert.equal(result['X-Number'], 7);
        assert.equal(result[SESSION_HEADER], 'ses_new');
    }
});

test('invalid header settings stop the targeted request instead of discarding existing headers', () => {
    for (const source of ['[invalid', 'plain string', '- not-a-map']) assert.throws(() => mergeHeaders(source, 'ses', parse), /OpenCode Go/);
});

test('request preparation preserves prompt, stream, model, and custom body; never mutates source', () => {
    const original = { ...payload(), custom_url: `${GO_URL}/chat/completions`, model: 'example', custom_include_body: 'foo: bar' };
    const before = structuredClone(original);
    const result = preparePayload(original, options);
    assert.deepEqual(original, before);
    assert.equal(result.messages, original.messages);
    assert.equal(result.stream, true);
    assert.equal(result.model, 'example');
    assert.equal(result.custom_include_body, 'foo: bar');
    assert.equal(result.custom_url, GO_URL);
});

test('disabled helper and other providers return the exact original payload', () => {
    const original = payload();
    assert.equal(preparePayload(original, { ...options, enabled: false }), original);
    for (const value of [{ ...original, chat_completion_source: 'openai' }, { ...original, custom_url: 'https://example.com/v1' }]) {
        assert.equal(preparePayload(value, options), value);
    }
});

test('regression: model checks use the catalog path while Go generation keeps its billing path', () => {
    const original = payload();
    const checked = preparePayload(original, { ...options, operation: 'status' });
    assert.equal(`${checked.custom_url}/models`, 'https://opencode.ai/inference/v1/models');
    assert.equal(`${preparePayload(original, options).custom_url}/chat/completions`, `${GO_URL}/chat/completions`);
    assert.equal(original.custom_url, GO_URL);
});

function harness(snapshot = () => options) {
    const calls = [];
    const response = new Response('data: test\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    const original = async (input, init) => { calls.push([input, init]); return response; };
    const target = { fetch: original };
    const dispose = installTransport(target, { origin: 'http://localhost:8000', snapshot });
    return { target, calls, response, original, dispose };
}

test('normal/streaming generation and model status pass upstream headers in the JSON forwarding field', async () => {
    const h = harness();
    const controller = new AbortController();
    for (const route of ['generate', 'status']) {
        const headers = { 'X-CSRF-Token': 'local-only' };
        const init = { method: 'POST', headers, signal: controller.signal, body: JSON.stringify(payload()) };
        assert.equal(await h.target.fetch(`/api/backends/chat-completions/${route}`, init), h.response);
        const sent = h.calls.at(-1)[1];
        assert.equal(sent.headers, headers);
        assert.equal(sent.signal, controller.signal);
        assert.equal(parse(JSON.parse(sent.body).custom_include_headers)[SESSION_HEADER], options.sessionId);
        assert.equal(JSON.parse(sent.body).custom_url, route === 'status' ? 'https://opencode.ai/inference/v1' : GO_URL);
        assert.equal(init.body, JSON.stringify(payload()));
    }
    controller.abort();
    assert.equal(h.calls[0][1].signal.aborted, true);
});

test('Request objects preserve original request options and snapshot session before asynchronous reads', async () => {
    let currentSession = 'session-a';
    const h = harness(() => ({ ...options, sessionId: currentSession }));
    const request = new Request('http://localhost:8000/api/backends/chat-completions/generate', {
        method: 'POST', body: JSON.stringify(payload()), headers: { 'X-CSRF-Token': 'token' }, credentials: 'include',
    });
    const pending = h.target.fetch(request);
    currentSession = 'session-b';
    await pending;
    assert.equal(request.bodyUsed, false);
    const forwarded = new Request(...h.calls[0]);
    assert.equal(forwarded.credentials, 'include');
    assert.equal(forwarded.headers.get('X-CSRF-Token'), 'token');
    assert.equal(parse((await forwarded.json()).custom_include_headers)[SESSION_HEADER], 'session-a');
});

test('other routes/origins/methods and non-JSON bodies are untouched', async () => {
    const h = harness();
    for (const [url, init] of [
        ['https://example.com/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(payload()) }],
        ['/api/settings/save', { method: 'POST', body: JSON.stringify(payload()) }],
        ['/api/backends/chat-completions/generate', { method: 'GET' }],
        ['/api/backends/chat-completions/generate', { method: 'POST', body: 'not-json' }],
    ]) {
        await h.target.fetch(url, init);
        assert.equal(h.calls.at(-1)[1], init);
    }
});

test('disable removes own fetch wrapper, and respects wrappers installed by other extensions', async () => {
    const h = harness();
    h.dispose();
    assert.equal(h.target.fetch, h.original);
    const h2 = harness();
    const ours = h2.target.fetch;
    const thirdParty = (...args) => ours(...args);
    h2.target.fetch = thirdParty;
    h2.dispose();
    assert.equal(h2.target.fetch, thirdParty);
    const init = { method: 'POST', body: JSON.stringify(payload()) };
    await h2.target.fetch('/api/backends/chat-completions/generate', init);
    assert.equal(h2.calls[0][1], init);
});

test('malformed headers reject without making a network call', async () => {
    const h = harness();
    await assert.rejects(() => h.target.fetch('/api/backends/chat-completions/generate', {
        method: 'POST', body: JSON.stringify({ ...payload(), custom_include_headers: '[bad' }),
    }), /OpenCode Go/);
    assert.equal(h.calls.length, 0);
});
