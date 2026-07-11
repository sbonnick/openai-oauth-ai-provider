import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateText, isStepCount, jsonSchema, streamText, tool } from 'ai';
import {
  createOpenAIOAuthProvider,
  MemoryTokenStore,
  OpenAIOAuth,
} from '../src/ai-sdk.js';
import { tokens } from './helpers.js';

function completedResponse(text: string) {
  return {
    id: 'resp-test',
    object: 'response',
    created_at: 1_700_000_000,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: 'gpt-5.4',
    output: [
      {
        id: 'msg-test',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    truncation: 'disabled',
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 4,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 14,
    },
    metadata: {},
  };
}

function sseResponse(events: unknown[]): Response {
  const body = `${events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('')}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function createdEvent(response: ReturnType<typeof completedResponse>) {
  return {
    type: 'response.created',
    response: { ...response, status: 'in_progress', output: [], usage: null },
  };
}

function textEvents(response: ReturnType<typeof completedResponse>) {
  const text = response.output[0]?.content[0]?.text ?? '';
  return [
    createdEvent(response),
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: 'msg-test',
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    },
    {
      type: 'response.content_part.added',
      item_id: 'msg-test',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: 'msg-test',
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: 'response.output_text.done',
      item_id: 'msg-test',
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: 'response.content_part.done',
      item_id: 'msg-test',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text, annotations: [] },
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: response.output[0],
    },
    { type: 'response.completed', response },
  ];
}

function functionCallEvents() {
  const functionCall = {
    id: 'function-test',
    type: 'function_call',
    status: 'completed',
    call_id: 'call-test',
    name: 'echo',
    arguments: '{"value":"provider works"}',
  };
  const response = { ...completedResponse(''), output: [functionCall] };
  return [
    createdEvent(completedResponse('')),
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...functionCall, arguments: '' },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: functionCall.id,
      output_index: 0,
      delta: functionCall.arguments,
    },
    {
      type: 'response.function_call_arguments.done',
      item_id: functionCall.id,
      output_index: 0,
      arguments: functionCall.arguments,
    },
    { type: 'response.output_item.done', output_index: 0, item: functionCall },
    { type: 'response.completed', response },
  ];
}

describe('AI SDK 7 provider integration', () => {
  it('works with generateText and maps function tools into Responses', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const authTokens = tokens();
    let apiCall = 0;
    let executedValue: string | undefined;
    const fetchMock: typeof fetch = async (input, init) => {
      assert.equal(
        String(input),
        'https://chatgpt.com/backend-api/codex/responses',
      );
      assert.equal(
        new Headers(init?.headers).get('authorization'),
        `Bearer ${authTokens.accessToken}`,
      );
      const requestBody = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      requestBodies.push(requestBody);
      assert.equal(requestBody.stream, true);
      apiCall += 1;
      if (apiCall === 1) {
        return sseResponse(functionCallEvents());
      }
      const response = completedResponse('provider works');
      return sseResponse(textEvents(response));
    };
    const auth = new OpenAIOAuth({
      fetch: fetchMock,
      tokenStore: new MemoryTokenStore(authTokens),
    });
    const provider = createOpenAIOAuthProvider({ auth, fetch: fetchMock });

    const result = await generateText({
      model: provider('gpt-5.4'),
      prompt: 'Say that the provider works.',
      stopWhen: isStepCount(2),
      tools: {
        echo: tool({
          description: 'Echo a string.',
          inputSchema: jsonSchema<{ value: string }>({
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          }),
          execute: async ({ value }) => {
            executedValue = value;
            return value;
          },
        }),
      },
    });

    assert.equal(result.text, 'provider works');
    assert.equal(executedValue, 'provider works');
    assert.equal(requestBodies.length, 2);
    const firstRequest = requestBodies[0];
    assert.equal(firstRequest?.store, false);
    assert.equal(firstRequest?.parallel_tool_calls, true);
    assert.equal(firstRequest?.instructions, 'You are a helpful assistant.');
    const requestTools = firstRequest?.tools as
      | Array<Record<string, unknown>>
      | undefined;
    assert.deepEqual(requestTools?.[0]?.name, 'echo');
    const secondInput = requestBodies[1]?.input as
      | Array<Record<string, unknown>>
      | undefined;
    assert.equal(
      secondInput?.some((item) => item.type === 'function_call_output'),
      true,
    );
  });

  it('works with streamText', async () => {
    const response = completedResponse('stream works');
    const fetchMock: typeof fetch = async () =>
      sseResponse(textEvents(response));
    const provider = createOpenAIOAuthProvider({
      auth: new OpenAIOAuth({
        fetch: fetchMock,
        tokenStore: new MemoryTokenStore(tokens()),
      }),
      fetch: fetchMock,
    });

    const result = streamText({
      model: provider('gpt-5.4'),
      prompt: 'Stream a response.',
    });

    assert.equal(await result.text, 'stream works');
  });

  it('exposes Provider V4 tools, files, and skills surfaces', () => {
    const provider = createOpenAIOAuthProvider({
      auth: new OpenAIOAuth({ tokenStore: new MemoryTokenStore(tokens()) }),
    });

    assert.equal(provider.specificationVersion, 'v4');
    assert.equal(provider.skills().specificationVersion, 'v4');
    assert.equal(provider.files().specificationVersion, 'v4');
    assert.equal(
      provider.tools.mcp({ serverLabel: 'test', serverUrl: 'https://mcp.test' })
        .type,
      'provider',
    );
    assert.equal(provider.tools.shell({}).type, 'provider');
  });
});
