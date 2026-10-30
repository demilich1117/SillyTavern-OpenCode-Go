import { inspectDirectRequest, isHostRequest, isRequest, preparePayload } from './core.js';

/**
 * ST 1.19's main generation event excludes ChatCompletionService and model checks.
 * Wrap its two same-origin JSON routes, plus optional official direct requests.
 * Host responses and abort signals pass through; direct requests use the bridge.
 */
export function installTransport(target, { origin, snapshot, directFetch, onApplied = () => {}, onError = () => {} }) {
    const previous = target.fetch;
    let active = true;
    const wrapped = async function (input, init) {
        if (!active) return previous.call(this, input, init);
        if (!isHostRequest(input, init, origin)) {
            if (directFetch && inspectDirectRequest(input, init)) {
                const options = snapshot();
                if (options.enabled && options.directRequests) return directFetch(input, init);
            }
            return previous.call(this, input, init);
        }
        // Snapshot before reading a Request body: chat switches during await cannot retarget it.
        const options = snapshot();
        if (!options.enabled) return previous.call(this, input, init);
        let body = init?.body;
        if (body === undefined && isRequest(input)) body = await input.clone().text();
        if (typeof body !== 'string') return previous.call(this, input, init);
        let payload;
        try { payload = JSON.parse(body); } catch { return previous.call(this, input, init); }
        let prepared;
        const url = new URL(isRequest(input) ? input.url : input, origin);
        try { prepared = preparePayload(payload, { ...options, operation: url.pathname.endsWith('/status') ? 'status' : 'generate' }); }
        catch (error) { onError(error); throw error; }
        if (prepared === payload) return previous.call(this, input, init);
        const nextInit = { ...init, body: JSON.stringify(prepared) };
        // Diagnostics contain no prompts or credentials.
        onApplied({ stream: Boolean(prepared.stream), operation: url.pathname.endsWith('/status') ? 'status' : 'generate',
            kind: payload.chat_completion_source === 'openai' ? 'proxy' : 'custom' });
        return previous.call(this, input, nextInit);
    };
    target.fetch = wrapped;
    return () => {
        active = false;
        // If another extension wrapped us later, leave its wrapper in place.
        if (target.fetch === wrapped) target.fetch = previous;
    };
}
