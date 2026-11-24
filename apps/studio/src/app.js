import { api, badge, block, button, currentPath, el, field, heading, identity, muted, render, row, show, submit, textarea } from './ui.js';
import { openManager } from './pm.js';

const statuses = {
  queued: '等待判断', review: '等待产品经理确认', accepted: '已接纳', rejected: '未接纳',
};

async function openSubmission() {
  document.body.classList.add('submission-page');
  const path = currentPath;
  const info = await api(path);
  const storageKey = 'roleunion:' + path;
  let id = localStorage.getItem(storageKey);
  let conversation;

  async function update() {
    if (id) conversation = await api(path + '/conversations/' + id);
    view();
  }

  function view() {
    const messages = conversation?.messages || [];
    const active = messages.length > 0;
    const portrait = el('div', { className: 'portrait', 'aria-hidden': 'true' });
    const status = el('span', { role: 'status' });
    function expression(state, label) {
      portrait.dataset.state = state;
      status.textContent = label;
    }
    const ready = conversation?.submitted || conversation?.proposed.length;
    expression(ready ? 'happy' : 'listening', conversation?.submitted ? '收到你的需求了' : ready ? '请确认我的理解' : '我在听');
    const content = [
      el('header', { className: 'interview-header' }, el('h1', {}, info.name),
        portrait, el('div', { className: 'agent-caption' }, el('strong', {}, '小鲸'), status)),
      active && el('ol', { className: 'messages', 'aria-label': '对话记录', tabIndex: 0 },
        messages.map(message => el('li', { className: message.role },
          el('span', { className: 'visually-hidden' }, message.role === 'user' ? '你' : '小鲸'), el('p', {}, message.text)))),
    ].filter(Boolean);
    if (conversation?.submitted) {
      content.push(block(el('h2', {}, '需求已提交'),
        conversation.outcomes.map(outcome => el('div', { className: 'outcome' }, outcome.problem,
          badge(statuses[outcome.status], outcome.status))),
        row(button('刷新结果', update), button('提交另一项需求', () => {
          localStorage.removeItem(storageKey);
          id = null;
          conversation = null;
          view();
        }))));
    } else {
      if (conversation?.proposed.length) {
        content.push(block(el('h2', {}, '确认你的需求'),
          conversation.proposed.map(need => el('div', { className: 'need-summary' },
            identity('遇到的问题', need.problem), identity('使用场景', need.context), identity('期望结果', need.outcome))),
          row(button('确认并提交', async () => {
            await api(path + '/conversations/' + id + '/confirm', { proposalId: conversation.proposalId });
            await update();
            show('需求已提交。');
          }, 'primary')), muted('如有出入，请在下方继续说明。')));
      }
      const messageInput = textarea('message', '', {
        id: 'message', rows: active ? 1 : 3, maxLength: 4000,
        placeholder: active ? '继续输入消息…' : '说说你当时想做什么，以及实际发生了什么…',
        'aria-label': active ? '继续输入消息' : undefined,
      });
      const action = el('span', { className: 'action-label' }, active ? '发送' : '开始对话',
        el('span', { className: 'action-arrow', 'aria-hidden': 'true' }, active ? '↑' : '→'));
      const form = submit(action, async data => {
        expression('thinking', '正在梳理你的需求…');
        try {
          if (!id) {
            const result = await api(path + '/conversations', {});
            id = result.id;
            localStorage.setItem(storageKey, id);
          }
          await api(path + '/conversations/' + id + '/message', { message: data.get('message') });
          await update();
          document.querySelector('#message')?.focus({ preventScroll: true });
        } catch (error) {
          expression('listening', '发送未完成，可以重试');
          throw error;
        }
      }, active ? messageInput : field('你在哪个环节遇到了困难？', messageInput));
      content.push(el('section', { className: 'panel composer' }, form));
    }
    render(el('div', { className: active ? 'submission in-conversation' : 'submission' }, content));
    const transcript = document.querySelector('.messages');
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }

  try {
    await update();
  } catch (error) {
    if (error.status !== 404 || !id) throw error;
    localStorage.removeItem(storageKey);
    id = null;
    view();
  }
}

const start = currentPath.startsWith('/submit/') ? openSubmission : openManager;
start().catch(error => {
  render(heading('暂时无法打开', error.message), el('a', { href: location.pathname }, '重新加载'));
});
