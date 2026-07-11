import { chat } from '@tanstack/ai';
import { openaiOAuthText } from '../src/tanstack-provider.js';

const adapter = openaiOAuthText(process.env.CODEX_MODEL ?? 'gpt-5.4');
if (!(await adapter.auth.isAuthenticated())) {
  await adapter.auth.loginWithDeviceCode({
    onVerification({ userCode, verificationUrl }) {
      console.log(`Open ${verificationUrl} and enter ${userCode}`);
    },
  });
}

const stream = chat({
  adapter,
  messages: [
    {
      role: 'user',
      content: 'Reply with exactly: TanStack AI works',
    },
  ],
});

for await (const chunk of stream) {
  if (chunk.type === 'TEXT_MESSAGE_CONTENT') {
    process.stdout.write(chunk.delta);
  }
}
process.stdout.write('\n');
