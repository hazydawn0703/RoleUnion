import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';
import { FileStorage } from '../../../packages/storage/src/fileStorage.js';
import { createAnalysis } from './analysis.js';
import { createAuth } from './auth.js';
import { createGitHub } from './github.js';
import { HttpError, json, readJson, requireThat } from './http.js';
import { createModel } from './llmAccess.js';
import { createProjects } from './projects.js';

const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const projectAction = new RegExp('^/api/projects/(' + uuid + ')(?:/([a-z-]+))?$');
const publicAction = new RegExp('^/api/submit/(' + uuid + ')/(' + uuid + ')(?:/conversations(?:/(' + uuid + ')(?:/(message|confirm))?)?)?$');
const page = new RegExp('^/(?:projects/' + uuid + '|submit/' + uuid + '/' + uuid + ')?$');
const studioPath = '/apps/studio';
const studio = new URL('../../studio/', import.meta.url);
const assets = {
  '/app.js': ['text/javascript', new URL('src/app.js', studio)],
  '/pm.js': ['text/javascript', new URL('src/pm.js', studio)],
  '/ui.js': ['text/javascript', new URL('src/ui.js', studio)],
  '/styles.css': ['text/css', new URL('styles.css', studio)],
};

export function createRoleUnionServer({ origin, github, model, storage, sessionSecret }) {
  const auth = createAuth({ secret: sessionSecret, origin, studioPath, github });
  const projects = createProjects({ github, analysis: createAnalysis(model), storage });
  projects.resume();
  const publicPosts = new Map();
  const activeConversations = new Set();

  function limit(request) {
    const time = Date.now();
    for (const [ip, window] of publicPosts) if (window.until <= time) publicPosts.delete(ip);
    const ip = request.socket.remoteAddress;
    const window = publicPosts.get(ip) || { count: 0, until: time + 60_000 };
    requireThat(window.count < 40, 429, '提交过于频繁，请稍后再试。');
    window.count += 1;
    publicPosts.set(ip, window);
  }

  async function handlePublic(request, response, path, match) {
    const [, projectId, invite, conversationId, action] = match;
    if (request.method === 'GET') {
      if (conversationId && !action) return json(response, 200, projects.conversation(projectId, invite, conversationId));
      if (!conversationId && !path.endsWith('/conversations')) return json(response, 200, projects.publicInfo(projectId, invite));
    }
    requireThat(request.method === 'POST', 404, '找不到此操作。');
    limit(request);
    const key = z.uuid().parse(request.headers['idempotency-key']);
    const body = await readJson(request);
    requireThat(body && typeof body === 'object' && !Array.isArray(body), 400, '请求正文必须为对象。');
    if (path.endsWith('/conversations') && !conversationId) {
      return json(response, 201, await projects.start(projectId, invite, key));
    }
    requireThat(conversationId && action, 404, '找不到此操作。');
    requireThat(!activeConversations.has(conversationId), 409, '正在处理这段对话，请稍后再试。');
    activeConversations.add(conversationId);
    try {
      const result = action === 'message'
        ? await projects.message(projectId, invite, conversationId, body, key)
        : await projects.submit(projectId, invite, conversationId, body, key);
      return json(response, 200, result);
    } finally {
      activeConversations.delete(conversationId);
    }
  }

  return createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('content-security-policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(request.url, origin);
      const method = request.method;
      if (method === 'GET' && ['/', studioPath].includes(url.pathname)) {
        response.writeHead(308, { location: studioPath + '/' }).end();
        return;
      }
      requireThat(url.pathname.startsWith(studioPath + '/'), 404, '找不到此页面。');
      const path = url.pathname.slice(studioPath.length);
      if (method === 'POST') requireThat(request.headers.origin === origin, 403, '请求来源无效。');
      if (method === 'GET' && path === '/api/health') return json(response, 200, { status: 'ok' });
      if (method === 'GET' && path === '/api/auth/login') {
        const projectId = z.uuid().safeParse(url.searchParams.get('project'));
        return auth.start(response, projectId.success ? projectId.data : null);
      }
      if (method === 'GET' && path === '/api/auth/callback') return await auth.finish(request, response, url.searchParams);
      if (method === 'POST' && path === '/api/auth/logout') return auth.logout(request, response);
      const publicMatch = path.match(publicAction);
      if (publicMatch) return await handlePublic(request, response, path, publicMatch);
      const asset = Object.hasOwn(assets, path) && assets[path];
      if (method === 'GET' && (asset || page.test(path))) {
        const [type, file] = asset || ['text/html', new URL('index.html', studio)];
        response.writeHead(200, { 'content-type': type + '; charset=utf-8' }).end(readFileSync(file));
        return;
      }

      if (!path.startsWith('/api/')) throw new HttpError(404, '找不到此页面。');
      const user = auth.requireUser(request);
      if (method === 'GET' && path === '/api/session') return json(response, 200, { login: user.login, installUrl: github.installUrl });
      if (method === 'GET' && path === '/api/repositories') return json(response, 200, await github.repositories(user));
      if (method === 'GET' && path === '/api/projects') return json(response, 200, projects.list(user));
      const match = path.match(projectAction);
      if (method === 'GET' && match && !match[2]) return json(response, 200, projects.get(user, match[1]));
      if (method === 'POST' && (path === '/api/projects' || match?.[2])) {
        const key = z.uuid().parse(request.headers['idempotency-key']);
        const body = await readJson(request);
        requireThat(body && typeof body === 'object' && !Array.isArray(body), 400, '请求正文必须为对象。');
        const result = match
          ? await projects.action(user, match[1], match[2], body, key)
          : await projects.create(user, body, key);
        return json(response, 200, result);
      }
      throw new HttpError(404, '找不到此操作。');
    } catch (error) {
      if (response.headersSent) return response.end();
      if (error instanceof HttpError) return json(response, error.status, { error: error.message });
      if (error instanceof z.ZodError) {
        const fields = [...new Set(error.issues.map(issue => issue.path.join('.')).filter(Boolean))];
        return json(response, 422, { error: '提交的数据不完整或格式有误。' + fields.join('、') });
      }
      console.error('Request failed:', error.name, error.code || '');
      json(response, 500, { error: '服务暂时无法处理请求，请重试。' });
    }
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const env = process.env;
  const port = Number(env.ROLEUNION_PORT || 8787);
  const host = env.ROLEUNION_HOST || '127.0.0.1';
  const origin = new URL(env.ROLEUNION_ORIGIN || 'http://localhost:' + port).origin;
  const needed = [
    'ROLEUNION_GITHUB_APP_ID', 'ROLEUNION_GITHUB_PRIVATE_KEY', 'ROLEUNION_GITHUB_CLIENT_ID',
    'ROLEUNION_GITHUB_CLIENT_SECRET', 'ROLEUNION_SESSION_SECRET', 'ROLEUNION_LLM_API_KEY', 'ROLEUNION_LLM_DEFAULT_MODEL',
  ];
  const missing = needed.filter(key => !env[key]);
  if (missing.length) throw new Error('Missing configuration: ' + missing.join(', '));
  if (env.ROLEUNION_SESSION_SECRET.length < 32) throw new Error('ROLEUNION_SESSION_SECRET must have at least 32 characters.');
  const github = createGitHub({
    slug: env.ROLEUNION_GITHUB_APP_SLUG,
    appId: env.ROLEUNION_GITHUB_APP_ID,
    privateKey: env.ROLEUNION_GITHUB_PRIVATE_KEY.replaceAll('\\n', '\n'),
    oauth: { clientId: env.ROLEUNION_GITHUB_CLIENT_ID, clientSecret: env.ROLEUNION_GITHUB_CLIENT_SECRET },
  });
  const model = createModel({
    baseUrl: env.ROLEUNION_LLM_BASE_URL,
    name: env.ROLEUNION_LLM_DEFAULT_MODEL,
    apiKey: env.ROLEUNION_LLM_API_KEY,
  });
  const dataDir = env.ROLEUNION_DATA_DIR || fileURLToPath(new URL('../../../data', import.meta.url));
  createRoleUnionServer({ origin, github, model, storage: new FileStorage(dataDir), sessionSecret: env.ROLEUNION_SESSION_SECRET })
    .listen(port, host, () => console.log('RoleUnion: ' + origin));
}
