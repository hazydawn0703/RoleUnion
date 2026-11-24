import { execFile } from 'node:child_process';
import { link, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { HttpError, requireThat } from './http.js';
import { usableSource } from './github.js';

const exec = promisify(execFile);
const knownHosts = fileURLToPath(new URL('./github-known-hosts', import.meta.url));
const repositoryName = z.string().regex(/^[a-z\d][a-z\d-]{0,38}\/[a-z\d._-]{1,100}$/i)
  .refine(name => !['.', '..'].includes(name.split('/')[1]));
export const deployInput = z.object({ name: repositoryName, branch: z.string().trim().min(1).max(240) });
const shaPattern = /^[0-9a-f]{40}$/;
const sshArgs = ['-F', 'none', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
  '-o', 'StrictHostKeyChecking=yes', '-o', 'GlobalKnownHostsFile=none', '-o', 'HostKeyAlgorithms=ssh-ed25519',
  '-o', 'ConnectTimeout=12'];
const sshTarget = 'git@github.com';
const transportError = () => new HttpError(422, '仓库读取失败。请检查 Deploy key、仓库名称及基准分支，再试一次。');

export function createDeployKeys(dataDir) {
  function keyDir(id) {
    return resolve(dataDir, 'repository-keys', z.uuid().parse(id));
  }
  async function publicKey(id) {
    const dir = keyDir(id);
    await mkdir(dir, { mode: 0o700, recursive: true });
    const identity = join(dir, 'identity');
    // Publish the complete private key atomically, including across concurrent requests.
    const read = async () => (await exec('ssh-keygen', ['-y', '-P', '', '-f', identity])).stdout.trim();
    try { return await read(); } catch {
      const temp = await mkdtemp(join(dir, '.generate-'));
      try {
        const key = join(temp, 'identity');
        await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'RoleUnion ' + id, '-f', key]);
        try { await link(key, identity); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
      return read();
    }
  }
  async function open(repo, branch, pinnedSha) {
    const { name } = deployInput.parse({ name: repo.name, branch });
    const identity = join(keyDir(repo.projectId), 'identity');
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'ssh',
      ROLEUNION_KEY: identity, ROLEUNION_HOSTS: 'UserKnownHostsFile="' + knownHosts + '"', GIT_SSH_VARIANT: 'ssh',
      GIT_SSH_COMMAND: 'ssh ' + sshArgs.join(' ') + ' -i "$ROLEUNION_KEY" -o "$ROLEUNION_HOSTS"' };
    const run = async (program, args, cwd, maxBuffer = 8_000_000) => {
      try { return (await exec(program, args, { cwd, env, timeout: 90_000, maxBuffer, encoding: 'utf8' })).stdout; }
      catch { throw transportError(); }
    };
    // GitHub identifies a deploy key by owner/repo in its SSH greeting. A user key is insufficient.
    let greeting = '';
    try {
      await exec('ssh', [...sshArgs, '-i', identity, '-o', 'UserKnownHostsFile="' + knownHosts + '"', '-T', sshTarget],
        { env, timeout: 20_000 });
    } catch (error) {
      if (error.code === 1) greeting = (error.stdout + error.stderr).toLowerCase();
    }
    requireThat(greeting.includes('hi ' + name.toLowerCase() + '!'), 422, '请先让仓库管理员在指定仓库添加本项目的只读公钥。');
    const remote = sshTarget + ':' + name + '.git';
    // Ask for the write service's ref advertisement only. No ref updates or objects are sent.
    let readOnly = false;
    try {
      await exec('git', ['ls-remote', '--upload-pack=git-receive-pack', remote], { env, timeout: 20_000 });
    } catch (error) {
      readOnly = /marked as read only/i.test(error.stderr || '');
    }
    requireThat(readOnly, 422, '无法确认此密钥为只读。请在 GitHub 检查 Deploy key 的写权限。');
    await run('git', ['check-ref-format', 'refs/heads/' + branch]);
    const refs = await run('git', ['ls-remote', '--exit-code', '--heads', remote, 'refs/heads/' + branch]);
    const sha = pinnedSha ?? refs.trim().split('\t')[0];
    requireThat(shaPattern.test(sha), 422, '无法解析固定的代码版本。');
    let directory;
    let inventory;
    async function load() {
      directory = await mkdtemp(join(tmpdir(), 'roleunion-snapshot-'));
      await run('git', ['init', '--bare', '--quiet'], directory);
      await run('git', ['fetch', '--depth=1', '--no-tags', '--no-recurse-submodules', remote, sha], directory);
      const tree = await run('git', ['ls-tree', '-rlz', sha], directory);
      const files = new Map();
      for (const entry of tree.split('\0')) {
        const match = /^(100644|100755) blob ([0-9a-f]{40}) +([0-9]+)\t([\s\S]+)$/.exec(entry);
        if (match && Number(match[3]) <= 96_000) {
          files.set(match[4], { type: 'blob', mode: match[1], oid: match[2], size: Number(match[3]), path: match[4] });
        }
      }
      return files;
    }
    const files = () => inventory ??= load();
    return {
      sha,
      async files() {
        return { paths: [...(await files()).values()].filter(usableSource).map(file => file.path), truncated: false };
      },
      async read(path) {
        const file = (await files()).get(path);
        requireThat(file, 422, '请选择固定版本中小于 96 KB 的普通文件。');
        const content = await run('git', ['cat-file', 'blob', file.oid], directory, 100_000);
        requireThat(!/[\u0000\uFFFD]/.test(content), 422, '仅支持 UTF-8 文本文件。');
        return content.replace(/\r\n/g, '\n');
      },
      async close() {
        if (directory) await rm(directory, { recursive: true, force: true });
      },
    };
  }
  return { publicKey, open };
}
