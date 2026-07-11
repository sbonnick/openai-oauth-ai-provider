import { generateText } from 'ai';
import { createOpenAIOAuthProvider } from '../src/ai-sdk.js';

const serverUrl = process.env.MCP_SERVER_URL;
if (!serverUrl) {
  throw new Error('Set MCP_SERVER_URL to a streamable HTTP MCP server.');
}

const codex = createOpenAIOAuthProvider();
if (!(await codex.auth.isAuthenticated())) {
  throw new Error('Run `npm run example:login` first.');
}

const result = await generateText({
  model: codex(process.env.CODEX_MODEL ?? 'gpt-5.4'),
  prompt: 'Use the MCP server to describe one capability it exposes.',
  tools: {
    remoteMcp: codex.tools.mcp({
      serverLabel: 'example-mcp',
      serverUrl,
      requireApproval: 'never',
    }),
  },
});

console.log(result.text);
