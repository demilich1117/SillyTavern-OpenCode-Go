async (page) => {
    await page.route(/\/api\/(settings\/save|chats\/save|chats\/group\/save)(?:\?|$)/, route => route.fulfill({ json: { result: 'ok' } }));
    const base = '.'; // Run Playwright CLI from the repository root.
    const webBase = '/scripts/extensions/third-party/ocg-local-test/';
    for (const file of ['index.js', 'core.js', 'transport.js', 'bridge.js', 'style.css']) {
        await page.route(`**${webBase}${file}`, route => route.fulfill({
            path: `${base}/${file}`, contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript',
        }));
    }
    // A shadow context and captured fetch prevent changing settings or sending chat data.
    const result = await page.evaluate(async ({ webBase }) => {
        const installed = await import('/scripts/extensions/third-party/SillyTavern-OpenCode-Go/index.js');
        installed.deactivate();
        const actual = SillyTavern.getContext();
        const originalGetContext = SillyTavern.getContext;
        const originalFetch = globalThis.fetch;
        const shadow = {
            ...actual,
            mainApi: 'openai',
            chatCompletionSettings: { chat_completion_source: 'custom', custom_url: 'https://opencode.ai/inference/openai/v1' },
            extensionSettings: {},
            chatId: 'ocg-test-a', characterId: 0, groupId: undefined,
            characters: [{ avatar: 'ocg-test.png' }],
            saveSettingsDebounced: () => {},
        };
        const captures = [];
        globalThis.fetch = async (input, init) => {
            if (String(input).includes('/api/backends/chat-completions/')) {
                captures.push(JSON.parse(init.body));
                return new Response(JSON.stringify({ data: [{ id: 'synthetic-model' }], choices: [{ message: { content: 'mock' } }] }), {
                    status: 200, headers: { 'Content-Type': 'application/json' },
                });
            }
            return originalFetch(input, init);
        };
        SillyTavern.getContext = () => ({ ...shadow });
        const module = await import(`${webBase}index.js`);
        const css = document.createElement('link');
        css.rel = 'stylesheet'; css.href = `${webBase}style.css`; document.head.append(css);
        module.activate(); module.activate();
        if (document.querySelectorAll('#opencode_go_helper').length !== 1) throw Error('duplicate mount');
        if (!document.querySelector('#opencode_go_helper [data-ocg="status"]').textContent.includes('按量计费')) throw Error('plan diagnosis');
        const send = async (route = 'generate') => {
            await fetch(`/api/backends/chat-completions/${route}`, { method: 'POST', body: JSON.stringify({
                chat_completion_source: 'custom', custom_url: 'https://opencode.ai/inference/go/openai/v1',
                messages: [{ role: 'user', content: 'synthetic fixture' }], custom_include_headers: 'X-Test: keep', stream: true,
            }) });
            return JSON.parse(captures.at(-1).custom_include_headers)['x-opencode-session'];
        };
        const first = await send();
        if (await send() !== first) throw Error('unstable session');
        shadow.chatId = 'ocg-test-b';
        if (await send() === first) throw Error('cross-chat session reuse');
        await send('status');
        if (captures.at(-1).custom_url !== 'https://opencode.ai/inference/v1') throw Error('model list URL');
        // Exercise the installed helper's actual getModelList() implementation.
        const models = await TavernHelper.getModelList({ apiurl: 'https://opencode.ai/inference/go/openai/v1', key: 'synthetic-helper-key' });
        if (!models.includes('synthetic-model')) throw Error('helper catalog result');
        if (captures.at(-1).chat_completion_source !== 'custom' || JSON.parse(captures.at(-1).custom_include_headers).Authorization !== 'Bearer synthetic-helper-key') throw Error('helper catalog adaptation');
        await actual.ChatCompletionService.sendRequest({ chat_completion_source: 'openai', reverse_proxy: 'https://opencode.ai/inference/go/openai/v1', proxy_password: 'synthetic-auxiliary-key', model: 'synthetic-model', messages: [{ role: 'user', content: 'synthetic' }], stream: false });
        if (captures.at(-1).chat_completion_source !== 'custom') throw Error('auxiliary service');
        const helperReply = await TavernHelper.generateRaw({
            should_silence: true, should_stream: false, max_chat_history: 0,
            ordered_prompts: [{ role: 'user', content: 'synthetic auxiliary smoke' }],
            overrides: { world_info_before: '', world_info_after: '', char_description: '', char_personality: '', persona_description: '', scenario: '', dialogue_examples: '', chat_history: { prompts: [], with_depth_entries: false, author_note: '' } },
            custom_api: { apiurl: 'https://opencode.ai/inference/go/openai/v1', key: 'synthetic-helper-key', model: 'synthetic-model', max_tokens: 32 },
        });
        if (helperReply !== 'mock' || captures.at(-1).chat_completion_source !== 'custom') throw Error('helper generation');
        const savedSession = OpenCodeGo.captureSession();
        shadow.chatId = 'ocg-test-c';
        const frame = document.createElement('iframe'); document.body.append(frame);
        const iframeRequest = new frame.contentWindow.Request('https://opencode.ai/inference/go/openai/v1/chat/completions', {
            method: 'POST', headers: { Authorization: 'Bearer synthetic-frame-key' },
            body: JSON.stringify({ model: 'synthetic-model', messages: [{ role: 'user', content: 'synthetic' }] }),
        });
        await OpenCodeGo.fetch(iframeRequest, undefined, { sessionId: savedSession });
        const frameHeaders = JSON.parse(captures.at(-1).custom_include_headers);
        if (frameHeaders.Authorization !== 'Bearer synthetic-frame-key' || frameHeaders['x-opencode-session'] !== savedSession) throw Error('iframe context or credentials');
        frame.remove();
        const direct = document.querySelector('#opencode_go_helper [data-ocg="direct"]');
        if (direct.checked) throw Error('direct default must be opt-in');
        direct.checked = true; direct.dispatchEvent(new Event('change'));
        await fetch('https://opencode.ai/inference/go/openai/v1/models');
        if (captures.at(-1).custom_url !== 'https://opencode.ai/inference/v1') throw Error('automatic bridge');
        const checkbox = document.querySelector('#opencode_go_helper [data-ocg="enabled"]');
        checkbox.checked = false; checkbox.dispatchEvent(new Event('change'));
        await fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify({ chat_completion_source: 'custom', custom_url: 'https://opencode.ai/inference/go/openai/v1' }) });
        if (captures.at(-1).custom_include_headers) throw Error('disable ineffective');
        checkbox.checked = true; checkbox.dispatchEvent(new Event('change'));
        // Check reload semantics with settings retained, but module lifecycle restarted.
        shadow.chatId = 'ocg-test-a';
        const oldBridge = OpenCodeGo;
        module.deactivate();
        try { await oldBridge.fetch('https://opencode.ai/inference/go/openai/v1/models'); throw Error('old bridge still active'); }
        catch (error) { if (!error.message.includes('停用')) throw error; }
        module.activate();
        if (await send() !== first) throw Error('lifecycle changed session');
        shadow.chatCompletionSettings.custom_url = 'https://opencode.ai/inference/go/openai/v1';
        document.querySelector('#opencode_go_helper [data-ocg="refresh"]').click();
        globalThis.ocgTestCleanup = () => {
            module.deactivate(); SillyTavern.getContext = originalGetContext; globalThis.fetch = originalFetch; css.remove(); installed.activate();
        };
        return { mounted: true, duplicateActivation: 'pass', chatSwitch: 'pass', reload: 'pass', disable: 'pass', catalog: 'pass', hostYaml: 'pass', helperModelList: 'pass', helperGenerateRaw: 'pass', auxiliaryService: 'pass', iframeRequest: 'pass', backgroundSession: 'pass', directOptIn: 'pass', staleBridge: 'pass' };
    }, { webBase });
    return result;
}
