import {
  ACCESS_TOKEN_REFRESH_WINDOW_MS,
  CODEX_OAUTH_CLIENT_ID,
  DEVICE_AUTH_TIMEOUT_MS,
  OPENAI_AUTH_ISSUER,
  TOKEN_REFRESH_FALLBACK_AGE_MS,
} from './constants.js';
import { OpenAIOAuthError } from './errors.js';
import { parseOpenAIOAuthJwtClaims, tryGetJwtExpiration } from './jwt.js';
import {
  FileTokenStore,
  type OpenAIOAuthTokens,
  type TokenStore,
} from './store.js';

export interface DeviceAuthorization {
  readonly expiresAt: number;
  readonly userCode: string;
  readonly verificationUrl: string;
}

interface PendingDeviceAuthorization extends DeviceAuthorization {
  readonly deviceAuthId: string;
  readonly intervalMs: number;
}

interface DeviceCodeResponse {
  readonly device_auth_id?: unknown;
  readonly interval?: unknown;
  readonly user_code?: unknown;
  readonly usercode?: unknown;
}

interface DeviceTokenResponse {
  readonly authorization_code?: unknown;
  readonly code_challenge?: unknown;
  readonly code_verifier?: unknown;
}

interface OAuthTokenResponse {
  readonly access_token?: unknown;
  readonly id_token?: unknown;
  readonly refresh_token?: unknown;
}

interface RefreshTokenResponse {
  readonly access_token?: unknown;
  readonly id_token?: unknown;
  readonly refresh_token?: unknown;
}

export interface OpenAIOAuthOptions {
  readonly clientId?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly issuer?: string;
  readonly now?: () => number;
  readonly tokenStore?: TokenStore;
}

export interface DeviceLoginOptions {
  readonly onVerification?: (
    authorization: DeviceAuthorization,
  ) => void | Promise<void>;
  readonly signal?: AbortSignal;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OpenAIOAuthError(
      'device_authorization_failed',
      `OpenAI authentication response is missing ${name}.`,
    );
  }
  return value;
}

function parseInterval(value: unknown): number {
  const seconds =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5_000;
}

async function responseDetails(response: Response): Promise<string> {
  const body = (await response.text()).trim();
  if (body.length === 0) {
    return response.statusText || `HTTP ${response.status}`;
  }
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>;
      const error = record.error;
      if (typeof error === 'object' && error !== null) {
        const message = (error as Record<string, unknown>).message;
        const code = (error as Record<string, unknown>).code;
        if (typeof message === 'string') {
          return typeof code === 'string' ? `${code}: ${message}` : message;
        }
      }
      if (typeof error === 'string') {
        return error;
      }
      if (typeof record.message === 'string') {
        return record.message;
      }
    }
  } catch {
    // Fall through to the bounded plain-text response.
  }
  return body.slice(0, 500);
}

