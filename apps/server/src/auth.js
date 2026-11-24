import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { requireThat } from './http.js';

const lifetime = 8 * 3600;
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

export function createAuth({ secret, origin, studioPath, github }) {
  const users = new Map();
  const secure = new URL(origin).protocol === 'https:';
  const redirectUri = origin + studioPath + '/api/auth/callback';
  const sign = data => createHmac('sha256', secret).update(data).digest('base64url');

  function cookie(name, value, age) {
    return name + '=' + value + '; Path=' + studioPath + '/; HttpOnly; SameSite=Lax; Max-Age=' + age + (secure ? '; Secure' : '');
  }

  function issue(name, data, age) {
    const payload = encode({ ...data, expiresAt: Date.now() + age * 1000 });
    return cookie(name, payload + '.' + sign(payload), age);
  }

  function read(request, name) {
    const value = request.headers.cookie?.split('; ').find(item => item.startsWith(name + '='))?.slice(name.length + 1);
    const [payload, mac] = value?.split('.') || [];
    if (!payload || !mac || !/^[\w-]{43}$/.test(mac)) return null;
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(sign(payload)))) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return data.expiresAt > Date.now() ? data : null;
    } catch {
      return null;
    }
  }

  return {
    requireUser(request) {
      const session = read(request, 'roleunion_session');
      const user = session && users.get(session.id);
      requireThat(user && session.expiresAt > Date.now(), 401, '请登录 GitHub。');
      return user;
    },
    start(response) {
      const state = randomBytes(32).toString('base64url');
      response.writeHead(302, {
        location: github.authorizationUrl(state, redirectUri),
        'set-cookie': issue('roleunion_oauth', { state }, 600),
      }).end();
    },
    async finish(request, response, params) {
      const state = read(request, 'roleunion_oauth')?.state;
      requireThat(state && state === params.get('state') && params.get('code'), 400, 'GitHub 登录已失效，请重新开始。');
      const user = await github.signIn(params.get('code'), redirectUri);
      const id = randomBytes(32).toString('base64url');
      for (const [key, stored] of users) if (stored.expiresAt <= Date.now()) users.delete(key);
      users.set(id, { ...user, expiresAt: Date.now() + lifetime * 1000 });
      response.writeHead(303, {
        location: studioPath + '/',
        'set-cookie': [issue('roleunion_session', { id }, lifetime), cookie('roleunion_oauth', '', 0)],
      }).end();
    },
    logout(request, response) {
      users.delete(read(request, 'roleunion_session')?.id);
      response.writeHead(204, { 'set-cookie': cookie('roleunion_session', '', 0) }).end();
    },
  };
}
