import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface OpenAIOAuthTokens {
  readonly accessToken: string;
  readonly accountId?: string;
  readonly idToken: string;
  readonly isFedRamp?: boolean;
  readonly planType?: string;
  readonly refreshToken: string;
  readonly updatedAt: number;
}

export interface TokenStore {
  clear(): Promise<void>;
  load(): Promise<OpenAIOAuthTokens | undefined>;
  save(tokens: OpenAIOAuthTokens): Promise<void>;
}

interface StoredTokenFile {
  readonly tokens: OpenAIOAuthTokens;
  readonly version: 1;
}

export function defaultTokenFilePath(): string {
  if (process.env.OPENAI_OAUTH_AUTH_FILE) {
    return process.env.OPENAI_OAUTH_AUTH_FILE;
  }
  if (process.platform === 'win32') {
    const appData =
      process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'openai-outh-ai-provider', 'auth.json');
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(configHome, 'openai-outh-ai-provider', 'auth.json');
}

function isTokens(value: unknown): value is OpenAIOAuthTokens {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<OpenAIOAuthTokens>;
  return (
    typeof candidate.accessToken === 'string' &&
    typeof candidate.idToken === 'string' &&
    typeof candidate.refreshToken === 'string' &&
    typeof candidate.updatedAt === 'number'
  );
}

export class FileTokenStore implements TokenStore {
  readonly path: string;

  constructor(path = defaultTokenFilePath()) {
    this.path = path;
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }

  async load(): Promise<OpenAIOAuthTokens | undefined> {
    let source: string;
    try {
      source = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }

    const value: unknown = JSON.parse(source);
    if (
      typeof value !== 'object' ||
      value === null ||
      (value as Partial<StoredTokenFile>).version !== 1 ||
      !isTokens((value as Partial<StoredTokenFile>).tokens)
    ) {
      throw new TypeError(`Invalid OpenAI OAuth token file: ${this.path}`);
    }
    return (value as StoredTokenFile).tokens;
  }

  async save(tokens: OpenAIOAuthTokens): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const content = `${JSON.stringify({ version: 1, tokens }, null, 2)}\n`;
    try {
      await writeFile(temporaryPath, content, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

export class MemoryTokenStore implements TokenStore {
  private tokens: OpenAIOAuthTokens | undefined;

  constructor(tokens?: OpenAIOAuthTokens) {
    this.tokens = tokens;
  }

  async clear(): Promise<void> {
    this.tokens = undefined;
  }

  async load(): Promise<OpenAIOAuthTokens | undefined> {
    return this.tokens;
  }

  async save(tokens: OpenAIOAuthTokens): Promise<void> {
    this.tokens = tokens;
  }
}
