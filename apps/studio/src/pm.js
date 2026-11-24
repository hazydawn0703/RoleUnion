import { api, badge, block, button, currentPath, date, details, el, field, heading, identity, input, muted, render, row, show, studioPath, submit, textarea } from './ui.js';

const fit = { accepted: '符合规划', rejected: '已拒绝', review: '待产品经理裁定' };
const prdStatus = { accepted: '已采纳', rejected: '已拒绝', returned: '已退回' };
const sections = {
  title: '标题', problem: '用户问题', userScenarios: '适用场景', currentBehavior: '当前行为',
  desiredBehavior: '目标行为', scope: '改动范围', acceptance: '验收条件', openQuestions: '待核实与取舍',
};

function sourceEditor(sources = [{ type: 'repository', path: '' }]) {
  const list = el('div', { className: 'source-list' });
  function add(source) {
    const type = el('select', { 'aria-label': '规划来源' }, ...[
      ['repository', 'GitHub 文件'], ['inline', '项目内录入'],
    ].map(([value, label]) => el('option', { value, selected: value === source.type }, label)));
    const inputs = el('div');
    function fields() {
      inputs.replaceChildren(...(type.value === 'repository'
        ? [field('仓库内文件路径', input('path', source.path || '', { placeholder: 'docs/roadmap.md' }))]
        : [field('规划名称', input('title', source.title || '')),
          field('规划正文', textarea('plan', source.text || '', { maxLength: 24_000 }))]));
    }
    type.addEventListener('change', fields);
    const entry = el('div', { className: 'source' }, row(type,
      button('移除', () => {
        if (list.children.length > 1) entry.remove();
        else show('至少需要一份有效的产品规划。', true);
      })), inputs);
    fields();
    list.append(entry);
  }
  sources.forEach(add);
  return {
    controls: el('fieldset', {}, el('legend', {}, '判断需求方向的依据'), list, button('添加规划来源', () => {
      if (list.children.length < 5) add({ type: 'repository' });
      else show('最多添加五份规划。', true);
    })),
    read: () => [...list.children].map(item => item.querySelector('select').value === 'repository'
      ? { type: 'repository', path: item.querySelector('[name=path]').value }
      : { type: 'inline', title: item.querySelector('[name=title]').value, text: item.querySelector('[name=plan]').value }),
  };
}

async function home() {
  const projects = await api('/projects');
  const create = block(el('h2', {}, '接入 GitHub 仓库'));
  async function loadRepositories() {
    const repos = await api('/repositories');
    if (!repos.length) {
      create.replaceChildren(el('h2', {}, '接入 GitHub 仓库'),
        muted('安装 RoleUnion GitHub App，并授权要分析的仓库。安装后返回此页刷新。'),
        row(installLink, button('刷新已授权仓库', loadRepositories)));
      return;
    }
    const repo = el('select', { name: 'repo', required: true }, repos.map((item, index) =>
      el('option', { value: String(index) }, item.name)));
    const branch = input('branch', repos[0].branch, { maxLength: 240 });
    repo.addEventListener('change', () => branch.value = repos[Number(repo.value)].branch);
    const plans = sourceEditor();
    create.replaceChildren(el('h2', {}, '接入 GitHub 仓库'),
      submit('创建项目', async data => {
        const repository = repos[Number(data.get('repo'))];
        const result = await api('/projects', { name: data.get('name'), repoId: repository.id,
          installation: repository.installation, branch: data.get('branch'), sources: plans.read() });
        location.assign(studioPath + '/projects/' + result.id);
      },
      el('div', { className: 'form-grid' }, field('项目名称', input('name', '', { maxLength: 240 })),
        field('GitHub 仓库', repo), field('基准分支', branch)), plans.controls));
  }
  const settings = await api('/session');
  const installLink = settings.installUrl
    ? el('a', { href: settings.installUrl, target: '_blank', rel: 'noreferrer' }, '安装 GitHub App')
    : null;
  create.append(muted('选择已授权的仓库并指定产品规划。'),
    row(button('加载已授权仓库', loadRepositories, 'primary'), installLink));
  render(heading('项目', '从用户原始需求生成有依据、可评审的 PRD。'), el('div', { className: 'home-grid' },
    block(el('h2', {}, '已接入项目'), projects.length ? projects.map(project =>
      el('a', { className: 'project-card', href: studioPath + '/projects/' + project.id },
        el('strong', {}, project.name), muted(project.repo))) : muted('创建首个项目后，便可邀请用户提交需求。')), create));
}

