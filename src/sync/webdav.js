const REQUEST_TIMEOUT_MS = 25_000;
const CONTENT_TYPE = 'application/octet-stream';

export class BackendError extends Error {
  constructor(message, { status = null, cause } = {}) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
    this.authFailure = status === 401 || status === 403;
    if (cause !== undefined) this.cause = cause;
  }
}

export class ConflictError extends BackendError {
  constructor(message = 'The remote file has changed') {
    super(message, { status: 412 });
    this.name = 'ConflictError';
  }
}

function encodeBasicAuth(username, password) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return `Basic ${btoa(value)}`;
}

function getEtag(response) {
  return response.headers.get('ETag');
}

function isStrongEtag(etag) {
  return typeof etag === 'string'
    && etag.length >= 2
    && etag.startsWith('"')
    && etag.endsWith('"');
}

function requireStrongEtag(response, action) {
  const etag = getEtag(response);
  if (etag?.startsWith('W/')) {
    throw new BackendError(`${action} returned a weak ETag`, {
      status: response.status,
    });
  }
  if (!isStrongEtag(etag)) {
    throw new BackendError(`${action} did not return a strong ETag`, {
      status: response.status,
    });
  }
  return etag;
}

function httpError(action, response) {
  return new BackendError(
    `${action} failed with HTTP ${response.status}`,
    { status: response.status },
  );
}

