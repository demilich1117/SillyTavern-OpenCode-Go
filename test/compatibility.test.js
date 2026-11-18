import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { sha256 } from '../sha256.js';
import { GO_URL, hostCapabilities, isHostRequest, preparePayload } from '../core.js';
import { createBridge } from '../bridge.js';

test('legacy session hashing matches SHA-256 for Unicode and padded block boundaries', () => {
    for (const text of ['', '聊天😀', ...[55, 56, 63, 64, 65, 120, 4096].map(n => 'a'.repeat(n))]) {
        assert.equal(sha256(text), createHash('sha256').update(text).digest('hex'));
    }
});

test('host loader and per-request credential support change in different releases', () => {
    for (const minor of [14, 15, 16, 17, 18, 19]) {
        assert.deepEqual(hostCapabilities(`SillyTavern:1.${minor}.0:Cohee#1207`), {
            legacyLoader: minor < 17, supportsSecretId: minor >= 18,
        });
    }
    assert.equal(hostCapabilities('SillyTavern:UNKNOWN:TauriTavern').supportsSecretId, false);
    assert.equal(hostCapabilities('SillyTavern:1.18.0:TauriTavern').supportsSecretId, true);
});

const settings = { enabled: true, sessionId: 'ses_st_' + 'a'.repeat(32), parseYaml: parse };
const custom = { chat_completion_source: 'custom', custom_url: GO_URL };

test('legacy hosts allow native Custom and independent proxy credentials but reject explicit secret IDs', async () => {
    const options = { ...settings, supportsSecretId: false };
    assert.equal(preparePayload(custom, options).custom_url, GO_URL);
    assert.throws(() => preparePayload({ ...custom, secret_id: 'other' }, options), /按 ID/);
    const proxy = { chat_completion_source: 'openai', reverse_proxy: GO_URL, proxy_password: 'fixture', secret_id: 'inactive' };
    assert.equal(parse(preparePayload(proxy, options).custom_include_headers).Authorization, 'Bearer fixture');
    const bridge = createBridge({ snapshot: () => options, fetchHost: assert.fail, getRequestHeaders: assert.fail });
    for (const base of [GO_URL, 'https://opencode.ai/inference/v1']) {
        await assert.rejects(bridge(base + '/models', {}, { secretId: 'other' }), /按 ID/);
    }
});

test('TT respects custom protocols, object headers and Custom reverse proxy credentials', () => {
    const options = { ...settings, isTt: true, operation: 'status' };
    const responses = { ...custom, custom_api_format: 'openai_responses' };
    assert.equal(preparePayload(responses, options), responses);
    const input = { ...custom, custom_url: '', reverse_proxy: GO_URL, proxy_password: 'fixture',
        custom_include_headers: { 'X-Caller': 'fixture' } };
    const output = preparePayload(input, options);
    assert.equal(output.custom_url, '');
    assert.equal(output.reverse_proxy, 'https://opencode.ai/inference/v1');
    assert.equal(output.proxy_password, input.proxy_password);
    assert.equal(parse(output.custom_include_headers)['X-Caller'], 'fixture');
    assert.equal(preparePayload(input, settings), input);
});

test('TT bridge uses isolated proxy credentials for anonymous requests and native IDs for saved profiles', async () => {
    const calls = [];
    const bridge = createBridge({ origin: 'tauri://localhost/index.html', snapshot: () => ({ ...settings, isTt: true }),
        getRequestHeaders: () => ({}), fetchHost: async (url, init) => {
            calls.push([url, JSON.parse(init.body)]);
            return Response.json({});
        } });
    await bridge(GO_URL + '/models');
    const [url, anonymous] = calls[0];
    assert.equal(url, 'tauri://localhost/api/backends/chat-completions/status');
    assert.equal(anonymous.reverse_proxy, 'https://opencode.ai/inference/v1');
    assert.equal(anonymous.custom_url, '');
    assert.equal(anonymous.proxy_password, '');
    await bridge(GO_URL + '/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [], model: 'test' }) }, { secretId: 'profile-key' });
    assert.equal(calls[1][1].type, 'quiet');
    assert.equal(calls[1][1].secret_id, 'profile-key');
    assert.equal(calls[1][1].custom_url, GO_URL);
});

test('opaque URL origins still distinguish TT schemes and authorities', () => {
    const page = 'tauri://localhost/index.html';
    const route = '/api/backends/chat-completions/generate';
    const post = { method: 'POST' };
    assert.equal(isHostRequest(route, post, page), true);
    for (const other of ['tauri://another', 'other://localhost', 'https://localhost']) {
        assert.equal(isHostRequest(other + route, post, page), false);
    }
});