function codeLink(project, sha, ref) {
  return 'https://github.com/' + project.repo.name.split('/').map(encodeURIComponent).join('/')
    + '/blob/' + sha + '/' + ref.path.split('/').map(encodeURIComponent).join('/')
    + '#L' + ref.start + '-L' + ref.end;
}

function codeEvidence(project, sha, refs) {
  return refs.map(ref => details(ref.path + ' · ' + ref.start + '–' + ref.end,
    el('a', { href: codeLink(project, sha, ref), target: '_blank', rel: 'noreferrer' }, '在 GitHub 打开固定版本'),
    el('pre', {}, ref.excerpt)));
}

function planEvidence(project, decision) {
  const sources = project.plans.find(plan => plan.id === decision?.planId)?.sources || [];
  return (decision?.evidence || []).map(ref => {
    const source = sources[ref.index];
    if (!source) return null;
    return el('blockquote', {}, ref.quote,
      el('footer', {}, source.type === 'repository'
        ? el('a', { target: '_blank', rel: 'noreferrer',
          href: codeLink(project, source.sha, { path: source.path, start: 1, end: 1 }).split('#')[0] }, source.path)
        : source.title));
  });
}

function exportVersion(project, version) {
  const markdown = Object.entries(sections).map(([key, label]) =>
    (key === 'title' ? '# ' + version.sections[key] : '## ' + label + '\n\n' + (version.sections[key] || '无'))).join('\n\n');
  const evidence = version.context.parts.map(item => {
    const sources = project.plans.find(plan => plan.id === item.planning.planId).sources;
    const plans = item.planning.evidence.map(ref => {
      const source = sources[ref.index];
      const label = source.path || source.title;
      const location = source.sha
        ? '[' + label + '](' + codeLink(project, source.sha, { path: source.path, start: 1, end: 1 }).split('#')[0] + ')'
        : label;
      return '- 规划 ' + location + ' · ' + ref.quote.replaceAll('\n', '\n  ');
    });
    return [
      '### ' + item.part.title,
      ...item.raw.map(quote => '> ' + quote.replaceAll('\n', '\n> ')),
      '- 规划裁定 · ' + item.planning.reason.replaceAll('\n', '\n  '),
      ...plans,
      ...item.part.references.map(ref => '- [' + ref.path + ':' + ref.start + '](' + codeLink(project, version.context.sha, ref) + ')'),
    ].join('\n');
  }).join('\n\n');
  const url = URL.createObjectURL(new Blob([markdown + '\n\n## 需求与依据\n\n' + evidence + '\n'], { type: 'text/markdown;charset=utf-8' }));
  const download = el('a', { href: url, download: 'roleunion-prd-' + version.id.slice(0, 8) + '.md' });
  download.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function openProject(path) {
  let project;
  let tab = 'needs';
  let activeDraft;
  let versionId;
  const selection = new Set();

  async function update(nextTab = tab) {
    project = await api(path);
    tab = nextTab;
    view();
  }

  async function action(command, body, nextTab = tab) {
    const result = await api(path + '/' + command, body);
    if (command === 'draft') {
      activeDraft = result.id;
      versionId = null;
    }
    await update(nextTab);
    return result;
  }

  function needCard(need) {
    const decision = need.decisions.at(-1);
    const active = decision?.planId === project.planId ? decision : null;
    const analysis = need.analysis;
    const currentAnalysis = analysis && analysis.sha === project.sha && analysis.decisionId === active?.id;
    const conversation = project.conversations.find(item => item.id === need.conversationId);
    const running = need.work?.status === 'queued';
    const failed = need.work?.status === 'failed';
    const status = active ? fit[active.verdict] : running ? '正在判断' : decision ? '规划已更新' : '等待判断';
    return block(el('div', { className: 'card-heading' }, el('h2', {}, need.problem), badge(status, active?.verdict || 'review')),
      el('div', { className: 'form-grid' }, identity('使用场景', need.context), identity('期望结果', need.outcome)),
      details('用户原话和对话', ...need.quotes.map(quote => el('blockquote', {}, quote)),
        ...conversation.messages.map(message => identity(message.role === 'user' ? '用户' : 'RoleUnion', message.text))),
      decision && details('规划判断与历史', ...need.decisions.map(item => el('div', { className: 'evidence' },
        row(badge(fit[item.verdict], item.verdict), muted(date(item.at) + ' · ' + (item.by === 'model' ? '系统' : '产品经理'))),
        el('p', {}, item.reason), planEvidence(project, item)))),
      active?.verdict === 'review' && submit('保存裁定', data => action('decide-fit', {
        needId: need.id, decisionId: active.id, verdict: data.get('verdict'), reason: data.get('reason'),
      }), el('p', {}, active.reason), planEvidence(project, active),
      field('裁定结果', el('select', { name: 'verdict' }, el('option', { value: 'accepted' }, '符合规划'),
        el('option', { value: 'rejected' }, '拒绝'))), field('理由', textarea('reason', '', { rows: 2 }))),
      failed && el('p', { className: 'error-text' }, need.work.error),
      running && muted('正在处理，可刷新查看结果。'),
      !running && (failed || !active || (active.verdict === 'accepted' && !currentAnalysis))
        && button(failed ? '重试处理' : active ? '刷新代码分析' : '判断规划符合度',
          () => action('process', { needId: need.id })),
      currentAnalysis && details('代码分析 · ' + analysis.parts.length + ' 项', muted(analysis.summary),
        muted('读取 ' + analysis.coverage.filesRead + ' 个文件 · ' + analysis.sha.slice(0, 8)),
        ...analysis.parts.map(part => el('div', { className: 'evidence' },
          row(el('strong', {}, part.title), badge(({ change: '待改动', satisfied: '已有能力', verify: '待核实' })[part.kind], part.kind)),
          identity('当前行为', part.current), identity('涉及的变化', part.change), muted(part.reason),
          codeEvidence(project, analysis.sha, part.references)))));
  }

  function candidateCard(candidate) {
    const checkbox = el('input', { type: 'checkbox', checked: selection.has(candidate.id),
      'aria-label': '选入 PRD · ' + candidate.title, onchange: event => {
        if (event.target.checked) selection.add(candidate.id);
        else selection.delete(candidate.id);
      } });
    return block(el('div', { className: 'card-heading' }, el('h2', {}, candidate.title), row(checkbox, badge(candidate.parts.length + ' 项来源'))),
      candidate.parts.map(({ need, part }) => {
        const alternatives = project.candidates.filter(item => item.id !== candidate.id);
        const suggested = alternatives.find(item => item.id === part.suggestedMerge);
        return el('div', { className: 'evidence' },
          identity('目标与场景', part.goal + '\n' + need.context), identity('建议改动', part.change),
          details('原始反馈及代码依据', need.quotes.map(quote => el('blockquote', {}, quote)),
            codeEvidence(project, project.sha, part.references), planEvidence(project, need.decisions.at(-1))),
          suggested && button('合并建议 · ' + suggested.title, () => action('regroup', { partId: part.id, from: candidate.id, target: suggested.id })),
          alternatives.length > 0 && details('移到另一项改动', submit('合并', data => action('regroup', {
            partId: part.id, from: candidate.id, target: data.get('target'),
          }), field('目标改动', el('select', { name: 'target' },
            alternatives.map(item => el('option', { value: item.id }, item.title)))))),
          candidate.parts.length > 1 && button('拆为独立改动', () => action('regroup', {
            partId: part.id, from: candidate.id, target: null,
          })));
      }));
  }

  function drafts() {
    if (!project.drafts.length) return block(el('h2', {}, '还没有 PRD'), muted('在候选改动中勾选同一产品目标下的改动，生成第一份草案。'));
    const draft = project.drafts.find(item => item.id === activeDraft) || project.drafts.at(-1);
    const latest = draft.versions.at(-1);
    const version = draft.versions.find(item => item.id === versionId) || latest;
    const decision = draft.decisions.find(item => item.versionId === version.id);
    const picker = el('select', { 'aria-label': 'PRD 草案', onchange: event => {
      activeDraft = event.target.value;
      versionId = null;
      view();
    } }, project.drafts.map(item => el('option', {
      value: item.id, selected: item.id === draft.id,
    }, item.versions.at(-1).sections.title)));
    const versions = el('select', { 'aria-label': '草案版本', onchange: event => {
      versionId = event.target.value;
      view();
    } }, draft.versions.map((item, index) => el('option', {
      value: item.id, selected: item.id === version.id,
    }, '版本 ' + (index + 1) + ' · ' + date(item.at))));
    const body = Object.entries(sections).filter(([key]) => key !== 'title').map(([key, label]) =>
      identity(label, version.sections[key] || '无'));
    const provenance = details('规划与代码证据 · ' + version.context.sha.slice(0, 8), version.context.parts.map(item =>
      el('div', { className: 'evidence' }, el('strong', {}, item.part.title), identity('规划判断', item.planning.reason),
        item.raw.map(quote => el('blockquote', {}, quote)), planEvidence(project, item.planning),
        codeEvidence(project, version.context.sha, item.part.references))),
    version.context.unresolved.map(item => el('div', { className: 'evidence' },
      identity('待核实 · ' + item.title, item.reason), codeEvidence(project, version.context.sha, item.references))));
    return [
      block(el('div', { className: 'form-grid' }, field('PRD 草案', picker), field('版本', versions))),
      block(el('div', { className: 'card-heading' }, el('h2', {}, version.sections.title),
        badge(decision ? prdStatus[decision.verdict] : '待评审', decision?.verdict || 'review')),
        decision && identity('评审意见', decision.reason), body, provenance,
        decision?.verdict === 'accepted' && button('导出 Markdown', () => exportVersion(project, version), 'primary')),
      version.id === latest.id && !decision && block(
        details('编辑草案', submit('保存新版本', data => action('edit-draft', {
          draftId: draft.id, versionId: version.id, sections: Object.fromEntries(data),
        }), Object.entries(sections).map(([key, label]) =>
          field(label, textarea(key, version.sections[key], { required: key !== 'openQuestions', maxLength: key === 'title' ? 500 : 5000 }))))),
        el('h2', {}, '评审决策'),
        submit('保存评审决策', data => action('decide-draft', { draftId: draft.id, versionId: version.id,
          verdict: data.get('verdict'), reason: data.get('reason') }),
        field('决定', el('select', { name: 'verdict' }, el('option', { value: 'accepted' }, '采纳'),
          el('option', { value: 'returned' }, '退回修改'), el('option', { value: 'rejected' }, '拒绝'))),
        field('评审意见', textarea('reason', '', { rows: 2 })))),
      version.id === latest.id && draft.decisions.at(-1)?.verdict !== 'accepted' && row(button('按当前改动重新生成', () => {
        const available = new Set(project.candidates.map(item => item.id));
        const ids = [...selection].filter(id => available.has(id));
        const candidates = ids.length ? ids : version.context.candidateIds.filter(id => available.has(id));
        if (!candidates.length) throw new Error('请在候选改动中选取新的改动。');
        return action('draft', { draftId: draft.id, candidates });
      })),
    ];
  }

  function view() {
    const invite = new URL(studioPath + '/submit/' + project.id + '/' + project.invite, location.origin).href;
    const currentPlan = project.plans.find(item => item.id === project.planId);
    const tabs = [
      ['needs', '用户需求', project.needs.length],
      ['candidates', '候选改动', project.candidates.length],
      ['drafts', 'PRD 草案', project.drafts.length],
      ['settings', '规划与仓库'],
    ];
    let content;
    if (tab === 'needs') {
      content = project.needs.length ? project.needs.slice().reverse().map(needCard)
        : block(el('h2', {}, '等待首条用户需求'), muted('复制需求链接。用户确认澄清结果后，需求会出现在这里。'));
    } else if (tab === 'candidates') {
      content = project.candidates.length ? [
        row(button('生成所选改动的 PRD', () => {
          const candidates = project.candidates.filter(item => selection.has(item.id)).map(item => item.id);
          if (!candidates.length) throw new Error('请至少选择一项改动。');
          return action('draft', { candidates }, 'drafts');
        }, 'primary'), project.canUndoGroup && button('撤销最近一次拆并', () => action('undo-group', {}))),
        ...project.candidates.map(candidateCard),
      ] : block(el('h2', {}, '等待候选改动'), muted('符合规划的需求会自动分析。找到有依据的改动后，可在这里拆分、合并并生成 PRD。'));
    } else if (tab === 'drafts') {
      content = drafts();
    } else {
      const plans = sourceEditor(project.sources);
      content = block(el('h2', {}, '规划与仓库'),
        el('div', { className: 'form-grid' }, identity('基准分支', project.branch), identity('代码提交', project.sha),
          identity('生效规划版本', currentPlan.id.slice(0, 8) + ' · ' + date(currentPlan.createdAt))),
        details('查看生效的规划正文', ...currentPlan.sources.map(source =>
          identity(source.path || source.title, source.text))),
        submit('保存规划并刷新代码', data => action('refresh', { sources: plans.read() }), plans.controls),
        button('仅刷新当前仓库与规划', () => action('refresh', {})));
    }
    render(el('a', { className: 'back', href: studioPath + '/' }, '← 项目'),
      heading(project.name, project.repo.name + ' · ' + project.branch + ' · ' + project.sha.slice(0, 8),
        row(button('刷新', () => update()), button('复制需求链接', async () => {
          await navigator.clipboard.writeText(invite);
          show('已复制需求链接。');
        }, 'primary'), el('a', { href: invite, target: '_blank', rel: 'noreferrer' }, '打开用户入口'))),
      el('nav', { className: 'tabs', 'aria-label': '项目功能' }, tabs.map(([id, title, count]) =>
        el('button', { type: 'button', 'aria-current': tab === id ? 'page' : undefined, onclick: () => {
          tab = id;
          view();
        } }, title, count === undefined ? '' : el('span', {}, count)))),
      el('div', { className: 'panels' }, content));
  }

  await update();
}

export async function openManager() {
  const session = await api('/session').catch(error => {
    if (error.status === 401) return null;
    throw error;
  });
  if (!session) {
    render(el('section', { className: 'welcome panel' }, el('h1', {}, '从用户原话到可评审的 PRD'),
      muted('连接 GitHub 仓库，依据产品规划判断需求，结合代码现状拆解与合并。'),
      el('a', { className: 'primary button', href: studioPath + '/api/auth/login' }, '使用 GitHub 登录')));
    return;
  }
  document.querySelector('#session').replaceChildren(row(el('span', {}, session.login), button('退出', async () => {
    await api('/auth/logout', {});
    location.assign(studioPath + '/');
  })));
  if (currentPath.startsWith('/projects/')) await openProject(currentPath);
  else await home();
}