function randomSuffix() {
  if (globalThis.crypto?.randomUUID) {
    return `-${globalThis.crypto.randomUUID()}`;
  }
  return `-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createWebdavBackend({
  url,
  username = '',
  password = '',
  fetchFn = globalThis.fetch,
  probeDelayMs = 1100,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const objectUrl = new URL(url);
  if (objectUrl.protocol !== 'https:') {
    throw new BackendError('WebDAV requires an HTTPS URL');
  }
  if (typeof fetchFn !== 'function') {
    throw new TypeError('fetchFn must be a function');
  }

  const authorization = encodeBasicAuth(username, password);

  async function request(target, method, { headers = {}, body } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetchFn(target.toString(), {
        method,
        headers: {
          Authorization: authorization,
          ...headers,
        },
        ...(body === undefined ? {} : { body }),
        cache: 'no-store',
        redirect: 'error',
        credentials: 'omit',
        signal: controller.signal,
      });
    } catch (error) {
      const message = controller.signal.aborted
        ? 'WebDAV request timed out'
        : 'WebDAV request failed';
      throw new BackendError(message, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchRevision(target, action) {
    const response = await request(target, 'GET');
    if (!response.ok) throw httpError(action, response);
    return requireStrongEtag(response, action);
  }

  async function read({ ifNoneMatch } = {}) {
    const conditional = typeof ifNoneMatch === 'string'
      && ifNoneMatch.length > 0;
    const response = conditional
      ? await request(objectUrl, 'GET', {
        headers: { 'If-None-Match': ifNoneMatch },
      })
      : await request(objectUrl, 'GET');
    if (conditional && response.status === 304) {
      return { unchanged: true, revision: ifNoneMatch };
    }
    if (response.status === 404) return null;
    if (!response.ok) throw httpError('WebDAV read', response);
    const revision = requireStrongEtag(response, 'WebDAV read');
    const blob = new Uint8Array(await response.arrayBuffer());
    return { blob, revision };
  }

  async function write(blob, revision) {
    const response = await request(objectUrl, 'PUT', {
      headers: {
        'Content-Type': CONTENT_TYPE,
        ...(revision === null
          ? { 'If-None-Match': '*' }
          : { 'If-Match': revision }),
      },
      body: blob,
    });
    if (response.status === 412) throw new ConflictError();
    if (!response.ok) throw httpError('WebDAV write', response);

    const etag = getEtag(response);
    if (etag !== null) return requireStrongEtag(response, 'WebDAV write');
    return fetchRevision(objectUrl, 'WebDAV write revision lookup');
  }

  async function test() {
    const result = {
      ok: false,
      strongEtags: false,
      cas: false,
      authOk: true,
      failure: null,
    };
    const probeUrl = new URL(
      `.youtube-tuner-probe${randomSuffix()}`,
      objectUrl,
    );
    let created = false;

    try {
      const createResponse = await request(probeUrl, 'PUT', {
        headers: {
          'Content-Type': CONTENT_TYPE,
          'If-None-Match': '*',
        },
        body: Uint8Array.of(1),
      });
      if (createResponse.status === 401 || createResponse.status === 403) {
        result.authOk = false;
        result.failure = `Probe authentication failed with HTTP ${createResponse.status}`;
        return result;
      }
      if (!createResponse.ok) {
        result.failure = `Probe creation failed with HTTP ${createResponse.status}`;
        return result;
      }
      created = true;

      const createEtag = getEtag(createResponse);
      if (createEtag !== null && !isStrongEtag(createEtag)) {
        result.failure = 'Probe creation did not return a strong ETag';
        return result;
      }

      const readResponse = await request(probeUrl, 'GET');
      if (readResponse.status === 401 || readResponse.status === 403) {
        result.authOk = false;
        result.failure = `Probe authentication failed with HTTP ${readResponse.status}`;
        return result;
      }
      if (!readResponse.ok) {
        result.failure = `Probe read failed with HTTP ${readResponse.status}`;
        return result;
      }
      const firstRevision = getEtag(readResponse);
      if (
        !isStrongEtag(firstRevision)
        || (createEtag !== null && createEtag !== firstRevision)
      ) {
        result.failure = 'Probe ETag was missing, weak, or unstable';
        return result;
      }

      await sleep(probeDelayMs);

      const updateResponse = await request(probeUrl, 'PUT', {
        headers: {
          'Content-Type': CONTENT_TYPE,
          'If-Match': firstRevision,
        },
        body: Uint8Array.of(2),
      });
      if (updateResponse.status === 401 || updateResponse.status === 403) {
        result.authOk = false;
        result.failure = `Probe authentication failed with HTTP ${updateResponse.status}`;
        return result;
      }
      if (!updateResponse.ok) {
        result.failure = `Probe conditional update failed with HTTP ${updateResponse.status}`;
        return result;
      }

      let secondRevision = getEtag(updateResponse);
      if (secondRevision === null) {
        const revisionResponse = await request(probeUrl, 'GET');
        if (revisionResponse.status === 401 || revisionResponse.status === 403) {
          result.authOk = false;
          result.failure = `Probe authentication failed with HTTP ${revisionResponse.status}`;
          return result;
        }
        if (!revisionResponse.ok) {
          result.failure = `Probe revision lookup failed with HTTP ${revisionResponse.status}`;
          return result;
        }
        secondRevision = getEtag(revisionResponse);
      }
      if (!isStrongEtag(secondRevision) || secondRevision === firstRevision) {
        result.failure = 'Probe ETag did not change after an update';
        return result;
      }
      result.strongEtags = true;

      const staleResponse = await request(probeUrl, 'PUT', {
        headers: {
          'Content-Type': CONTENT_TYPE,
          'If-Match': firstRevision,
        },
        body: Uint8Array.of(3),
      });
      if (staleResponse.status === 401 || staleResponse.status === 403) {
        result.authOk = false;
        result.failure = `Probe authentication failed with HTTP ${staleResponse.status}`;
        return result;
      }
      if (staleResponse.status !== 412) {
        result.failure = 'Probe stale conditional update was not rejected';
        return result;
      }

      result.cas = true;
      result.ok = true;
      return result;
    } catch (error) {
      if (!(error instanceof BackendError)) throw error;
      if (error.authFailure) result.authOk = false;
      result.failure = error.message;
      return result;
    } finally {
      if (created) {
        try {
          await request(probeUrl, 'DELETE');
        } catch {
          // Probe cleanup is best-effort.
        }
      }
    }
  }

  return { read, write, test };
}
