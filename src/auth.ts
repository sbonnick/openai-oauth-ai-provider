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

const MAX_AUTH_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface OpenAIOAuthOptions {
  readonly clientId?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly issuer?: string;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
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

function responseDetails(response: Response): string {
  return `HTTP ${response.status}`;
}

async function responseJson<T>(
  response: Response,
  errorCode: OpenAIOAuthError['code'],
  timeoutMs: number,
): Promise<T> {
  const contentLength = Number(response.headers.get('content-length'));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_AUTH_RESPONSE_BYTES
  ) {
    throw new OpenAIOAuthError(
      errorCode,
      'OpenAI authentication response is too large.',
    );
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new OpenAIOAuthError(
      errorCode,
      'OpenAI authentication response is empty.',
    );
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_AUTH_RESPONSE_BYTES) {
        await reader.cancel();
        throw new OpenAIOAuthError(
          errorCode,
          'OpenAI authentication response is too large.',
        );
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch {
      throw new OpenAIOAuthError(
        errorCode,
        'OpenAI authentication response is not valid JSON.',
      );
    }
  };
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          void reader.cancel();
          reject(
            new OpenAIOAuthError(
              'request_timeout',
              'OpenAI authentication response timed out.',
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
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
  private readonly pendingAuthorizations = new WeakMap<
    DeviceAuthorization,
    PendingDeviceAuthorization
  >();
  private readonly requestTimeoutMs: number;
  private cachedTokens: OpenAIOAuthTokens | undefined;
  private loaded = false;
  private mutationQueue: Promise<void> = Promise.resolve();
  private refreshPromise: Promise<OpenAIOAuthTokens> | undefined;
  private stateGeneration = 0;

  constructor(options: OpenAIOAuthOptions = {}) {
    this.clientId = options.clientId ?? CODEX_OAUTH_CLIENT_ID;
    const issuer = new URL(options.issuer ?? OPENAI_AUTH_ISSUER);
    if (issuer.protocol !== 'https:') {
      throw new TypeError('The OpenAI OAuth issuer must use HTTPS.');
    }
    this.issuer = issuer.href.replace(/\/$/, '');
    this.tokenStore = options.tokenStore ?? new FileTokenStore();
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new TypeError('requestTimeoutMs must be a positive finite number.');
    }
  }

  async startDeviceAuthorization(
    options: { signal?: AbortSignal } = {},
  ): Promise<DeviceAuthorization> {
    return this.requestDeviceAuthorization(options.signal);
  }

  async completeDeviceAuthorization(
    authorization: DeviceAuthorization,
    options: { signal?: AbortSignal } = {},
  ): Promise<OpenAIOAuthTokens> {
    const pending = this.pendingAuthorizations.get(authorization);
    if (pending === undefined) {
      throw new TypeError(
        'The authorization must be returned by startDeviceAuthorization() on this client.',
      );
    }
    this.pendingAuthorizations.delete(authorization);

    const code = await this.pollForAuthorizationCode(pending, options.signal);
    const response = await this.fetchWithTimeout(`${this.issuer}/oauth/token`, {
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
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new OpenAIOAuthError(
        'oauth_exchange_failed',
        `OpenAI token exchange failed: ${responseDetails(response)}`,
        { status: response.status },
      );
    }
    const value = await responseJson<OAuthTokenResponse>(
      response,
      'oauth_exchange_failed',
      this.requestTimeoutMs,
    );
    return this.persistOAuthResponse(value);
  }

  async loginWithDeviceCode(
    options: DeviceLoginOptions = {},
  ): Promise<OpenAIOAuthTokens> {
    const authorization = await this.startDeviceAuthorization({
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
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
    this.stateGeneration += 1;
    const clear = () =>
      this.queueMutation(async () => {
        await this.tokenStore.clear();
        this.cachedTokens = undefined;
        this.loaded = true;
      });
    await (this.tokenStore.withLock?.(clear) ?? clear());
  }

  private async requestDeviceAuthorization(
    signal?: AbortSignal,
  ): Promise<DeviceAuthorization> {
    const response = await this.fetchWithTimeout(
      `${this.issuer}/api/accounts/deviceauth/usercode`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: this.clientId }),
      },
      signal,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new OpenAIOAuthError(
        'device_authorization_failed',
        `OpenAI device authorization failed: ${responseDetails(response)}`,
        { status: response.status },
      );
    }
    const value = await responseJson<DeviceCodeResponse>(
      response,
      'device_authorization_failed',
      this.requestTimeoutMs,
    );
    const pending: PendingDeviceAuthorization = {
      deviceAuthId: requiredString(value.device_auth_id, 'device_auth_id'),
      expiresAt: this.now() + DEVICE_AUTH_TIMEOUT_MS,
      intervalMs: parseInterval(value.interval),
      userCode: requiredString(value.user_code ?? value.usercode, 'user_code'),
      verificationUrl: `${this.issuer}/codex/device`,
    };
    const authorization: DeviceAuthorization = {
      expiresAt: pending.expiresAt,
      userCode: pending.userCode,
      verificationUrl: pending.verificationUrl,
    };
    this.pendingAuthorizations.set(authorization, pending);
    return authorization;
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
      const response = await this.fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            device_auth_id: authorization.deviceAuthId,
            user_code: authorization.userCode,
          }),
          ...(signal === undefined ? {} : { signal }),
        },
        signal,
      );
      if (response.ok) {
        return responseJson<DeviceTokenResponse>(
          response,
          'device_authorization_failed',
          this.requestTimeoutMs,
        );
      }
      if (response.status !== 403 && response.status !== 404) {
        await response.body?.cancel();
        throw new OpenAIOAuthError(
          'device_authorization_failed',
          `OpenAI device authorization polling failed: ${responseDetails(response)}`,
          { status: response.status },
        );
      }
      await response.body?.cancel();
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
      ...(claims.isFedRamp === undefined
        ? {}
        : { isFedRamp: claims.isFedRamp }),
      ...(claims.planType === undefined ? {} : { planType: claims.planType }),
      refreshToken: requiredString(response.refresh_token, 'refresh_token'),
      updatedAt: this.now(),
    };
    this.stateGeneration += 1;
    const generation = this.stateGeneration;
    const commit = () => this.commitTokens(tokens, generation);
    await (this.tokenStore.withLock?.(commit) ?? commit());
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
    if (this.tokenStore.withLock !== undefined) {
      return this.tokenStore.withLock(async () => {
        this.cachedTokens = await this.tokenStore.load();
        this.loaded = true;
        return this.performRefreshUnlocked();
      });
    }
    return this.performRefreshUnlocked();
  }

  private async performRefreshUnlocked(): Promise<OpenAIOAuthTokens> {
    const generation = this.stateGeneration;
    const current = await this.loadTokens();
    if (current === undefined) {
      throw new OpenAIOAuthError(
        'auth_required',
        'No ChatGPT authentication is available to refresh.',
      );
    }
    const response = await this.fetchWithTimeout(`${this.issuer}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new OpenAIOAuthError(
        'refresh_failed',
        `OpenAI token refresh failed: ${responseDetails(response)}`,
        { status: response.status },
      );
    }
    const value = await responseJson<RefreshTokenResponse>(
      response,
      'refresh_failed',
      this.requestTimeoutMs,
    );
    const accessToken = requiredRefreshString(
      value.access_token,
      'access_token',
    );
    const idToken =
      value.id_token === undefined
        ? current.idToken
        : requiredRefreshString(value.id_token, 'id_token');
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
      accessToken,
      ...((claims.accountId ?? current.accountId) === undefined
        ? {}
        : { accountId: claims.accountId ?? current.accountId }),
      idToken,
      ...((claims.isFedRamp ?? current.isFedRamp) === undefined
        ? {}
        : { isFedRamp: claims.isFedRamp ?? current.isFedRamp }),
      ...((claims.planType ?? current.planType) === undefined
        ? {}
        : { planType: claims.planType ?? current.planType }),
      refreshToken:
        value.refresh_token === undefined
          ? current.refreshToken
          : requiredRefreshString(value.refresh_token, 'refresh_token'),
      updatedAt: this.now(),
    };
    await this.commitTokens(refreshed, generation);
    return refreshed;
  }

  private async loadTokens(): Promise<OpenAIOAuthTokens | undefined> {
    if (!this.loaded) {
      this.cachedTokens = await this.tokenStore.load();
      this.loaded = true;
    }
    return this.cachedTokens;
  }

  private async commitTokens(
    tokens: OpenAIOAuthTokens,
    generation: number,
  ): Promise<void> {
    await this.queueMutation(async () => {
      if (generation !== this.stateGeneration) {
        throw new OpenAIOAuthError(
          'auth_required',
          'Authentication changed while credentials were refreshing.',
        );
      }
      await this.tokenStore.save(tokens);
      this.cachedTokens = tokens;
      this.loaded = true;
    });
  }

  private async queueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async fetchWithTimeout(
    input: string | URL | Request,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (signal?.aborted) {
      throw abortError();
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.fetchImplementation(input, {
        ...init,
        signal: controller.signal,
      });
    } catch (cause) {
      if (signal?.aborted) {
        throw abortError();
      }
      if (controller.signal.aborted) {
        throw new OpenAIOAuthError(
          'request_timeout',
          'OpenAI authentication request timed out.',
        );
      }
      throw cause;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

function requiredRefreshString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OpenAIOAuthError(
      'refresh_failed',
      `OpenAI token refresh response is missing ${name}.`,
    );
  }
  return value;
}
