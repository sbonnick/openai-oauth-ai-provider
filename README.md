# openai-oauth-ai-provider

OpenAI OAuth authentication and AI-provider adapters for either:

- Vercel AI SDK 7 (`LanguageModelV4` / `ProviderV4`)
- TanStack AI (`TextAdapter` / AG-UI streams)

The package signs users in with the ChatGPT device-code flow used by the
open-source Codex CLI, automatically rotates OAuth tokens, and sends requests
to `https://chatgpt.com/backend-api/codex`.

The runtime uses Node built-ins plus the official provider implementation for
each SDK: `@ai-sdk/openai` and `@tanstack/ai-openai`.

This is an unofficial community project. It is not affiliated with or endorsed
by OpenAI, Vercel, or TanStack.

## Important status

The ChatGPT Codex backend is not the public OpenAI Platform API. This package
follows behavior visible in the open-source
[`openai/codex`](https://github.com/openai/codex) client, so endpoints and
payload requirements can change. Use it only with accounts and subscriptions
you are authorized to use, and follow applicable OpenAI terms and workspace
policies.

Prompts, messages, files, skills, tool inputs, and model configuration supplied
to an adapter are sent to the ChatGPT Codex backend. Remote MCP servers are a
separate trust boundary and may receive data selected by the model or your
application. Data retention, workspace controls, availability, quota, and
billing are controlled by those external services and your account policies.

Hosted capabilities such as remote MCP, uploaded skills, shell containers,
images, audio, and embeddings remain controlled by the signed-in ChatGPT plan
and backend. Client-side tools and client-side MCP do not depend on those
hosted capabilities.

## Requirements

- Node.js 22.18 or newer
- an ESM application (`import`; CommonJS `require` is not supported)
- a ChatGPT account with Codex access
- AI SDK 7 or TanStack AI 0.40+

## Installation

For AI SDK 7:

```sh
npm install openai-oauth-ai-provider ai @ai-sdk/provider @ai-sdk/openai
```

For TanStack AI:

```sh
npm install openai-oauth-ai-provider @tanstack/ai @tanstack/ai-openai zod
```

For this source checkout:

```sh
npm ci
npm run check
```

Use the adapter-specific entry point for applications that only use one SDK:

- `openai-oauth-ai-provider/ai-sdk` exports authentication plus the AI SDK
  provider without loading the TanStack adapter.
- `openai-oauth-ai-provider/tanstack` exports authentication plus the TanStack
  adapter without loading the AI SDK provider.
- `openai-oauth-ai-provider/core` exports only authentication, token stores, and
  shared utilities.

The root entry point continues to export everything for compatibility and for
applications that intentionally use both SDKs. Package managers still install
both official adapter dependencies; the subpaths isolate the runtime module
graph and give bundlers deterministic entry points.

## Device login

Authentication is shared by both adapters:

```ts
import { OpenAIOAuth } from 'openai-oauth-ai-provider/core';

const auth = new OpenAIOAuth();

await auth.loginWithDeviceCode({
  onVerification({ verificationUrl, userCode }) {
    console.log(`Open ${verificationUrl} and enter ${userCode}`);
  },
});
```

Credentials are stored separately from Codex CLI by default. This prevents two
processes from racing to rotate the same refresh token. Override the location
with `OPENAI_OAUTH_AUTH_FILE` or provide a custom `TokenStore`. The override
must be an absolute path; never place the token file inside a source repository
or synchronized folder.

Every request refreshes a token within five minutes of expiry. A `401` causes
one forced refresh and one retry. Concurrent refreshes in a process are
deduplicated.

Cancel an in-progress login with an `AbortSignal`, and remove persisted
credentials with `await auth.logout()`. If a refresh token is revoked or the
workspace changes, log out and complete device login again.

Run the included login example:

```sh
npm run example:login
```

## Vercel AI SDK 7

### Generate and stream text

```ts
import { generateText, streamText } from 'ai';
import { createOpenAIOAuthProvider } from 'openai-oauth-ai-provider/ai-sdk';

const openaiOAuth = createOpenAIOAuthProvider();
const model = openaiOAuth('gpt-5.4');

const generated = await generateText({
  model,
  prompt: 'Say hello in five words.',
});
console.log(generated.text);

const streamed = streamText({ model, prompt: 'Count to five.' });
for await (const text of streamed.textStream) {
  process.stdout.write(text);
}
```

The Codex Responses endpoint requires `stream: true`. The provider implements
AI SDK `doGenerate` by collecting the streaming transport into a normal
generation result, so both `generateText` and `streamText` work normally.

Run the example:

```sh
npm run example:generate
```

### AI SDK function tools

```ts
import { generateText, isStepCount, jsonSchema, tool } from 'ai';

const result = await generateText({
  model: openaiOAuth('gpt-5.4'),
  prompt: 'Use add to calculate 19 + 23.',
  stopWhen: isStepCount(3),
  tools: {
    add: tool({
      inputSchema: jsonSchema<{ a: number; b: number }>({
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
        additionalProperties: false,
      }),
      execute: async ({ a, b }) => ({ result: a + b }),
    }),
  },
});
```

Run the tool-loop example:

```sh
npm run example:tools
```

### Provider-executed MCP and skills

The AI SDK provider exposes the OpenAI Responses tools and Provider V4 files
and skills surfaces:

```ts
const result = await generateText({
  model: openaiOAuth('gpt-5.4'),
  prompt: 'Describe one capability exposed by the MCP server.',
  tools: {
    docs: openaiOAuth.tools.mcp({
      serverLabel: 'docs',
      serverUrl: 'https://example.com/mcp',
      requireApproval: 'never',
    }),
  },
});

const uploaded = await openaiOAuth.skills().uploadSkill({
  files: [
    {
      path: 'SKILL.md',
      data: new TextEncoder().encode('# Example skill'),
    },
  ],
});
```

Only disable MCP approval for a server you fully trust. Remote MCP tools can
receive conversation or tool data and can perform actions outside this
library's control.

## TanStack AI

### Streaming chat

```ts
import { chat } from '@tanstack/ai';
import { openaiOAuthText } from 'openai-oauth-ai-provider/tanstack';

const adapter = openaiOAuthText('gpt-5.4');

const stream = chat({
  adapter,
  messages: [{ role: 'user', content: 'Say hello in five words.' }],
});

for await (const chunk of stream) {
  if (chunk.type === 'TEXT_MESSAGE_CONTENT') {
    process.stdout.write(chunk.delta);
  }
}
```

Run the TanStack example:

```sh
npm run example:tanstack
```

The adapter uses TanStack's official OpenAI Responses implementation for AG-UI
lifecycle events, reasoning, tool calls, multimodal messages, and structured
outputs. It injects rotating OAuth credentials and enforces Codex defaults:

- `stream: true`
- `store: false`
- `parallel_tool_calls: true` unless overridden
- `reasoning.encrypted_content` inclusion for stateless tool loops

### TanStack server tools

```ts
import { chat, toolDefinition } from '@tanstack/ai';
import { z } from 'zod';
import { openaiOAuthText } from 'openai-oauth-ai-provider/tanstack';

const add = toolDefinition({
  name: 'add',
  description: 'Add two numbers.',
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  outputSchema: z.object({ result: z.number() }),
}).server(async ({ a, b }) => ({ result: a + b }));

const stream = chat({
  adapter: openaiOAuthText('gpt-5.4'),
  messages: [{ role: 'user', content: 'Use add to calculate 19 + 23.' }],
  tools: [add],
});
```

### TanStack structured output

```ts
import { chat } from '@tanstack/ai';
import { z } from 'zod';

const person = await chat({
  adapter: openaiOAuthText('gpt-5.4'),
  messages: [{ role: 'user', content: 'Ada Lovelace was 36.' }],
  outputSchema: z.object({
    name: z.string(),
    age: z.number(),
  }),
});
```

The custom adapter collects TanStack's streaming structured-output completion
when a non-streaming result is requested, because the Codex endpoint rejects
`stream: false`.

## Sharing one authenticated session

Applications using both SDKs can share one token manager:

```ts
import {
  OpenAIOAuth,
  createOpenAIOAuthProvider,
  openaiOAuthText,
} from 'openai-oauth-ai-provider';

const auth = new OpenAIOAuth();

const aiSdkProvider = createOpenAIOAuthProvider({ auth });
const tanstackAdapter = openaiOAuthText('gpt-5.4', { auth });
```

## Upstream references

The implementation follows:

- [`openai/codex` device authentication](https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs)
- [`openai/codex` token refresh](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs)
- [`openai/codex` ChatGPT Codex base URL](https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs)
- [`vercel/ai` Provider V4](https://github.com/vercel/ai/blob/main/packages/provider/src/provider/v4/provider-v4.ts)
- [`TanStack/ai` text adapter contract](https://github.com/TanStack/ai/blob/main/packages/ai/src/activities/chat/adapter.ts)
- [`TanStack/ai` OpenAI Responses adapter](https://github.com/TanStack/ai/blob/main/packages/openai-base/src/adapters/responses-text.ts)

## Security notes

- Treat the token file like a password. The file store requests user-only
  permissions where supported by the operating system. Windows users must also
  rely on the ACLs protecting their profile directory.
- OAuth JWTs are decoded only for routing and expiry claims. Decoding is not
  signature verification and is not used to authorize arbitrary issuers.
- Refresh tokens are never included in model requests.
- Caller-supplied authorization, ChatGPT account, and FedRAMP routing headers
  are overwritten from the active authenticated session.
- Authenticated requests are restricted to their configured HTTPS origin and
  reject redirects to avoid forwarding credentials to another service.

Report suspected vulnerabilities privately as described in
[`SECURITY.md`](SECURITY.md). Never include a live token or token file in an
issue, log, or security report.

## Releases and compatibility

This project follows Semantic Versioning for its public TypeScript API. The
private backend can still change without notice; compatibility fixes that
restore intended behavior may be released as patches. Releases are built from
protected `v<version>` tags, tested as packed consumer artifacts, and published
with npm provenance. See [`CHANGELOG.md`](CHANGELOG.md) for user-visible
changes.

## Contributing and support

See [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request and
[`SUPPORT.md`](SUPPORT.md) for the supported scope. Participation is governed
by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
