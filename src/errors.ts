export type OpenAIOAuthErrorCode =
  | 'aborted'
  | 'auth_required'
  | 'device_authorization_failed'
  | 'device_authorization_timeout'
  | 'invalid_token'
  | 'oauth_exchange_failed'
  | 'refresh_failed'
  | 'workspace_mismatch';

export class OpenAIOAuthError extends Error {
  readonly code: OpenAIOAuthErrorCode;
  readonly status?: number;

  constructor(
    code: OpenAIOAuthErrorCode,
    message: string,
    options: { cause?: unknown; status?: number } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'OpenAIOAuthError';
    this.code = code;
    if (options.status !== undefined) {
      this.status = options.status;
    }
  }
}
