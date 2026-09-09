const test = require('node:test');
const assert = require('node:assert/strict');

const {
    registerReadRoute,
    registerPostReadAlias,
    registerReadRouteWithPostAlias,
    normalizePostReadRequest,
    buildMergedQuery
} = require('../utils/read-route');

function createFakeApp() {
    const registered = { get: [], post: [] };
    return {
        registered,
        get(paths, ...handlers) {
            registered.get.push({ paths, handlers });
        },
        post(paths, ...handlers) {
            registered.post.push({ paths, handlers });
        }
    };
}

function createRequest(body, query = {}) {
    const req = { body, method: 'POST' };
    Object.defineProperty(req, 'query', { value: query, writable: true, configurable: true });
    return req;
}

function createResponse() {
    return { headers: {}, set(name, value) { this.headers[name] = value; } };
}

test('registerReadRoute exposes the same handler chain under GET and POST', () => {
    const app = createFakeApp();
    const middleware = (_req, _res, next) => next();
    const handler = (_req, res) => res.json({});

    registerReadRoute(app, ['/things', '/notify/things'], middleware, handler);

    assert.equal(app.registered.get.length, 1);
    assert.deepEqual(app.registered.get[0].paths, ['/things', '/notify/things']);
    assert.deepEqual(app.registered.get[0].handlers, [middleware, handler]);

    assert.equal(app.registered.post.length, 1);
    assert.deepEqual(app.registered.post[0].paths, ['/things', '/notify/things']);
    assert.equal(app.registered.post[0].handlers.length, 3);
    assert.equal(app.registered.post[0].handlers[0], normalizePostReadRequest);
    assert.deepEqual(app.registered.post[0].handlers.slice(1), [middleware, handler]);
});

test('registerReadRouteWithPostAlias keeps GET path and mounts POST elsewhere', () => {
    const app = createFakeApp();
    const handler = (_req, res) => res.json({});

    registerReadRouteWithPostAlias(app, ['/users'], ['/users/list'], handler);

    assert.deepEqual(app.registered.get[0].paths, ['/users']);
    assert.deepEqual(app.registered.post[0].paths, ['/users/list']);
    assert.equal(app.registered.post[0].handlers[0], normalizePostReadRequest);
});

test('registerReadRoute rejects invalid usage', () => {
    assert.throws(() => registerReadRoute({}, '/x', () => {}), /Express application/);
    assert.throws(() => registerReadRoute(createFakeApp(), '/x'), /at least one handler/);
    assert.throws(() => registerPostReadAlias(createFakeApp(), '/x'), /at least one handler/);
});

test('POST body values are exposed through req.query', () => {
    const req = createRequest({ user: '0501234567', limit: 25, tags: ['a', 'b'] }, { source: 'web' });
    const res = createResponse();
    let called = false;

    normalizePostReadRequest(req, res, () => { called = true; });

    assert.equal(called, true);
    assert.equal(req.query.user, '0501234567');
    assert.equal(req.query.limit, '25');
    assert.deepEqual(req.query.tags, ['a', 'b']);
    assert.equal(req.query.source, 'web');
    assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('body values override query string values', () => {
    const merged = buildMergedQuery(createRequest({ user: 'body-user' }, { user: 'query-user' }));
    assert.equal(merged.user, 'body-user');
});

test('nested objects, functions and polluting keys are ignored', () => {
    const body = JSON.parse('{"__proto__": {"admin": true}, "constructor": "x", "nested": {"a": 1}, "ok": "yes"}');
    body.fn = () => 'nope';
    const merged = buildMergedQuery(createRequest(body));

    assert.equal(merged.ok, 'yes');
    assert.equal(merged.nested, undefined);
    assert.equal(merged.fn, undefined);
    assert.equal(merged.constructor, undefined);
    assert.equal(Object.prototype.admin, undefined);
    assert.equal(({}).admin, undefined);
});

test('non-object bodies are ignored and the query string survives', () => {
    const req = createRequest('not-an-object', { user: 'q' });
    const res = createResponse();
    normalizePostReadRequest(req, res, () => {});
    assert.equal(req.query.user, 'q');

    const arrayBodyMerge = buildMergedQuery(createRequest(['a'], { user: 'q' }));
    assert.equal(arrayBodyMerge.user, 'q');
});
