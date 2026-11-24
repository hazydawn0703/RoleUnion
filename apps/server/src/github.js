import { App, Octokit } from 'octokit';
import { HttpError, requireThat } from './http.js';

const accessError = () => new HttpError(503, '无法读取 GitHub 仓库。请检查 GitHub App 的仓库授权，然后重试。');
export const usableSource = file => file.type === 'blob' && ['100644', '100755'].includes(file.mode)
  && file.size <= 96_000 && /\.(?:[cm]?[jt]sx?|vue|svelte|py|rb|php|go|rs|java|kt|swift|cs|sql|graphql|proto|md|rst|html|css)$/i.test(file.path)
  && !/(^|\/)(?:\.|vendor\/|node_modules\/|dist\/)|(?:lock|min)\.[^.]+$/i.test(file.path);

export function createGitHub({ slug, ...config }) {
  const app = new App(config);
  return {
    installUrl: slug ? 'https://github.com/apps/' + encodeURIComponent(slug) + '/installations/new' : undefined,
    authorizationUrl(state, redirectUri) {
      return app.oauth.getWebFlowAuthorizationUrl({ state, redirectUrl: redirectUri }).url;
    },
    async signIn(code, redirectUri) {
      const { authentication } = await app.oauth.createToken({ code, redirectUrl: redirectUri });
      const client = new Octokit({ auth: authentication.token });
      const { data: user } = await client.rest.users.getAuthenticated();
      return { id: String(user.id), login: user.login, client };
    },
    async account(user, login) {
      try {
        const { data } = await user.client.rest.users.getByUsername({ username: login });
        requireThat(data.type === 'User', 422, '请选择个人 GitHub 账号。');
        return { id: String(data.id), login: data.login };
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(error.status === 404 ? 422 : 502, '无法确认该 GitHub 用户，请检查用户名或稍后重试。');
      }
    },
    async repositories(user) {
      try {
        const installations = await user.client.paginate('GET /user/installations');
        const lists = await Promise.all(installations.map(async installation => {
          const repositories = await user.client.paginate('GET /user/installations/{installation_id}/repositories', {
            installation_id: installation.id,
          });
          return repositories.filter(repo => repo.permissions?.admin === true).map(repo => ({
            id: repo.id, name: repo.full_name, branch: repo.default_branch, installation: installation.id,
          }));
        }));
        return lists.flat();
      } catch {
        throw new HttpError(502, '无法列出已授权的仓库，请重新登录或重试。');
      }
    },
    async open(repo, branch, pinnedSha) {
      try {
        const authentication = await app.octokit.auth({
          type: 'installation', installationId: repo.installation,
          repositoryIds: [repo.id], permissions: { contents: 'read' },
        });
        const client = new Octokit({ auth: authentication.token });
        const [owner, name] = repo.name.split('/');
        const options = { owner, repo: name };
        const metadata = await client.rest.repos.get({ ...options, request: { signal: AbortSignal.timeout(20_000) } });
        if (metadata.data.id !== repo.id) throw new Error('Repository identity changed');
        const { data: commit } = await client.rest.repos.getCommit({
          ...options, request: { signal: AbortSignal.timeout(20_000) }, ref: pinnedSha || branch,
        });
        const sha = commit.sha;
        return {
          sha,
          async files() {
            try {
              const { data } = await client.rest.git.getTree({
                owner, repo: name, tree_sha: commit.commit.tree.sha, recursive: 'true',
                request: { signal: AbortSignal.timeout(20_000) },
              });
              const source = data.tree.filter(usableSource).map(file => file.path);
              return { paths: source, truncated: Boolean(data.truncated) };
            } catch {
              throw accessError();
            }
          },
          async read(path) {
            let data;
            try {
              ({ data } = await client.rest.repos.getContent({
                owner, repo: name, path, ref: sha, request: { signal: AbortSignal.timeout(20_000) },
              }));
            } catch (error) {
              if (error.status === 404) throw new HttpError(422, '在所选提交中找不到文件：' + path);
              throw accessError();
            }
            requireThat(data.type === 'file' && data.encoding === 'base64' && data.size <= 96_000, 422, '请选择小于 96 KB 的文本文件。');
            const content = Buffer.from(data.content, 'base64').toString('utf8').replace(/\r\n/g, '\n');
            requireThat(!/[\u0000\uFFFD]/.test(content), 422, '仅支持 UTF-8 文本文件。');
            return content;
          },
        };
      } catch {
        throw accessError();
      }
    },
  };
}
