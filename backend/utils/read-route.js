// ─── Read-route registration helper ──────────────────────────────────────────
// The mobile (Flutter) clients send every API call as POST so that no
// user-identifying data ever ends up in a URL (query strings leak into proxy
// logs, browser history, referrer headers and crash reports). The Angular
// frontend still issues plain GET requests for the same data.
//
// `registerReadRoute` registers a single handler chain under both verbs:
//   • GET  <path>            – legacy/web clients (unchanged behaviour)
//   • POST <path>            – Flutter clients, parameters travel in the body
//
// For POST requests the JSON body is merged into `req.query` (prototype-safe)
// so existing handlers that read `req.query.<x>` keep working untouched.
// ─────────────────────────────────────────────────────────────────────────────

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Values accepted from a POST body when merged into `req.query`. */
function isMergeableValue(value) {
    if (value === null || value === undefined) return false;
    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean') return true;
    if (Array.isArray(value)) {
        return value.every((entry) => {
            const entryType = typeof entry;
            return entryType === 'string' || entryType === 'number' || entryType === 'boolean';
        });
    }
    return false;
}

/**
 * Build a plain object combining the URL query string with the request body.
 * Body values win, but only for safe keys holding scalar/array values so a
 * malicious payload cannot inject objects (prototype pollution) or functions.
 */
function buildMergedQuery(req) {
    const merged = Object.create(null);
    const query = req && req.query && typeof req.query === 'object' ? req.query : {};
    for (const key of Object.keys(query)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        merged[key] = query[key];
    }

    const body = req && req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body
        : {};
    for (const key of Object.keys(body)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        const value = body[key];
        if (!isMergeableValue(value)) continue;
        merged[key] = Array.isArray(value) ? value.map((entry) => String(entry)) : String(value);
    }

    return merged;
}

/**
 * Express middleware used only on the POST twin of a read route: exposes the
 * request body through `req.query` and marks the response as non-cacheable.
 */
function normalizePostReadRequest(req, res, next) {
    try {
        const merged = buildMergedQuery(req);
        Object.defineProperty(req, 'query', {
            value: merged,
            writable: true,
            configurable: true,
            enumerable: true
        });
    } catch (error) {
        // If the query object cannot be replaced the handler still works with
        // the original query string – never fail the request because of this.
        console.warn('[READ-ROUTE] Failed to merge POST body into query:', error && error.message);
    }
    // Read responses must never be stored by intermediaries: they are
    // per-user data returned over an authenticated session.
    res.set('Cache-Control', 'no-store');
    next();
}

/**
 * Register a read (data-fetching) endpoint under both GET and POST.
 *
 * @param {import('express').Application} app Express application
 * @param {string|string[]} paths Route path(s)
 * @param {...Function} handlers Middleware/handler chain
 */
function registerReadRoute(app, paths, ...handlers) {
    if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
        throw new Error('registerReadRoute requires an Express application');
    }
    const chain = handlers.filter((handler) => typeof handler === 'function');
    if (!chain.length) {
        throw new Error('registerReadRoute requires at least one handler');
    }
    app.get(paths, ...chain);
    app.post(paths, normalizePostReadRequest, ...chain);
    return app;
}

/**
 * Register a POST-only twin of a GET route whose path already serves a
 * different POST handler (e.g. `POST /helpdesk/users` creates a user). The
 * twin lives on `<path>/list` style aliases supplied by the caller.
 */
function registerPostReadAlias(app, paths, ...handlers) {
    if (!app || typeof app.post !== 'function') {
        throw new Error('registerPostReadAlias requires an Express application');
    }
    const chain = handlers.filter((handler) => typeof handler === 'function');
    if (!chain.length) {
        throw new Error('registerPostReadAlias requires at least one handler');
    }
    app.post(paths, normalizePostReadRequest, ...chain);
    return app;
}

/**
 * Register a read endpoint that keeps its GET path for web clients and gains a
 * POST twin on a *different* path, because the original path already exposes a
 * POST handler with different semantics (e.g. `POST /helpdesk/users` creates a
 * user, so listing users moves to `POST /helpdesk/users/list`).
 */
function registerReadRouteWithPostAlias(app, getPaths, postPaths, ...handlers) {
    if (!app || typeof app.get !== 'function') {
        throw new Error('registerReadRouteWithPostAlias requires an Express application');
    }
    const chain = handlers.filter((handler) => typeof handler === 'function');
    if (!chain.length) {
        throw new Error('registerReadRouteWithPostAlias requires at least one handler');
    }
    app.get(getPaths, ...chain);
    return registerPostReadAlias(app, postPaths, ...chain);
}

module.exports = {
    registerReadRoute,
    registerPostReadAlias,
    registerReadRouteWithPostAlias,
    normalizePostReadRequest,
    buildMergedQuery
};
