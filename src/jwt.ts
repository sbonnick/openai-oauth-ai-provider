import { OpenAIOAuthError } from './errors.js';

export interface OpenAIOAuthJwtClaims {
  readonly accountId?: string;
  readonly email?: string;
  readonly expiresAt?: number;
  readonly isFedRamp?: boolean;
  readonly planType?: string;
  readonly userId?: string;
}

interface JwtPayload {
  readonly email?: unknown;
  readonly exp?: unknown;
  readonly [key: string]: unknown;
}

interface OpenAIAuthClaims {
  readonly chatgpt_account_id?: unknown;
  readonly chatgpt_account_is_fedramp?: unknown;
  readonly chatgpt_plan_type?: unknown;
  readonly chatgpt_user_id?: unknown;
  readonly user_id?: unknown;
}

interface OpenAIProfileClaims {
  readonly email?: unknown;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function decodeJwtPayload(token: string): JwtPayload {
  if (token.length > 1024 * 1024) {
    throw new OpenAIOAuthError('invalid_token', 'JWT exceeds the size limit.');
  }
  const parts = token.split('.');
  const payload = parts[1];
  if (parts.length !== 3 || payload === undefined || payload.length === 0) {
    throw new OpenAIOAuthError('invalid_token', 'Invalid JWT format.');
  }

  try {
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    const value: unknown = JSON.parse(decoded);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('JWT payload is not an object.');
    }
    return value as JwtPayload;
  } catch {
    throw new OpenAIOAuthError(
      'invalid_token',
      'Could not decode JWT payload.',
    );
  }
}

export function parseOpenAIOAuthJwtClaims(token: string): OpenAIOAuthJwtClaims {
  const payload = decodeJwtPayload(token);
  const authValue = payload['https://api.openai.com/auth'];
  const profileValue = payload['https://api.openai.com/profile'];
  const auth =
    typeof authValue === 'object' && authValue !== null
      ? (authValue as OpenAIAuthClaims)
      : undefined;
  const profile =
    typeof profileValue === 'object' && profileValue !== null
      ? (profileValue as OpenAIProfileClaims)
      : undefined;
  const accountId = optionalString(auth?.chatgpt_account_id);
  const email = optionalString(payload.email) ?? optionalString(profile?.email);
  const planType = optionalString(auth?.chatgpt_plan_type);
  const userId = optionalString(auth?.chatgpt_user_id ?? auth?.user_id);

  return {
    ...(accountId === undefined ? {} : { accountId }),
    ...(email === undefined ? {} : { email }),
    ...(typeof payload.exp === 'number' &&
    Number.isFinite(payload.exp) &&
    Number.isSafeInteger(payload.exp)
      ? { expiresAt: payload.exp * 1000 }
      : {}),
    ...(typeof auth?.chatgpt_account_is_fedramp === 'boolean'
      ? { isFedRamp: auth.chatgpt_account_is_fedramp }
      : {}),
    ...(planType === undefined ? {} : { planType }),
    ...(userId === undefined ? {} : { userId }),
  };
}

export function tryGetJwtExpiration(token: string): number | undefined {
  try {
    const payload = decodeJwtPayload(token);
    return typeof payload.exp === 'number' &&
      Number.isFinite(payload.exp) &&
      Number.isSafeInteger(payload.exp)
      ? payload.exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}
