import type { OpenAIOAuthTokens } from '../src/index.js';

export function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`;
}

export function tokens(
  overrides: Partial<OpenAIOAuthTokens> = {},
): OpenAIOAuthTokens {
  const idToken = jwt({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'account-123',
      chatgpt_plan_type: 'plus',
    },
  });
  return {
    accessToken: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    accountId: 'account-123',
    idToken,
    refreshToken: 'refresh-123',
    updatedAt: Date.now(),
    ...overrides,
  };
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