function abortError(): OpenAIOAuthError {
  return new OpenAIOAuthError('aborted', 'Authentication was cancelled.');
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class OpenAIOAuth {
  readonly clientId: string;
  readonly issuer: string;
  readonly tokenStore: TokenStore;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly now: () => number;
  private cachedTokens: OpenAIOAuthTokens | undefined;
  private loaded = false;
  private refreshPromise: Promise<OpenAIOAuthTokens> | undefined;

  constructor(options: OpenAIOAuthOptions = {}) {
    this.clientId = options.clientId ?? CODEX_OAUTH_CLIENT_ID;
    this.issuer = (options.issuer ?? OPENAI_AUTH_ISSUER).replace(/\/$/, '');
    this.tokenStore = options.tokenStore ?? new FileTokenStore();
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  async startDeviceAuthorization(): Promise<DeviceAuthorization> {
    return this.requestDeviceAuthorization();
  }

  async completeDeviceAuthorization(
    authorization: DeviceAuthorization,
    options: { signal?: AbortSignal } = {},
  ): Promise<OpenAIOAuthTokens> {
    const pending = authorization as PendingDeviceAuthorization;
    if (!pending.deviceAuthId || !pending.intervalMs) {
      throw new TypeError(
        'The authorization must be returned by startDeviceAuthorization() on this client.',
      );
    }

    const code = await this.pollForAuthorizationCode(pending, options.signal);
    const response = await this.fetchImplementation(
      `${this.issuer}/oauth/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: requiredString(code.authorization_code, 'authorization_code'),
          redirect_uri: `${this.issuer}/deviceauth/callback`,
          client_id: this.clientId,
          code_verifier: requiredString(code.code_verifier, 'code_verifier'),
        }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (!response.ok) {
      throw new OpenAIOAuthError(
        'oauth_exchange_failed',
        `OpenAI token exchange failed: ${await responseDetails(response)}`,
        { status: response.status },
      );
    }
    const value = (await response.json()) as OAuthTokenResponse;
    return this.persistOAuthResponse(value);
  }

  async loginWithDeviceCode(
    options: DeviceLoginOptions = {},
  ): Promise<OpenAIOAuthTokens> {
    const authorization = await this.startDeviceAuthorization();
    await options.onVerification?.(authorization);
    return this.completeDeviceAuthorization(authorization, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.loadTokens()) !== undefined;
  }

  async getTokens(): Promise<OpenAIOAuthTokens> {
    const tokens = await this.loadTokens();
    if (tokens === undefined) {
      throw new OpenAIOAuthError(
        'auth_required',
        'No ChatGPT authentication is available. Run the device login first.',
      );
    }
    if (!this.shouldRefresh(tokens)) {
      return tokens;
    }

    try {
      return await this.refresh();
    } catch (error) {
      const expiresAt = tryGetJwtExpiration(tokens.accessToken);
      if (expiresAt !== undefined && expiresAt > this.now()) {
        return tokens;
      }
      throw error;
    }
  }

  async refresh(): Promise<OpenAIOAuthTokens> {
    if (this.refreshPromise !== undefined) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.performRefresh().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  async logout(): Promise<void> {
    this.cachedTokens = undefined;
    this.loaded = true;
    await this.tokenStore.clear();
  }

  private async requestDeviceAuthorization(): Promise<PendingDeviceAuthorization> {
    const response = await this.fetchImplementation(
      `${this.issuer}/api/accounts/deviceauth/usercode`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: this.clientId }),
      },
    );
    if (!response.ok) {
      throw new OpenAIOAuthError(
        'device_authorization_failed',
        `OpenAI device authorization failed: ${await responseDetails(response)}`,
        { status: response.status },
      );
    }
    const value = (await response.json()) as DeviceCodeResponse;
    return {
      deviceAuthId: requiredString(value.device_auth_id, 'device_auth_id'),
      expiresAt: this.now() + DEVICE_AUTH_TIMEOUT_MS,
      intervalMs: parseInterval(value.interval),
      userCode: requiredString(value.user_code ?? value.usercode, 'user_code'),
      verificationUrl: `${this.issuer}/codex/device`,
    };
  }

  private async pollForAuthorizationCode(
    authorization: PendingDeviceAuthorization,
    signal?: AbortSignal,
  ): Promise<DeviceTokenResponse> {
    const url = `${this.issuer}/api/accounts/deviceauth/token`;
    while (this.now() < authorization.expiresAt) {
      if (signal?.aborted) {
        throw abortError();
      }
      const response = await this.fetchImplementation(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          device_auth_id: authorization.deviceAuthId,
          user_code: authorization.userCode,
        }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (response.ok) {
        return (await response.json()) as DeviceTokenResponse;
      }
      if (response.status !== 403 && response.status !== 404) {
        throw new OpenAIOAuthError(
          'device_authorization_failed',
          `OpenAI device authorization polling failed: ${await responseDetails(response)}`,
          { status: response.status },
        );
      }
      await sleep(
        Math.min(
          authorization.intervalMs,
          Math.max(0, authorization.expiresAt - this.now()),
        ),
        signal,
      );
    }
    throw new OpenAIOAuthError(
      'device_authorization_timeout',
      'OpenAI device authorization timed out after 15 minutes.',
    );
  }

  private async persistOAuthResponse(
    response: OAuthTokenResponse,
  ): Promise<OpenAIOAuthTokens> {
    const idToken = requiredString(response.id_token, 'id_token');
    const claims = parseOpenAIOAuthJwtClaims(idToken);
    const tokens: OpenAIOAuthTokens = {
      accessToken: requiredString(response.access_token, 'access_token'),
      ...(claims.accountId === undefined
        ? {}
        : { accountId: claims.accountId }),
      idToken,
      isFedRamp: claims.isFedRamp,
      ...(claims.planType === undefined ? {} : { planType: claims.planType }),
      refreshToken: requiredString(response.refresh_token, 'refresh_token'),
      updatedAt: this.now(),
    };
    await this.saveTokens(tokens);
    return tokens;
  }

  private shouldRefresh(tokens: OpenAIOAuthTokens): boolean {
    const expiresAt = tryGetJwtExpiration(tokens.accessToken);
    if (expiresAt !== undefined) {
      return expiresAt <= this.now() + ACCESS_TOKEN_REFRESH_WINDOW_MS;
    }
    return tokens.updatedAt < this.now() - TOKEN_REFRESH_FALLBACK_AGE_MS;
  }

  private async performRefresh(): Promise<OpenAIOAuthTokens> {
    const current = await this.loadTokens();
    if (current === undefined) {
      throw new OpenAIOAuthError(
        'auth_required',
        'No ChatGPT authentication is available to refresh.',
      );
    }
    const response = await this.fetchImplementation(
      `${this.issuer}/oauth/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: this.clientId,
          grant_type: 'refresh_token',
          refresh_token: current.refreshToken,
        }),
      },
    );
    if (!response.ok) {
      throw new OpenAIOAuthError(
        'refresh_failed',
        `OpenAI token refresh failed: ${await responseDetails(response)}`,
        { status: response.status },
      );
    }
    const value = (await response.json()) as RefreshTokenResponse;
    const idToken =
      typeof value.id_token === 'string' ? value.id_token : current.idToken;
    const claims = parseOpenAIOAuthJwtClaims(idToken);
    if (
      current.accountId !== undefined &&
      claims.accountId !== undefined &&
      current.accountId !== claims.accountId
    ) {
      throw new OpenAIOAuthError(
        'workspace_mismatch',
        'Refreshed credentials belong to a different ChatGPT workspace.',
      );
    }
    const refreshed: OpenAIOAuthTokens = {
      accessToken:
        typeof value.access_token === 'string'
          ? value.access_token
          : current.accessToken,
      ...((claims.accountId ?? current.accountId) === undefined
        ? {}
        : { accountId: claims.accountId ?? current.accountId }),
      idToken,
      isFedRamp: claims.isFedRamp,
      ...((claims.planType ?? current.planType) === undefined
        ? {}
        : { planType: claims.planType ?? current.planType }),
      refreshToken:
        typeof value.refresh_token === 'string'
          ? value.refresh_token
          : current.refreshToken,
      updatedAt: this.now(),
    };
    await this.saveTokens(refreshed);
    return refreshed;
  }

  private async loadTokens(): Promise<OpenAIOAuthTokens | undefined> {
    if (!this.loaded) {
      this.cachedTokens = await this.tokenStore.load();
      this.loaded = true;
    }
    return this.cachedTokens;
  }

  private async saveTokens(tokens: OpenAIOAuthTokens): Promise<void> {
    await this.tokenStore.save(tokens);
    this.cachedTokens = tokens;
    this.loaded = true;
  }
}
