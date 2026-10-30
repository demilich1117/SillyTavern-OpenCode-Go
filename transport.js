import { isHostRequest, preparePayload } from './core.js';

/**
 * ST 1.19's main generation event excludes ChatCompletionService and model checks.
 * Wrap only its two same-origin JSON request routes to cover all three paths.
 * Never change response bodies, streaming readers, credentials, or abort signals.
 */
export function installTransport(target, { origin, snapshot, onApplied = () => {}, onError = () => {} }) {
    const previous = target.fetch;
    let active = true;
    const wrapped = async function (input, init) {
        if (!active || !isHostRequest(input, init, origin)) return previous.call(this, input, init);
        // Snapshot before reading a Request body: chat switches during await cannot retarget it.
        const options = snapshot();
        if (!options.enabled) return previous.call(this, input, init);
        let body = init?.body;
        if (body === undefined && input instanceof Request) body = await input.clone().text();
        if (typeof body !== 'string') return previous.call(this, input, init);
        let payload;
        try { payload = JSON.parse(body); } catch { return previous.call(this, input, init); }
        let prepared;
        const url = new URL(input instanceof Request ? input.url : input, origin);
        try { prepared = preparePayload(payload, { ...options, operation: url.pathname.endsWith('/status') ? 'status' : 'generate' }); }
        catch (error) { onError(error); throw error; }
        if (prepared === payload) return previous.call(this, input, init);
        const nextInit = { ...init, body: JSON.stringify(prepared) };
        onApplied(prepared);
        return previous.call(this, input, nextInit);
    };
    target.fetch = wrapped;
    return () => {
        active = false;
        // If another extension wrapped us later, leave its wrapper in place.
        if (target.fetch === wrapped) target.fetch = previous;
    };
}
