import {
  InvalidResponseDataError,
  type LanguageModelV4Content,
  type LanguageModelV4FinishReason,
  type LanguageModelV4GenerateResult,
  type LanguageModelV4ResponseMetadata,
  type LanguageModelV4StreamResult,
  type LanguageModelV4Usage,
  type SharedV4ProviderMetadata,
  type SharedV4Warning,
} from '@ai-sdk/provider';

interface BufferedContent {
  providerMetadata?: SharedV4ProviderMetadata;
  text: string;
  type: 'reasoning' | 'text';
}

function setProviderMetadata(
  target: BufferedContent,
  providerMetadata: SharedV4ProviderMetadata | undefined,
): void {
  if (providerMetadata !== undefined) {
    target.providerMetadata = providerMetadata;
  }
}

function streamError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new InvalidResponseDataError({
        data: error,
        message: 'The Codex Responses stream returned an error.',
      });
}

/** Collects a Provider V4 stream into the shape expected from `doGenerate`. */
export async function collectLanguageModelStream(
  result: LanguageModelV4StreamResult,
): Promise<LanguageModelV4GenerateResult> {
  const content: LanguageModelV4Content[] = [];
  const buffered = new Map<string, BufferedContent>();
  const responseMetadata: LanguageModelV4ResponseMetadata = {};
  let finishReason: LanguageModelV4FinishReason | undefined;
  let providerMetadata: SharedV4ProviderMetadata | undefined;
  let usage: LanguageModelV4Usage | undefined;
  let warnings: SharedV4Warning[] = [];

  const reader = result.stream.getReader();
  try {
    while (true) {
      const { done, value: part } = await reader.read();
      if (done) break;
      switch (part.type) {
        case 'stream-start':
          warnings = part.warnings;
          break;
        case 'response-metadata':
          if (part.id !== undefined) responseMetadata.id = part.id;
          if (part.modelId !== undefined)
            responseMetadata.modelId = part.modelId;
          if (part.timestamp !== undefined)
            responseMetadata.timestamp = part.timestamp;
          break;
        case 'text-start':
        case 'reasoning-start': {
          const item: BufferedContent = {
            text: '',
            type: part.type === 'text-start' ? 'text' : 'reasoning',
            ...(part.providerMetadata === undefined
              ? {}
              : { providerMetadata: part.providerMetadata }),
          };
          buffered.set(part.id, item);
          content.push(item);
          break;
        }
        case 'text-delta':
        case 'reasoning-delta': {
          let item = buffered.get(part.id);
          if (item === undefined) {
            item = {
              text: '',
              type: part.type === 'text-delta' ? 'text' : 'reasoning',
            };
            buffered.set(part.id, item);
            content.push(item);
          }
          item.text += part.delta;
          setProviderMetadata(item, part.providerMetadata);
          break;
        }
        case 'text-end':
        case 'reasoning-end': {
          const item = buffered.get(part.id);
          if (item !== undefined) {
            setProviderMetadata(item, part.providerMetadata);
          }
          break;
        }
        case 'custom':
        case 'file':
        case 'reasoning-file':
        case 'source':
        case 'tool-approval-request':
        case 'tool-call':
        case 'tool-result':
          content.push(part);
          break;
        case 'finish':
          finishReason = part.finishReason;
          providerMetadata = part.providerMetadata;
          usage = part.usage;
          break;
        case 'error':
          throw streamError(part.error);
        case 'raw':
        case 'tool-input-start':
        case 'tool-input-delta':
        case 'tool-input-end':
          break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (finishReason === undefined || usage === undefined) {
    throw new InvalidResponseDataError({
      data: { finishReason, usage },
      message: 'The Codex Responses stream ended without a finish event.',
    });
  }

  return {
    content,
    finishReason,
    usage,
    warnings,
    ...(providerMetadata === undefined ? {} : { providerMetadata }),
    ...(result.request === undefined ? {} : { request: result.request }),
    response: {
      ...responseMetadata,
      ...(result.response?.headers === undefined
        ? {}
        : { headers: result.response.headers }),
    },
  };
}
