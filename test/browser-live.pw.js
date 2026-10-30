// Opt-in live check: uses only the existing OCG profile, three short synthetic
// prompts, and a native secret reference. The key never enters the browser.
async (page) => {
    await page.waitForFunction(() => globalThis.SillyTavern?.getContext().extensionSettings.connectionManager?.profiles?.some(p => p.name === 'OCG')
        && document.getElementById('opencode_go_helper'), undefined, { timeout: 20000 });
    const webBase = '/scripts/extensions/third-party/ocg-local-test/';
    for (const file of ['index.js', 'core.js', 'transport.js', 'bridge.js']) {
        await page.route(`**${webBase}${file}`, route => route.fulfill({ path: `./${file}`, contentType: 'text/javascript' }));
    }
    return await page.evaluate(async ({ webBase }) => {
        globalThis.ocgTestCleanup?.();
        const actual = SillyTavern.getContext();
        const profile = actual.extensionSettings.connectionManager?.profiles?.find(p => p.name === 'OCG');
        const baseUrl = 'https://opencode.ai/inference/go/openai/v1';
        if (!profile || profile['api-url'] !== baseUrl || !profile['secret-id']) throw Error('Expected saved Go profile is unavailable');
        const installed = await import('/scripts/extensions/third-party/SillyTavern-OpenCode-Go/index.js');
        installed.deactivate();
        const originalGetContext = SillyTavern.getContext;
        const shadow = { ...actual, chatId: 'ocg-auxiliary-live-fixture', characterId: 0, groupId: undefined,
            characters: [{ avatar: 'ocg-auxiliary-fixture.png' }],
            extensionSettings: { ...actual.extensionSettings, opencode_go_helper: { ...actual.extensionSettings.opencode_go_helper, enabled: true } },
            saveSettingsDebounced: () => {},
        };
        SillyTavern.getContext = () => ({ ...shadow });
        const module = await import(`${webBase}index.js`);
        const results = [];
        try {
            module.activate();
            const modelResponse = await OpenCodeGo.fetch(`${baseUrl}/models`, undefined, { secretId: profile['secret-id'] });
            const models = await modelResponse.json();
            results.push({ path: 'bridge-model-list', status: modelResponse.status, containsModel: models.data?.some(m => m.id === profile.model) });
            const schema = { name: 'auxiliary_test', strict: true, schema: { type: 'object', properties: {
                ok: { type: 'boolean' }, count: { type: 'integer' },
            }, required: ['ok', 'count'], additionalProperties: false } };
            const response = await OpenCodeGo.request(profile.id, { stream: false, max_tokens: 512,
                response_format: { type: 'json_schema', json_schema: schema },
                messages: [{ role: 'user', content: 'Unit test fixture: return JSON with ok=true and count=2.' }],
            }, { signal: AbortSignal.timeout(45000) });
            const json = await response.json();
            const parsed = JSON.parse(json.choices?.[0]?.message?.content ?? '{}');
            results.push({ path: 'profile-json-schema', status: response.status, valid: parsed.ok === true && parsed.count === 2,
                billing: json.usage?.opencode?.billing_source });
            const tool = await OpenCodeGo.request(profile.id, { max_tokens: 512,
                    messages: [{ role: 'user', content: 'Unit test fixture: call update_state with count=2.' }],
                    tools: [{ type: 'function', function: { name: 'update_state', description: 'Update the synthetic counter',
                        parameters: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } } }],
                    tool_choice: { type: 'function', function: { name: 'update_state' } },
            }, { signal: AbortSignal.timeout(45000) });
            const toolJson = await tool.json();
            const call = toolJson.choices?.[0]?.message?.tool_calls?.[0];
            results.push({ path: 'bridge-tools', status: tool.status, valid: call?.function?.name === 'update_state'
                && JSON.parse(call?.function?.arguments ?? '{}').count === 2, billing: toolJson.usage?.opencode?.billing_source });
            const stream = await OpenCodeGo.request(profile.id, { stream: true, max_tokens: 128,
                messages: [{ role: 'user', content: 'Unit test: output only OK.' }],
            }, { signal: AbortSignal.timeout(45000) });
            const data = await stream.text();
            results.push({ path: 'bridge-stream', status: stream.status, eventStream: stream.headers.get('content-type')?.includes('text/event-stream'),
                complete: data.includes('[DONE]'), receivedContent: /"content"\s*:\s*"[^"\\]/.test(data) });
            return { model: profile.model, results };
        } finally {
            module.deactivate(); SillyTavern.getContext = originalGetContext; installed.activate();
        }
    }, { webBase });
}
