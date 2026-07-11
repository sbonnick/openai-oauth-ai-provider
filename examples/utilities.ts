import { codex } from '../src/index.js';

const client = codex();
if (!(await client.auth.isAuthenticated())) {
  await client.auth.loginWithDeviceCode({
    onVerification({ userCode, verificationUrl }) {
      console.log(`Open ${verificationUrl} and enter ${userCode}`);
    },
  });
}

const [models, usage, accountStatus] = await Promise.all([
  client.listCodexModels(),
  client.getCodexUsage(),
  client.getCodexAccountStatus(),
]);

console.log('Models:');
for (const model of models) {
  console.log(`- ${model.slug}`);
}
console.log('Usage:', usage);
console.log('Account status:', accountStatus);
