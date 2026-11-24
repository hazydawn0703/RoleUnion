const pendingKeys = new Map();
export const studioPath = '/apps/studio';
export const currentPath = location.pathname.slice(studioPath.length);
export const root = document.querySelector('#app');
const notice = document.querySelector('#notice');
let noticeTimer;

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node && key !== 'role') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat(Infinity).filter(item => item != null && item !== false));
  return node;
}

export function show(message, error = false) {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.className = error ? 'visible error' : 'visible';
  noticeTimer = setTimeout(() => notice.className = '', error ? 10_000 : 4000);
}

export const button = (label, action, className = '') => el('button', {
  type: 'button', className, onclick: event => busy(event.currentTarget, action),
}, label);

async function busy(control, action) {
  if (control.disabled) return;
  control.disabled = true;
  control.setAttribute('aria-busy', 'true');
  try {
    await action();
  } catch (error) {
    show(error.message, true);
  } finally {
    control.disabled = false;
    control.removeAttribute('aria-busy');
  }
}

export function submit(label, handler, ...content) {
  const control = el('button', { type: 'submit', className: 'primary' }, label);
  return el('form', { onsubmit: event => {
    event.preventDefault();
    busy(control, () => handler(new FormData(event.currentTarget || control.form)));
  } }, content, control);
}

export const row = (...children) => el('div', { className: 'actions' }, children);
export const field = (label, control) => el('label', {}, el('span', {}, label), control);
export const input = (name, value = '', props = {}) => el('input', { name, value, required: true, ...props });
export const textarea = (name, value = '', props = {}) => el('textarea', { name, value, rows: 4, required: true, ...props });
export const muted = text => el('p', { className: 'muted' }, text);
export const block = (...children) => el('section', { className: 'panel' }, children);
export const details = (title, ...children) => el('details', {}, el('summary', {}, title), children);
export const badge = (label, tone = '') => el('span', { className: 'badge ' + tone }, label);
export const identity = (label, text) => el('div', { className: 'kv' }, el('span', {}, label), el('div', {}, text));
export const date = value => new Date(value).toLocaleString('zh-CN');

export async function api(path, body, explicitKey) {
  const content = body === undefined ? undefined : JSON.stringify(body);
  const id = path + '\n' + content;
  const key = explicitKey || pendingKeys.get(id) || crypto.randomUUID();
  if (content !== undefined) pendingKeys.set(id, key);
  const response = await fetch(studioPath + '/api' + path, content === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: content,
  });
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    if (response.status < 500 && response.status !== 409) pendingKeys.delete(id);
    throw Object.assign(new Error(result.error), { status: response.status });
  }
  pendingKeys.delete(id);
  return result;
}

export function render(...children) {
  root.replaceChildren(...children.flat().filter(child => child != null));
  root.removeAttribute('aria-busy');
}

export function heading(title, subtitle, actions) {
  return el('div', { className: 'page-heading' }, el('div', {}, el('h1', {}, title), subtitle && muted(subtitle)), actions);
}
