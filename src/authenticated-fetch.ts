import { CHATGPT_CODEX_BASE_URL, DEFAULT_ORIGINATOR } from './constants.js';
import type { OpenAIOAuth } from './auth.js';

export interface AuthenticatedFetchOptions {
  readonly allowedOrigins?: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
  readonly originator?: string;
}

function normalizeAllowedOrigins(origins: readonly string[]): Set<string> {
  return new Set(
    origins.map((origin) => {
      const url = new URL(origin);
      if (url.protocol !== 'https:') {
        throw new TypeError('Authenticated OpenAI requests require HTTPS.');
      }
      return url.origin;
    }),
  );
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

export function createAuthenticatedFetch(
  auth: OpenAIOAuth,
  options: AuthenticatedFetchOptions = {},
): typeof globalThis.fetch {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const originator = options.originator ?? DEFAULT_ORIGINATOR;
  const allowedOrigins = normalizeAllowedOrigins(
    options.allowedOrigins ?? [CHATGPT_CODEX_BASE_URL],
  );

  return async (input, init) => {
    const url = requestUrl(input);
    if (!allowedOrigins.has(url.origin)) {
      throw new TypeError(
        `Refusing to send OpenAI OAuth credentials to ${url.origin}.`,
      );
    }
    if (url.protocol !== 'https:') {
      throw new TypeError('Authenticated OpenAI requests require HTTPS.');
    }

    const retryInput = input instanceof Request ? input.clone() : input;
    const execute = async (attemptInput: RequestInfo | URL) => {
      const tokens = await auth.getTokens();
      const headers = new Headers(
        init?.headers ??
          (attemptInput instanceof Request ? attemptInput.headers : undefined),
      );
      headers.set('authorization', `Bearer ${tokens.accessToken}`);
      headers.set('originator', originator);
      if (tokens.accountId !== undefined) {
        headers.set('chatgpt-account-id', tokens.accountId);
      } else {
        headers.delete('chatgpt-account-id');
      }
      if (tokens.isFedRamp === true) {
        headers.set('x-openai-fedramp', 'true');
      } else {
        headers.delete('x-openai-fedramp');
      }
      const response = await fetchImplementation(attemptInput, {
        ...init,
        headers,
        redirect: 'error',
      });
      return { accessToken: tokens.accessToken, response };
    };

    let { accessToken, response } = await execute(input);
    if (response.status === 401) {
      await response.body?.cancel();
      if (init?.body instanceof ReadableStream) {
        throw new TypeError(
          'Cannot retry an authenticated request with a streaming body.',
        );
      }
      const current = await auth.getTokens();
      if (current.accessToken === accessToken) {
        await auth.refresh();
      }
      ({ accessToken, response } = await execute(retryInput));
    }
    return response;
  };
}
