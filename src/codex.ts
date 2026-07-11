import { OpenAIOAuth, type OpenAIOAuthOptions } from './auth.js';
import { createAuthenticatedFetch } from './authenticated-fetch.js';
import { CHATGPT_CODEX_BASE_URL, DEFAULT_ORIGINATOR } from './constants.js';
import { CodexError } from './errors.js';

const DEFAULT_CLIENT_VERSION = '0.1.0';

export interface CodexJsonObject {
  readonly [key: string]: unknown;
}

export interface CodexModel extends CodexJsonObject {
  readonly slug: string;
}

export type CodexUsage = CodexJsonObject;
export type CodexAccountStatus = CodexJsonObject;

export interface CodexOptions {
  readonly auth?: OpenAIOAuth;
  readonly authOptions?: OpenAIOAuthOptions;
  readonly baseURL?: string;
  readonly clientVersion?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly originator?: string;
}

export interface Codex {
  readonly auth: OpenAIOAuth;
  listCodexModels(): Promise<readonly CodexModel[]>;
  getCodexUsage(): Promise<CodexUsage>;
  getCodexAccountStatus(): Promise<CodexAccountStatus>;
}

function objectResponse(value: unknown, endpoint: string): CodexJsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CodexError(
      'invalid_response',
      `Codex ${endpoint} response is not a JSON object.`,
    );
  }
  return value as CodexJsonObject;
}

function modelResponse(value: unknown): CodexModel {
  const model = objectResponse(value, 'models');
  if (typeof model.slug !== 'string' || model.slug.length === 0) {
    throw new CodexError(
      'invalid_response',
      'Codex models response contains a model without a slug.',
    );
  }
  return model as CodexModel;
}

function endpointURL(baseURL: string, path: string): string {
  return new URL(path, `${baseURL.replace(/\/$/, '')}/`).href;
}

function whamEndpointURL(baseURL: string, path: string): string {
  return new URL(`../wham/${path}`, `${baseURL.replace(/\/$/, '')}/`).href;
}

/**
 * Creates an authenticated client for read-only ChatGPT Codex backend utilities.
 * These endpoints are private backend contracts and may change without notice.
 */
export function codex(options: CodexOptions = {}): Codex {
  const auth = options.auth ?? new OpenAIOAuth(options.authOptions);
  const baseURL = options.baseURL ?? CHATGPT_CODEX_BASE_URL;
  const clientVersion = options.clientVersion ?? DEFAULT_CLIENT_VERSION;
  if (clientVersion.length === 0) {
    throw new TypeError('clientVersion must not be empty.');
  }
  const authenticatedFetch = createAuthenticatedFetch(auth, {
    allowedOrigins: [new URL(baseURL).origin],
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    originator: options.originator ?? DEFAULT_ORIGINATOR,
  });

  const requestJson = async (url: string, endpoint: string) => {
    const response = await authenticatedFetch(url, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new CodexError(
        'request_failed',
        `Codex ${endpoint} request failed: HTTP ${response.status}.`,
        { status: response.status },
      );
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new CodexError(
        'invalid_response',
        `Codex ${endpoint} response is not valid JSON.`,
      );
    }
    return objectResponse(value, endpoint);
  };

  return {
    auth,
    async listCodexModels() {
      const url = new URL(endpointURL(baseURL, 'models'));
      url.searchParams.set('client_version', clientVersion);
      const response = await requestJson(url.href, 'models');
      if (!Array.isArray(response.models)) {
        throw new CodexError(
          'invalid_response',
          'Codex models response is missing models.',
        );
      }
      return response.models.map(modelResponse);
    },
    getCodexUsage() {
      return requestJson(whamEndpointURL(baseURL, 'usage'), 'usage');
    },
    getCodexAccountStatus() {
      return requestJson(
        whamEndpointURL(baseURL, 'accounts/check'),
        'account status',
      );
    },
  };
}
