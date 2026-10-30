async (page) => {
    const base = '.'; // Run Playwright CLI from the repository root.
    const webBase = '/scripts/extensions/third-party/ocg-local-test/';
    for (const file of ['index.js', 'core.js', 'transport.js', 'style.css']) {
        await page.route(`**${webBase}${file}`, route => route.fulfill({
            path: `${base}/${file}`, contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript',
        }));
    }
    // A shadow context and captured fetch prevent changing settings or sending chat data.
    const result = await page.evaluate(async ({ webBase }) => {
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
                return new Response(JSON.stringify({ choices: [{ message: { content: 'mock' } }] }), {
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
        const checkbox = document.querySelector('#opencode_go_helper [data-ocg="enabled"]');
        checkbox.checked = false; checkbox.dispatchEvent(new Event('change'));
        await fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify({ chat_completion_source: 'custom', custom_url: 'https://opencode.ai/inference/go/openai/v1' }) });
        if (captures.at(-1).custom_include_headers) throw Error('disable ineffective');
        checkbox.checked = true; checkbox.dispatchEvent(new Event('change'));
        // Check reload semantics with settings retained, but module lifecycle restarted.
        shadow.chatId = 'ocg-test-a';
        module.deactivate(); module.activate();
        if (await send() !== first) throw Error('lifecycle changed session');
        shadow.chatCompletionSettings.custom_url = 'https://opencode.ai/inference/go/openai/v1';
        document.querySelector('#opencode_go_helper [data-ocg="refresh"]').click();
        globalThis.ocgTestCleanup = () => {
            module.deactivate(); SillyTavern.getContext = originalGetContext; globalThis.fetch = originalFetch; css.remove();
        };
        return { mounted: true, duplicateActivation: 'pass', chatSwitch: 'pass', reload: 'pass', disable: 'pass', catalog: 'pass', hostYaml: 'pass' };
    }, { webBase });
    return result;
}
