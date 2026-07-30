import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BackendError,
  ConflictError,
  createWebdavBackend,
} from '../src/sync/webdav.js';

const OBJECT_URL = 'https://dav.example/sync/youtube-tuner.bin';

function bytes(value) {
  return new Uint8Array(value);
}

function createServer({
  authStatus = null,
  ignoreIfMatch = false,
  omitPutEtag = false,
  weakEtags = false,
} = {}) {
  const files = new Map();
  const requests = [];
  let revision = 0;

  function etag() {
    const value = `"revision-${revision}"`;
    return weakEtags ? `W/${value}` : value;
  }

  async function fetchFn(url, options = {}) {
    const method = options.method ?? 'GET';
    const headers = new Headers(options.headers);
    requests.push({
      url,
      method,
      headers,
      body: options.body,
      redirect: options.redirect,
      credentials: options.credentials,
      signal: options.signal,
    });

    if (authStatus !== null) {
      return new Response(null, { status: authStatus });
    }

    if (method === 'GET') {
      const file = files.get(url);
      if (!file) return new Response(null, { status: 404 });
      return new Response(file.body, {
        status: 200,
        headers: { ETag: file.etag },
      });
    }

    if (method === 'PUT') {
      const current = files.get(url);
      if (headers.get('If-None-Match') === '*' && current) {
        return new Response(null, { status: 412 });
      }
      const ifMatch = headers.get('If-Match');
      if (
        !ignoreIfMatch
        && ifMatch !== null
        && (!current || current.etag !== ifMatch)
      ) {
        return new Response(null, { status: 412 });
      }

      revision += 1;
      const body = bytes(await new Response(options.body).arrayBuffer());
      const nextEtag = etag();
      files.set(url, { body, etag: nextEtag });
      return new Response(null, {
        status: 200,
        headers: omitPutEtag ? {} : { ETag: nextEtag },
      });
    }

    if (method === 'DELETE') {
      files.delete(url);
      return new Response(null, { status: 204 });
    }

    return new Response(null, { status: 405 });
  }

  return { fetchFn, files, requests };
}

function backend(server, overrides = {}) {
  return createWebdavBackend({
    url: OBJECT_URL,
    username: 'alice',
    password: 'secret',
    fetchFn: server.fetchFn,
    ...overrides,
  });
}

test('read returns null on 404 with the required fetch configuration', async () => {
  const server = createServer();
  assert.equal(await backend(server).read(), null);

  const [request] = server.requests;
  assert.equal(request.url, OBJECT_URL);
  assert.equal(request.method, 'GET');
  assert.equal(request.redirect, 'error');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.headers.get('Authorization'), 'Basic YWxpY2U6c2VjcmV0');
  assert.ok(request.signal instanceof AbortSignal);
});

test('read returns the blob and raw strong ETag', async () => {
  const server = createServer();
  await backend(server).write(bytes([1, 2, 3]), null);

  assert.deepEqual(
    await backend(server).read(),
    { blob: bytes([1, 2, 3]), revision: '"revision-1"' },
  );
});

test('read rejects weak ETags with a typed backend error', async () => {
  const server = createServer({ weakEtags: true });
  server.files.set(OBJECT_URL, {
    body: bytes([1]),
    etag: 'W/"weak"',
  });

  await assert.rejects(
    backend(server).read(),
    (error) => (
      error instanceof BackendError
      && error.status === 200
      && /weak ETag/.test(error.message)
    ),
  );
});

test('write uses create and update preconditions and returns revisions', async () => {
  const server = createServer();
  const webdav = backend(server);

  const first = await webdav.write(bytes([1]), null);
  const second = await webdav.write(bytes([2]), first);

  assert.equal(first, '"revision-1"');
  assert.equal(second, '"revision-2"');
  assert.equal(server.requests[0].headers.get('If-None-Match'), '*');
  assert.equal(server.requests[0].headers.get('If-Match'), null);
  assert.equal(server.requests[1].headers.get('If-Match'), '"revision-1"');
  assert.equal(server.requests[1].headers.get('If-None-Match'), null);
  assert.equal(
    server.requests[0].headers.get('Content-Type'),
    'application/octet-stream',
  );
});

test('write maps a 412 response to ConflictError', async () => {
  const server = createServer();
  const webdav = backend(server);
  await webdav.write(bytes([1]), null);

  await assert.rejects(
    webdav.write(bytes([2]), '"stale"'),
    (error) => (
      error instanceof ConflictError
      && error instanceof BackendError
      && error.status === 412
    ),
  );
});

test('write falls back to GET when PUT omits its ETag', async () => {
  const server = createServer({ omitPutEtag: true });
  const revision = await backend(server).write(bytes([1]), null);

  assert.equal(revision, '"revision-1"');
  assert.deepEqual(
    server.requests.map(({ method }) => method),
    ['PUT', 'GET'],
  );
});

test('authentication failures are typed and identifiable', async () => {
  for (const status of [401, 403]) {
    const server = createServer({ authStatus: status });
    await assert.rejects(
      backend(server).read(),
      (error) => (
        error instanceof BackendError
        && error.status === status
        && error.authFailure === true
      ),
    );
  }
});

test('backend creation enforces HTTPS', () => {
  assert.throws(
    () => createWebdavBackend({
      url: 'http://dav.example/youtube-tuner.bin',
      username: 'alice',
      password: 'secret',
      fetchFn: async () => new Response(),
    }),
    (error) => error instanceof BackendError,
  );
});

test('capability probe passes with strong ETags and CAS support', async () => {
  const server = createServer();
  const result = await backend(server).test();

  assert.deepEqual(result, {
    ok: true,
    strongEtags: true,
    cas: true,
    authOk: true,
    failure: null,
  });
  const probeRequests = server.requests.filter(
    ({ url }) => url !== OBJECT_URL,
  );
  assert.ok(probeRequests.every(
    ({ url }) => new URL(url).pathname.startsWith(
      '/sync/.youtube-tuner-probe-',
    ),
  ));
  assert.deepEqual(
    probeRequests.map(({ method }) => method),
    ['PUT', 'GET', 'PUT', 'PUT', 'DELETE'],
  );
});

test('capability probe detects a server that ignores If-Match', async () => {
  const server = createServer({ ignoreIfMatch: true });
  const result = await backend(server).test();

  assert.equal(result.ok, false);
  assert.equal(result.strongEtags, true);
  assert.equal(result.cas, false);
  assert.equal(result.authOk, true);
  assert.match(result.failure, /stale conditional update/);
});

test('capability probe always issues cleanup DELETE after creation', async () => {
  const server = createServer({ ignoreIfMatch: true });
  await backend(server).test();

  assert.equal(server.requests.at(-1).method, 'DELETE');
  assert.equal(
    server.requests.at(-1).url,
    server.requests[0].url,
  );
});
