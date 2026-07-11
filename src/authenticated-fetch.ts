import { DEFAULT_ORIGINATOR } from './constants.js';
import type { OpenAIOAuth } from './auth.js';

export interface AuthenticatedFetchOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly originator?: string;
}

export function createAuthenticatedFetch(
  auth: OpenAIOAuth,
  options: AuthenticatedFetchOptions = {},
): typeof globalThis.fetch {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const originator = options.originator ?? DEFAULT_ORIGINATOR;

  return async (input, init) => {
    const execute = async () => {
      const tokens = await auth.getTokens();
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
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
      return fetchImplementation(input, { ...init, headers });
    };

    let response = await execute();
    if (response.status === 401) {
      await response.body?.cancel();
      await auth.refresh();
      response = await execute();
    }
    return response;
  };
}
