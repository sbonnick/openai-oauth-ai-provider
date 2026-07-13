import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  createAuthenticatedFetch,
  decodeJwtPayload,
  defaultTokenFilePath,
  FileTokenStore,
  MemoryTokenStore,
  OpenAIOAuth,
  tryGetJwtExpiration,
} from '../src/index.js';
import { jsonResponse, jwt, tokens } from './helpers.js';

describe('OpenAIOAuth', () => {
  it('completes the Codex device flow and persists tokens', async () => {
    const requests: Array<{ body: string; url: string }> = [];
    let pollCount = 0;
    const idToken = jwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'workspace-1',
        chatgpt_plan_type: 'pro',
      },
    });
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ body: String(init?.body ?? ''), url });
      if (url.endsWith('/deviceauth/usercode')) {
        return jsonResponse({
          device_auth_id: 'device-1',
          user_code: 'ABCD-1234',
          interval: 0.001,
        });
      }
      if (url.endsWith('/deviceauth/token')) {
        pollCount += 1;
        return pollCount === 1
          ? jsonResponse({ error: 'authorization_pending' }, 403)
          : jsonResponse({
              authorization_code: 'code-1',
              code_challenge: 'challenge-1',
              code_verifier: 'verifier-1',
            });
      }
      if (url.endsWith('/oauth/token')) {
        return jsonResponse({
          access_token: jwt({ exp: 4_000_000_000 }),
          id_token: idToken,
          refresh_token: 'refresh-1',
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const store = new MemoryTokenStore();
    const auth = new OpenAIOAuth({ fetch: fetchMock, tokenStore: store });

    const authorization = await auth.startDeviceAuthorization();
    assert.equal(
      authorization.verificationUrl,
      'https://auth.openai.com/codex/device',
    );
    assert.equal(authorization.userCode, 'ABCD-1234');
    const result = await auth.completeDeviceAuthorization(authorization);

    assert.equal(result.accountId, 'workspace-1');
    assert.equal(result.planType, 'pro');
    assert.deepEqual(await store.load(), result);
    assert.match(requests.at(-1)?.body ?? '', /grant_type=authorization_code/);
  });

  it('proactively refreshes an expiring access token and rotates tokens', async () => {
    const now = 2_000_000_000_000;
    const initial = tokens({
      accessToken: jwt({ exp: Math.floor(now / 1000) + 60 }),
      updatedAt: now - 10_000,
    });
    let refreshBody: unknown;
    const fetchMock: typeof fetch = async (_input, init) => {
      refreshBody = JSON.parse(String(init?.body));
      return jsonResponse({
        access_token: jwt({ exp: Math.floor(now / 1000) + 3600 }),
        refresh_token: 'refresh-rotated',
      });
    };
    const auth = new OpenAIOAuth({
      fetch: fetchMock,
      now: () => now,
      tokenStore: new MemoryTokenStore(initial),
    });

    const result = await auth.getTokens();

    assert.equal(result.refreshToken, 'refresh-rotated');
    assert.deepEqual(refreshBody, {
      client_id: auth.clientId,
      grant_type: 'refresh_token',
      refresh_token: initial.refreshToken,
    });
  });

  it('retries one unauthorized request after refreshing', async () => {
    const initial = tokens();
    const seenAuthorization: string[] = [];
    let apiCalls = 0;
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/oauth/token')) {
        return jsonResponse({ access_token: 'new-access-token' });
      }
      apiCalls += 1;
      const headers = new Headers(init?.headers);
      seenAuthorization.push(headers.get('authorization') ?? '');
      assert.equal(headers.get('chatgpt-account-id'), 'account-123');
      assert.equal(headers.get('originator'), 'test-provider');
      return new Response(null, { status: apiCalls === 1 ? 401 : 200 });
    };
    const auth = new OpenAIOAuth({
      fetch: fetchMock,
      tokenStore: new MemoryTokenStore(initial),
    });
    const authenticatedFetch = createAuthenticatedFetch(auth, {
      allowedOrigins: ['https://example.test'],
      fetch: fetchMock,
      originator: 'test-provider',
    });

    const response = await authenticatedFetch('https://example.test/responses');

    assert.equal(response.status, 200);
    assert.deepEqual(seenAuthorization, [
      `Bearer ${initial.accessToken}`,
      'Bearer new-access-token',
    ]);
  });

  it('refuses to send credentials outside its HTTPS allowlist', async () => {
    let calls = 0;
    const auth = new OpenAIOAuth({
      tokenStore: new MemoryTokenStore(tokens()),
    });
    const authenticatedFetch = createAuthenticatedFetch(auth, {
      allowedOrigins: ['https://allowed.test'],
      fetch: async () => {
        calls += 1;
        return new Response();
      },
    });

    await assert.rejects(
      authenticatedFetch('https://attacker.test/responses'),
      /Refusing to send OpenAI OAuth credentials/,
    );
    assert.equal(calls, 0);
    assert.throws(
      () =>
        createAuthenticatedFetch(auth, {
          allowedOrigins: ['http://allowed.test'],
        }),
      /require HTTPS/,
    );
  });

  it('does not expose OAuth response bodies in errors', async () => {
    const secret = 'refresh-token-that-must-not-be-logged';
    const auth = new OpenAIOAuth({
      fetch: async () =>
        new Response(JSON.stringify({ message: secret }), { status: 500 }),
      tokenStore: new MemoryTokenStore(),
    });

    await assert.rejects(auth.startDeviceAuthorization(), (error: unknown) => {
      assert(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.match(error.message, /HTTP 500/);
      return true;
    });
  });

  it('keeps device polling credentials private and client-bound', async () => {
    const fetchMock: typeof fetch = async () =>
      jsonResponse({
        device_auth_id: 'private-device-id',
        interval: 1,
        user_code: 'ABCD-1234',
      });
    const auth = new OpenAIOAuth({ fetch: fetchMock });
    const authorization = await auth.startDeviceAuthorization();

    assert.doesNotMatch(JSON.stringify(authorization), /private-device-id/);
    assert.deepEqual(Object.keys(authorization).sort(), [
      'expiresAt',
      'userCode',
      'verificationUrl',
    ]);
    await assert.rejects(
      new OpenAIOAuth({ fetch: fetchMock }).completeDeviceAuthorization(
        authorization,
      ),
      /on this client/,
    );
  });

  it('rejects malformed refresh responses and preserves stored credentials', async () => {
    const initial = tokens();
    const store = new MemoryTokenStore(initial);
    const auth = new OpenAIOAuth({
      fetch: async () => jsonResponse({ access_token: '' }),
      tokenStore: store,
    });

    await assert.rejects(auth.refresh(), /missing access_token/);
    assert.deepEqual(await store.load(), initial);
  });

  it('deduplicates refreshes and preserves omitted routing claims', async () => {
    const initial = tokens({ isFedRamp: true });
    let calls = 0;
    const auth = new OpenAIOAuth({
      fetch: async () => {
        calls += 1;
        return jsonResponse({ access_token: 'new-access-token' });
      },
      tokenStore: new MemoryTokenStore(initial),
    });

    const [first, second] = await Promise.all([auth.refresh(), auth.refresh()]);
    assert.equal(calls, 1);
    assert.equal(first.isFedRamp, true);
    assert.deepEqual(second, first);
  });

  it('does not restore credentials when logout races with refresh', async () => {
    const initial = tokens();
    let releaseRefresh: (() => void) | undefined;
    let markRefreshStarted: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const fetchMock: typeof fetch = async () => {
      markRefreshStarted?.();
      await new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      return jsonResponse({ access_token: 'new-access-token' });
    };
    const store = new MemoryTokenStore(initial);
    const auth = new OpenAIOAuth({ fetch: fetchMock, tokenStore: store });

    const refreshing = auth.refresh();
    await refreshStarted;
    await auth.logout();
    releaseRefresh?.();

    await assert.rejects(refreshing, /Authentication changed/);
    assert.equal(await store.load(), undefined);
  });

  it('times out stalled authentication requests', async () => {
    const auth = new OpenAIOAuth({
      fetch: async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
      requestTimeoutMs: 5,
    });

    await assert.rejects(auth.startDeviceAuthorization(), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'request_timeout');
      return true;
    });
  });

  it('bounds JWT payloads and validates expiration values', () => {
    assert.throws(
      () => decodeJwtPayload(`x.${'a'.repeat(1024 * 1024)}.x`),
      /size limit/,
    );
    assert.equal(
      decodeJwtPayload(jwt({ exp: Number.MAX_SAFE_INTEGER + 1 })).exp,
      Number.MAX_SAFE_INTEGER + 1,
    );
    assert.equal(
      tryGetJwtExpiration(jwt({ exp: Number.MAX_SAFE_INTEGER + 1 })),
      undefined,
    );
  });

  it('stores token files atomically with restrictive permissions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openai-oauth-store-'));
    const path = join(directory, 'auth.json');
    const store = new FileTokenStore(path);
    const storedTokens = tokens();
    try {
      await store.save(storedTokens);
      if (process.platform !== 'win32') {
        assert.equal((await lstat(path)).mode & 0o777, 0o600);
      }
      assert.deepEqual(await store.load(), storedTokens);

      if (process.platform !== 'win32') {
        await chmod(path, 0o644);
        await assert.rejects(store.load(), /permissions must be 0600/);
        await rm(path);
        await symlink(join(directory, 'missing'), path);
        await assert.rejects(store.load(), /Unsafe OpenAI OAuth token file/);
        assert.equal(await readFile(path).catch(() => undefined), undefined);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('rejects relative credential override paths', () => {
    const previous = process.env.OPENAI_OAUTH_AUTH_FILE;
    process.env.OPENAI_OAUTH_AUTH_FILE = 'auth.json';
    try {
      assert.throws(defaultTokenFilePath, /must be an absolute path/);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_OAUTH_AUTH_FILE;
      } else {
        process.env.OPENAI_OAUTH_AUTH_FILE = previous;
      }
    }
  });

  it('coordinates refresh-token rotation across file-store instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openai-oauth-lock-'));
    const path = join(directory, 'auth.json');
    const initial = tokens();
    await new FileTokenStore(path).save(initial);
    const seenRefreshTokens: string[] = [];
    let calls = 0;
    const fetchMock: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { refresh_token: string };
      seenRefreshTokens.push(body.refresh_token);
      calls += 1;
      return jsonResponse({
        access_token: `access-${calls}`,
        refresh_token: `refresh-${calls}`,
      });
    };
    try {
      const first = new OpenAIOAuth({
        fetch: fetchMock,
        tokenStore: new FileTokenStore(path),
      });
      const second = new OpenAIOAuth({
        fetch: fetchMock,
        tokenStore: new FileTokenStore(path),
      });

      await Promise.all([first.refresh(), second.refresh()]);

      assert.deepEqual(seenRefreshTokens, [initial.refreshToken, 'refresh-1']);
      assert.equal(
        (await new FileTokenStore(path).load())?.refreshToken,
        'refresh-2',
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
