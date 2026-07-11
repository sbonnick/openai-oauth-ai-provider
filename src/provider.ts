import type {
  EmbeddingModelV4,
  FilesV4,
  ImageModelV4,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
  ProviderV4,
  RerankingModelV4,
  SkillsV4,
  SpeechModelV4,
  TranscriptionModelV4,
} from '@ai-sdk/provider';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { OpenAIOAuth, type OpenAIOAuthOptions } from './auth.js';
import { createAuthenticatedFetch } from './authenticated-fetch.js';
import { collectLanguageModelStream } from './collect-stream.js';
import { CHATGPT_CODEX_BASE_URL, DEFAULT_ORIGINATOR } from './constants.js';

export interface CodexModelDefaults {
  /** Base instruction sent in the Responses API `instructions` field. */
  readonly instructions?: string;
  readonly parallelToolCalls?: boolean;
}

export interface OpenAIOAuthProviderOptions {
  readonly auth?: OpenAIOAuth;
  readonly authOptions?: OpenAIOAuthOptions;
  readonly baseURL?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Record<string, string>;
  readonly modelDefaults?: CodexModelDefaults;
  readonly originator?: string;
}

export interface OpenAIOAuthProvider extends ProviderV4 {
  (modelId: string): LanguageModelV4;
  readonly auth: OpenAIOAuth;
  readonly tools: OpenAIProvider['tools'];
  embedding(modelId: string): EmbeddingModelV4;
  files(): FilesV4;
  image(modelId: string): ImageModelV4;
  responses(modelId: string): LanguageModelV4;
  skills(): SkillsV4;
  speech(modelId: string): SpeechModelV4;
  transcription(modelId: string): TranscriptionModelV4;
}

function asProviderOptions(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

class CodexLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = 'v4';
  readonly supportedUrls: LanguageModelV4['supportedUrls'];

  constructor(
    private readonly model: LanguageModelV4,
    private readonly defaults: CodexModelDefaults,
  ) {
    this.supportedUrls = model.supportedUrls;
  }

  get modelId(): string {
    return this.model.modelId;
  }

  get provider(): string {
    return this.model.provider;
  }

  async doGenerate(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4GenerateResult> {
    const result = await this.model.doStream(this.withDefaults(options));
    return collectLanguageModelStream(result);
  }

  doStream(
    options: LanguageModelV4CallOptions,
  ): PromiseLike<LanguageModelV4StreamResult> {
    return this.model.doStream(this.withDefaults(options));
  }

  private withDefaults(
    options: LanguageModelV4CallOptions,
  ): LanguageModelV4CallOptions {
    const providerOptions = options.providerOptions ?? {};
    const openai = asProviderOptions(providerOptions.openai) ?? {};
    return {
      ...options,
      providerOptions: {
        ...providerOptions,
        openai: {
          ...openai,
          // Codex does not persist Responses objects. This also makes the AI SDK
          // carry encrypted reasoning content across tool-loop steps.
          store: false,
          ...(openai.instructions !== undefined
            ? {}
            : this.defaults.instructions === undefined
              ? {}
              : { instructions: this.defaults.instructions }),
          ...(openai.parallelToolCalls !== undefined
            ? {}
            : { parallelToolCalls: this.defaults.parallelToolCalls ?? true }),
        },
      },
    };
  }
}

/**
 * Creates an AI SDK 7 Provider V4 backed by the ChatGPT Codex endpoint.
 *
 * Language requests always use the Responses API. Other Provider V4 surfaces
 * are delegated to the AI SDK OpenAI provider at the same Codex base URL; their
 * availability is determined by the signed-in ChatGPT plan and backend.
 */
export function createOpenAIOAuthProvider(
  options: OpenAIOAuthProviderOptions = {},
): OpenAIOAuthProvider {
  const auth = options.auth ?? new OpenAIOAuth(options.authOptions);
  const baseURL = options.baseURL ?? CHATGPT_CODEX_BASE_URL;
  const authenticatedFetch = createAuthenticatedFetch(auth, {
    allowedOrigins: [baseURL],
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    originator: options.originator ?? DEFAULT_ORIGINATOR,
  });
  const delegate = createOpenAI({
    apiKey: 'managed-by-openai-oauth',
    baseURL,
    fetch: authenticatedFetch,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    name: 'openai-oauth',
  });

  const createLanguageModel = (modelId: string) =>
    new CodexLanguageModel(delegate.responses(modelId), {
      instructions:
        options.modelDefaults?.instructions ?? 'You are a helpful assistant.',
      parallelToolCalls: options.modelDefaults?.parallelToolCalls ?? true,
    });
  const provider = (modelId: string) => createLanguageModel(modelId);

  provider.specificationVersion = 'v4' as const;
  provider.auth = auth;
  provider.languageModel = createLanguageModel;
  provider.responses = createLanguageModel;
  provider.embedding = (modelId: string) => delegate.embedding(modelId);
  provider.embeddingModel = (modelId: string) =>
    delegate.embeddingModel(modelId);
  provider.image = (modelId: string) => delegate.image(modelId);
  provider.imageModel = (modelId: string) => delegate.imageModel(modelId);
  provider.transcription = (modelId: string) => delegate.transcription(modelId);
  provider.transcriptionModel = (modelId: string) =>
    delegate.transcription(modelId);
  provider.speech = (modelId: string) => delegate.speech(modelId);
  provider.speechModel = (modelId: string) => delegate.speech(modelId);
  provider.rerankingModel = ((_modelId: string): RerankingModelV4 => {
    throw new Error(
      'The ChatGPT Codex backend does not expose a reranking model.',
    );
  }) as (modelId: string) => RerankingModelV4;
  provider.files = () => delegate.files();
  provider.skills = () => delegate.skills();
  provider.tools = delegate.tools;

  return provider as OpenAIOAuthProvider;
}
