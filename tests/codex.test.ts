import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  codex,
  CodexError,
  MemoryTokenStore,
  OpenAIOAuth,
} from '../src/codex-client.js';
import { jsonResponse, tokens } from './helpers.js';

describe('codex', () => {
  it('retrieves models, usage, and account status with managed authentication', async () => {
    const requests: Array<{ headers: Headers; url: URL }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      requests.push({ headers: new Headers(init?.headers), url });
      if (url.pathname === '/backend-api/codex/models') {
        return jsonResponse({ models: [{ slug: 'gpt-5.4', priority: 1 }] });
      }
      if (url.pathname === '/backend-api/wham/usage') {
        return jsonResponse({ plan_type: 'pro', rate_limit: null });
      }
      if (url.pathname === '/backend-api/wham/accounts/check') {
        return jsonResponse({ account_status: 'active' });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const auth = new OpenAIOAuth({
      tokenStore: new MemoryTokenStore(tokens()),
    });
    const client = codex({
      auth,
      clientVersion: '1.2.3',
      fetch: fetchMock,
      originator: 'test-client',
    });

    assert.deepEqual(await client.listCodexModels(), [
      { slug: 'gpt-5.4', priority: 1 },
    ]);
    assert.deepEqual(await client.getCodexUsage(), {
      plan_type: 'pro',
      rate_limit: null,
    });
    assert.deepEqual(await client.getCodexAccountStatus(), {
      account_status: 'active',
    });

    assert.equal(
      requests[0]?.url.href,
      'https://chatgpt.com/backend-api/codex/models?client_version=1.2.3',
    );
    for (const request of requests) {
      assert.equal(
        request.headers.get('authorization'),
        `Bearer ${(await auth.getTokens()).accessToken}`,
      );
      assert.equal(request.headers.get('chatgpt-account-id'), 'account-123');
      assert.equal(request.headers.get('originator'), 'test-client');
      assert.equal(request.headers.get('accept'), 'application/json');
    }
    assert.deepEqual(
      requests.slice(1).map((request) => request.url.pathname),
      ['/backend-api/wham/usage', '/backend-api/wham/accounts/check'],
    );
  });

  it('refreshes once and retries an unauthorized utility request', async () => {
    const initial = tokens();
    const authorizations: string[] = [];
    let usageCalls = 0;
    const fetchMock: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/oauth/token') {
        return jsonResponse({ access_token: 'refreshed-access-token' });
      }
      usageCalls += 1;
      authorizations.push(
        new Headers(init?.headers).get('authorization') ?? '',
      );
      return jsonResponse({ plan_type: 'plus' }, usageCalls === 1 ? 401 : 200);
    };
    const client = codex({
      authOptions: {
        fetch: fetchMock,
        tokenStore: new MemoryTokenStore(initial),
      },
      fetch: fetchMock,
    });

    assert.deepEqual(await client.getCodexUsage(), { plan_type: 'plus' });
    assert.equal(usageCalls, 2);
    assert.deepEqual(authorizations, [
      `Bearer ${initial.accessToken}`,
      'Bearer refreshed-access-token',
    ]);
  });

  it('rejects malformed responses without including response data in errors', async () => {
    const secret = 'model-response-secret';
    const client = codex({
      auth: new OpenAIOAuth({
        tokenStore: new MemoryTokenStore(tokens()),
      }),
      fetch: async () => jsonResponse({ detail: secret }),
    });

    await assert.rejects(client.listCodexModels(), (error: unknown) => {
      assert(error instanceof CodexError);
      assert.equal(error.code, 'invalid_response');
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
  });

  it('rejects invalid JSON without retaining response data as an error cause', async () => {
    const secret = 'invalid-json-secret';
    const client = codex({
      auth: new OpenAIOAuth({
        tokenStore: new MemoryTokenStore(tokens()),
      }),
      fetch: async () =>
        new Response(`{"secret":"${secret}"`, {
          headers: { 'content-type': 'application/json' },
        }),
    });

    await assert.rejects(client.getCodexUsage(), (error: unknown) => {
      assert(error instanceof CodexError);
      assert.equal(error.code, 'invalid_response');
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
  });

  it('rejects models with an invalid slug', async () => {
    const client = codex({
      auth: new OpenAIOAuth({
        tokenStore: new MemoryTokenStore(tokens()),
      }),
      fetch: async () => jsonResponse({ models: [{ slug: 42 }] }),
    });

    await assert.rejects(client.listCodexModels(), /without a slug/);
  });
});
