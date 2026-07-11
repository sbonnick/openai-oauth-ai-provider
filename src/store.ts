import {
  constants as fsConstants,
  mkdir,
  lstat,
  open,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

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
  withLock?<T>(operation: () => Promise<T>): Promise<T>;
}

interface StoredTokenFile {
  readonly tokens: OpenAIOAuthTokens;
  readonly version: 1;
}

export function defaultTokenFilePath(): string {
  if (process.env.OPENAI_OAUTH_AUTH_FILE) {
    if (!isAbsolute(process.env.OPENAI_OAUTH_AUTH_FILE)) {
      throw new TypeError('OPENAI_OAUTH_AUTH_FILE must be an absolute path.');
    }
    return process.env.OPENAI_OAUTH_AUTH_FILE;
  }
  if (process.platform === 'win32') {
    const appData =
      process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'openai-oauth-ai-provider', 'auth.json');
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(configHome, 'openai-oauth-ai-provider', 'auth.json');
}

function isTokens(value: unknown): value is OpenAIOAuthTokens {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<OpenAIOAuthTokens>;
  return (
    typeof candidate.accessToken === 'string' &&
    candidate.accessToken.length > 0 &&
    typeof candidate.idToken === 'string' &&
    candidate.idToken.length > 0 &&
    typeof candidate.refreshToken === 'string' &&
    candidate.refreshToken.length > 0 &&
    typeof candidate.updatedAt === 'number' &&
    Number.isFinite(candidate.updatedAt) &&
    (candidate.accountId === undefined ||
      (typeof candidate.accountId === 'string' &&
        candidate.accountId.length > 0)) &&
    (candidate.planType === undefined ||
      (typeof candidate.planType === 'string' &&
        candidate.planType.length > 0)) &&
    (candidate.isFedRamp === undefined ||
      typeof candidate.isFedRamp === 'boolean')
  );
}

async function ensureSecureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError(`Unsafe OpenAI OAuth token directory: ${directory}`);
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o022) !== 0) {
    throw new TypeError(
      `OpenAI OAuth token directory must not be group/world writable: ${directory}`,
    );
  }
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
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        this.path,
        process.platform === 'win32'
          ? 'r'
          : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        throw new TypeError(`Unsafe OpenAI OAuth token file: ${this.path}`);
      }
      if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
        throw new TypeError(
          `OpenAI OAuth token file permissions must be 0600: ${this.path}`,
        );
      }
      source = await handle.readFile('utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return undefined;
      }
      if (code === 'ELOOP') {
        throw new TypeError(`Unsafe OpenAI OAuth token file: ${this.path}`);
      }
      throw error;
    } finally {
      await handle?.close();
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
    await ensureSecureDirectory(directory);
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    const content = `${JSON.stringify({ version: 1, tokens }, null, 2)}\n`;
    try {
      await writeFile(temporaryPath, content, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const directory = dirname(this.path);
    const lockPath = `${this.path}.lock`;
    await ensureSecureDirectory(directory);
    const deadline = Date.now() + 30_000;
    while (true) {
      try {
        await writeFile(lockPath, `${process.pid}\n`, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        const metadata = await lstat(lockPath).catch(() => undefined);
        if (metadata !== undefined && Date.now() - metadata.mtimeMs > 120_000) {
          await rm(lockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out waiting for token store lock: ${lockPath}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lockPath, { force: true });
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
