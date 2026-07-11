import type { StreamChunk } from '@tanstack/ai';
import {
  type OpenAIChatModel,
  OpenAITextAdapter,
  type OpenAITextConfig,
} from '@tanstack/ai-openai';
import { OpenAIOAuth, type OpenAIOAuthOptions } from './auth.js';
import { createAuthenticatedFetch } from './authenticated-fetch.js';
import { CHATGPT_CODEX_BASE_URL, DEFAULT_ORIGINATOR } from './constants.js';

export interface OpenAIOAuthTanStackConfig
  extends Omit<OpenAITextConfig, 'apiKey' | 'baseURL' | 'fetch'> {
  readonly auth?: OpenAIOAuth;
  readonly authOptions?: OpenAIOAuthOptions;
  readonly baseURL?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly originator?: string;
}

type AdapterTextOptions = Parameters<
  OpenAITextAdapter<OpenAIChatModel>['chatStream']
>[0];
type AdapterStructuredOptions = Parameters<
  OpenAITextAdapter<OpenAIChatModel>['structuredOutput']
>[0];
type AdapterStructuredResult = Awaited<
  ReturnType<OpenAITextAdapter<OpenAIChatModel>['structuredOutput']>
>;

/**
 * TanStack AI text adapter authenticated with a ChatGPT subscription.
 *
 * TanStack's official OpenAI Responses adapter provides the AG-UI translation,
 * tool loop, reasoning, and schema support. This subclass supplies rotating
 * OAuth credentials and enforces the stateless, stream-only Codex contract.
 */
export class OpenAIOAuthTextAdapter extends OpenAITextAdapter<OpenAIChatModel> {
  readonly auth: OpenAIOAuth;

  constructor(model: string, config: OpenAIOAuthTanStackConfig = {}) {
    const {
      auth = new OpenAIOAuth(config.authOptions),
      authOptions: _authOptions,
      baseURL = CHATGPT_CODEX_BASE_URL,
      fetch,
      originator = DEFAULT_ORIGINATOR,
      ...openAIConfig
    } = config;
    void _authOptions;
    super(
      {
        ...openAIConfig,
        apiKey: 'managed-by-openai-oauth',
        baseURL,
        fetch: createAuthenticatedFetch(auth, {
          allowedOrigins: [baseURL],
          ...(fetch === undefined ? {} : { fetch }),
          originator,
        }),
      },
      model as OpenAIChatModel,
    );
    this.auth = auth;
  }

  override chatStream(options: AdapterTextOptions): AsyncIterable<StreamChunk> {
    return super.chatStream(this.withCodexDefaults(options));
  }

  override structuredOutputStream(
    options: AdapterStructuredOptions,
  ): AsyncIterable<StreamChunk> {
    return super.structuredOutputStream({
      ...options,
      chatOptions: this.withCodexDefaults(
        options.chatOptions as AdapterTextOptions,
      ),
    });
  }

  override async structuredOutput(
    options: AdapterStructuredOptions,
  ): Promise<AdapterStructuredResult> {
    for await (const chunk of this.structuredOutputStream(options)) {
      if (chunk.type === 'RUN_ERROR') {
        throw new Error(chunk.message);
      }
      if (
        chunk.type === 'CUSTOM' &&
        chunk.name === 'structured-output.complete'
      ) {
        const value = chunk.value as {
          object?: unknown;
          raw?: unknown;
        };
        if (typeof value.raw !== 'string') {
          throw new Error(
            'TanStack structured output completed without raw JSON text.',
          );
        }
        return { data: value.object, rawText: value.raw };
      }
    }
    throw new Error(
      'TanStack structured output stream ended without a completion event.',
    );
  }

  private withCodexDefaults(options: AdapterTextOptions): AdapterTextOptions {
    const modelOptions = (options.modelOptions ?? {}) as Record<
      string,
      unknown
    >;
    const configuredInclude = Array.isArray(modelOptions.include)
      ? modelOptions.include.filter(
          (value): value is string => typeof value === 'string',
        )
      : [];
    const include = configuredInclude.includes('reasoning.encrypted_content')
      ? configuredInclude
      : [...configuredInclude, 'reasoning.encrypted_content'];

    return {
      ...options,
      modelOptions: {
        ...modelOptions,
        include,
        parallel_tool_calls: modelOptions.parallel_tool_calls ?? true,
        store: false,
      },
    } as AdapterTextOptions;
  }
}

export type OpenAIOAuthTextAdapterFor<TModel extends string> = Omit<
  OpenAIOAuthTextAdapter,
  'model'
> & { readonly model: TModel };

/** Creates a TanStack AI text adapter backed by OpenAI OAuth/Codex. */
export function openaiOAuthText<TModel extends string>(
  model: TModel,
  config: OpenAIOAuthTanStackConfig = {},
): OpenAIOAuthTextAdapterFor<TModel> {
  return new OpenAIOAuthTextAdapter(
    model,
    config,
  ) as unknown as OpenAIOAuthTextAdapterFor<TModel>;
}
