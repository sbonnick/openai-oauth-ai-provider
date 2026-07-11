import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createAuthenticatedFetch,
  MemoryTokenStore,
  OpenAIOAuth,
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
});
