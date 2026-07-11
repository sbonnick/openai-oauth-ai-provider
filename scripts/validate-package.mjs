import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), 'openai-oauth-package-'),
);

try {
  const { stdout } = await execute(
    'npm',
    ['pack', '--json', '--pack-destination', temporaryDirectory],
    { cwd: root },
  );
  const [packed] = JSON.parse(stdout);
  assert(packed, 'npm pack did not produce a package.');
  const paths = new Set(packed.files.map((file) => file.path));
  for (const requiredPath of [
    'LICENSE',
    'README.md',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/core.js',
    'dist/codex-client.js',
    'dist/codex-client.d.ts',
    'dist/ai-sdk.js',
    'dist/tanstack-provider.js',
    'src/index.ts',
  ]) {
    assert(
      paths.has(requiredPath),
      `Packed package is missing ${requiredPath}.`,
    );
  }
  assert(
    [...paths].every(
      (path) =>
        path === 'LICENSE' ||
        path === 'README.md' ||
        path === 'package.json' ||
        path.startsWith('dist/') ||
        path.startsWith('src/'),
    ),
    'Packed package contains an unexpected file.',
  );

  const consumerDirectory = join(temporaryDirectory, 'consumer');
  await mkdir(consumerDirectory);
  await writeFile(
    join(consumerDirectory, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  await execute(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-package-lock',
      join(temporaryDirectory, packed.filename),
    ],
    { cwd: consumerDirectory },
  );
  const manifest = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  );
  await writeFile(
    join(consumerDirectory, 'core.mjs'),
    [`${manifest.name}/core`, `${manifest.name}/codex`]
      .map((specifier) => `import ${JSON.stringify(specifier)};`)
      .join('\n'),
  );
  await execute('node', ['core.mjs'], { cwd: consumerDirectory });

  await execute(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-package-lock',
      ...Object.entries(manifest.peerDependencies).map(
        ([name, version]) => `${name}@${version}`,
      ),
    ],
    { cwd: consumerDirectory },
  );
  await writeFile(
    join(consumerDirectory, 'all.mjs'),
    [
      manifest.name,
      `${manifest.name}/codex`,
      `${manifest.name}/ai-sdk`,
      `${manifest.name}/tanstack`,
    ]
      .map((specifier) => `import ${JSON.stringify(specifier)};`)
      .join('\n'),
  );
  await execute('node', ['all.mjs'], { cwd: consumerDirectory });
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
