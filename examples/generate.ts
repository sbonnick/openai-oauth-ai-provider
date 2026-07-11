import { generateText, streamText } from 'ai';
import { createOpenAIOAuthProvider } from '../src/ai-sdk.js';

const codex = createOpenAIOAuthProvider();
if (!(await codex.auth.isAuthenticated())) {
  await codex.auth.loginWithDeviceCode({
    onVerification({ userCode, verificationUrl }) {
      console.log(`Open ${verificationUrl} and enter ${userCode}`);
    },
  });
}

const model = codex(process.env.CODEX_MODEL ?? 'gpt-5.4');
const generated = await generateText({
  model,
  prompt: 'Reply with exactly: AI SDK generateText works',
});
console.log(generated.text);

const streamed = streamText({
  model,
  prompt: 'Reply with exactly: AI SDK streamText works',
});
for await (const chunk of streamed.textStream) {
  process.stdout.write(chunk);
}
process.stdout.write('\n');
