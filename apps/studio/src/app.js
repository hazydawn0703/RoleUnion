import { api, badge, block, button, currentPath, el, field, heading, identity, muted, render, row, show, submit, textarea } from './ui.js';
import { openManager } from './pm.js';

const statuses = {
  queued: '等待判断', review: '等待产品经理确认', accepted: '已接纳', rejected: '未接纳',
};

async function openSubmission() {
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
    const content = [
      heading(info.name, '告诉我们你在哪里遇到了困难，以及你希望完成什么。'),
      messages.length && el('ol', { className: 'messages', 'aria-label': '对话记录' },
        messages.map(message => el('li', { className: message.role },
          el('span', {}, message.role === 'user' ? '你' : 'RoleUnion'), el('p', {}, message.text)))),
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
      content.push(block(submit(messages.length ? '发送回复' : '开始对话', async data => {
        if (!id) {
          const result = await api(path + '/conversations', {});
          id = result.id;
          localStorage.setItem(storageKey, id);
        }
        await api(path + '/conversations/' + id + '/message', { message: data.get('message') });
        await update();
        document.querySelector('#message')?.focus();
      }, field(messages.length ? '补充说明' : '你想解决什么问题？',
        textarea('message', '', { id: 'message', maxLength: 4000 })))));
    }
    render(el('div', { className: 'submission' }, content));
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
