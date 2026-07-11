import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chat } from '@tanstack/ai';
import { z } from 'zod';
import {
  MemoryTokenStore,
  OpenAIOAuth,
  openaiOAuthText,
} from '../src/tanstack-provider.js';
import { tokens } from './helpers.js';

function completedResponse(text: string) {
  return {
    id: 'resp-tanstack',
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
        id: 'msg-tanstack',
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
      input_tokens: 8,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 4,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 12,
    },
    metadata: {},
  };
}

function responseStream(text: string): Response {
  const response = completedResponse(text);
  const events = [
    {
      type: 'response.created',
      response: { ...response, status: 'in_progress', output: [], usage: null },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: 'msg-tanstack',
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    },
    {
      type: 'response.content_part.added',
      item_id: 'msg-tanstack',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: 'msg-tanstack',
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: 'response.output_text.done',
      item_id: 'msg-tanstack',
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: response.output[0],
    },
    { type: 'response.completed', response },
  ];
  const body = `${events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('')}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('TanStack AI adapter integration', () => {
  it('streams AG-UI text through chat() with OAuth Codex defaults', async () => {
    const authTokens = tokens();
    let requestBody: Record<string, unknown> | undefined;
    const fetchMock: typeof fetch = async (input, init) => {
      assert.equal(
        String(input),
        'https://chatgpt.com/backend-api/codex/responses',
      );
      const headers = new Headers(init?.headers);
      assert.equal(
        headers.get('authorization'),
        `Bearer ${authTokens.accessToken}`,
      );
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return responseStream('TanStack AI works');
    };
    const adapter = openaiOAuthText('gpt-5.4', {
      auth: new OpenAIOAuth({
        fetch: fetchMock,
        tokenStore: new MemoryTokenStore(authTokens),
      }),
      fetch: fetchMock,
    });

    let text = '';
    let finished = false;
    for await (const chunk of chat({
      adapter,
      messages: [{ role: 'user', content: 'Prove TanStack works.' }],
    })) {
      if (chunk.type === 'TEXT_MESSAGE_CONTENT') text += chunk.delta;
      if (chunk.type === 'RUN_FINISHED') finished = true;
    }

    assert.equal(text, 'TanStack AI works');
    assert.equal(finished, true);
    assert.equal(requestBody?.stream, true);
    assert.equal(requestBody?.store, false);
    assert.equal(requestBody?.parallel_tool_calls, true);
    assert.deepEqual(requestBody?.include, ['reasoning.encrypted_content']);
  });

  it('collects stream-only structured output for promise-style chat()', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const authTokens = tokens();
    const fetchMock: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return responseStream('{"name":"Ada Lovelace","age":36}');
    };
    const adapter = openaiOAuthText('gpt-5.4', {
      auth: new OpenAIOAuth({
        fetch: fetchMock,
        tokenStore: new MemoryTokenStore(authTokens),
      }),
      fetch: fetchMock,
    });

    const result = await chat({
      adapter,
      messages: [{ role: 'user', content: 'Ada Lovelace was 36.' }],
      outputSchema: z.object({ name: z.string(), age: z.number() }),
    });

    assert.deepEqual(result, { name: 'Ada Lovelace', age: 36 });
    assert.equal(requestBody?.stream, true);
    assert.equal(requestBody?.store, false);
    const text = requestBody?.text as
      | { format?: { type?: string } }
      | undefined;
    assert.equal(text?.format?.type, 'json_schema');
  });
});
