import { FileTokenStore, OpenAIOAuth } from '../src/core.js';

const auth = new OpenAIOAuth({
  tokenStore: new FileTokenStore(),
});

const tokens = await auth.loginWithDeviceCode({
  onVerification({ userCode, verificationUrl }) {
    console.log(`Open ${verificationUrl}`);
    console.log(`Enter code: ${userCode}`);
    console.log('Waiting for authentication...');
  },
});

console.log(
  `Authenticated${tokens.planType ? ` with ChatGPT ${tokens.planType}` : ''}.`,
);
