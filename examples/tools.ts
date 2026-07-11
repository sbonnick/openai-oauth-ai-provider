import { generateText, isStepCount, jsonSchema, tool } from 'ai';
import { createOpenAIOAuthProvider } from '../src/ai-sdk.js';

const codex = createOpenAIOAuthProvider();
if (!(await codex.auth.isAuthenticated())) {
  throw new Error('Run `npm run example:login` first.');
}

const result = await generateText({
  model: codex(process.env.CODEX_MODEL ?? 'gpt-5.4'),
  prompt: 'Use the add tool to calculate 19 + 23, then give only the result.',
  stopWhen: isStepCount(3),
  tools: {
    add: tool({
      description: 'Add two numbers.',
      inputSchema: jsonSchema<{ a: number; b: number }>({
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
        additionalProperties: false,
      }),
      execute: async ({ a, b }) => ({ result: a + b }),
    }),
  },
});

console.log(result.text);
