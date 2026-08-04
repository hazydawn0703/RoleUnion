import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const expectedWorkspaces = [
  'apps/server',
  'apps/studio',
  'packages/core',
  'packages/examples',
  'packages/exporter',
  'packages/generators',
  'packages/rules',
  'packages/schema',
  'packages/storage',
];

const requiredPrivateIgnores = [
  'apps/site/',
  'apps/pro/',
  'apps/pro-*/',
  'apps/cloud/',
  'apps/cloud-*/',
  'apps/enterprise/',
  'apps/enterprise-*/',
  'packages/pro/',
  'packages/pro-*/',
  'packages/enterprise/',
  'packages/enterprise-*/',
  'templates/pro/',
  'templates/enterprise/',
  'commercial/',
  'enterprise/',
  'private/',
];

const privateWorkingTreePaths = [
  'apps/site',
  'apps/pro',
  'apps/cloud',
  'apps/enterprise',
  'packages/pro',
  'packages/enterprise',
  'templates/pro',
  'templates/enterprise',
  'commercial',
  'enterprise',
  'private',
];

function normalizePath(filePath) {
  return filePath.replaceAll('\\', '/');
}

function isWithin(filePath, prefix) {
  return filePath === prefix || filePath.startsWith(`${prefix}/`);
}

function isPrivatePath(filePath) {
  return [
    'apps/site',
    'apps/pro',
    'apps/cloud',
    'apps/enterprise',
    'packages/pro',
    'packages/enterprise',
    'templates/pro',
    'templates/enterprise',
    'commercial',
    'enterprise',
    'private',
  ].some((prefix) => isWithin(filePath, prefix))
    || /^apps\/(?:pro|cloud|enterprise)-/.test(filePath)
    || /^packages\/(?:pro|enterprise)-/.test(filePath);
}

const violations = [];

const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)
  .map(normalizePath);

for (const filePath of trackedFiles.filter(isPrivatePath)) {
  violations.push(`private path is tracked by the public repository: ${filePath}`);
}

const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const actualWorkspaces = Array.isArray(packageJson.workspaces) ? packageJson.workspaces : [];
const sortedActual = [...actualWorkspaces].sort();
const sortedExpected = [...expectedWorkspaces].sort();

if (actualWorkspaces.some((workspace) => workspace.includes('*'))) {
  violations.push('package.json workspaces must not use globs; list public workspaces explicitly');
}

if (JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)) {
  violations.push(
    `package.json public workspaces differ from the allowlist\n  expected: ${sortedExpected.join(', ')}\n  actual:   ${sortedActual.join(', ')}`,
  );
}

const gitignoreLines = new Set(
  readFileSync(resolve(repoRoot, '.gitignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#')),
);

for (const pattern of requiredPrivateIgnores) {
  if (!gitignoreLines.has(pattern)) {
    violations.push(`.gitignore is missing private-source safeguard: ${pattern}`);
  }
}

for (const relativePath of privateWorkingTreePaths) {
  if (!existsSync(resolve(repoRoot, relativePath))) continue;
  const ignored = spawnSync('git', ['check-ignore', '--quiet', '--', relativePath], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  if (ignored.status !== 0) {
    violations.push(`private working-tree path is not ignored: ${relativePath}`);
  }
}

if (violations.length > 0) {
  console.error('Open-source boundary check failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  `Open-source boundary check passed: ${trackedFiles.length} tracked files, ${expectedWorkspaces.length} explicit public workspaces.`,
);
