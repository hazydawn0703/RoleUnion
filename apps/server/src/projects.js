import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { collectCode, draftSections } from './analysis.js';
import { HttpError, requireThat } from './http.js';
import { deployInput } from './deployKeys.js';

const workspace = 'discovery';
const id = z.uuid();
const short = z.string().trim().min(1).max(240);
const multiline = z.string().trim().min(1).max(24_000);
const sourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inline'), title: short, text: multiline }),
  z.object({ type: z.literal('repository'), path: short.regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+\.(?:md|txt|rst)$/i) }),
]);
const sourcesSchema = z.array(sourceSchema).min(1).max(5);
const now = () => new Date().toISOString();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function find(items, id, message = '找不到这条记录。') {
  const item = items.find(item => item.id === id);
  requireThat(item, 404, message);
  return item;
}

function decisionFor(project, need) {
  const decision = need.decisions.at(-1);
  if (decision?.planId === project.planId) return decision;
  return null;
}

function activeCandidates(project) {
  const byPart = new Map();
  for (const need of project.needs) {
    if (decisionFor(project, need)?.verdict !== 'accepted'
      || need.analysis?.sha !== project.sha || need.analysis.decisionId !== decisionFor(project, need).id) continue;
    for (const part of need.analysis.parts) {
      if (part.kind === 'change') byPart.set(part.id, { need, part });
    }
  }
  const candidates = [];
  const groups = new Map();
  for (const [partId, groupId] of Object.entries(project.grouping)) {
    if (!byPart.has(partId)) continue;
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId).push(byPart.get(partId));
  }
  for (const [id, parts] of groups) candidates.push({ id, title: parts[0].part.title, parts });
  return candidates;
}

function draftContext(project, candidateIds) {
  const active = activeCandidates(project);
  const selected = candidateIds.map(id => find(active, id, '改动已变化，请重新选择。'));
  const parts = selected.flatMap(candidate => candidate.parts.map(({ need, part }) => ({
    id: part.id,
    candidateId: candidate.id,
    needId: need.id,
    raw: need.quotes,
    problem: need.problem,
    context: need.context,
    outcome: need.outcome,
    planning: decisionFor(project, need),
    part,
  })));
  const needIds = new Set(parts.map(part => part.needId));
  const unresolved = project.needs.filter(need => needIds.has(need.id))
    .flatMap(need => need.analysis.parts.filter(part => part.kind === 'verify')
      .map(part => ({ needId: need.id, title: part.title, reason: part.reason, references: part.references })));
  return { parts, unresolved, planId: project.planId, sha: project.sha, candidateIds };
}

function publicConversation(conversation, project) {
  return {
    id: conversation.id, messages: conversation.messages,
    proposed: conversation.proposed, proposalId: conversation.proposalId,
    submitted: Boolean(conversation.needIds),
    outcomes: conversation.needIds?.map(id => {
      const need = find(project.needs, id);
      return { problem: need.problem, status: decisionFor(project, need)?.verdict || 'queued' };
    }),
  };
}

export function createProjects({ github, deployKeys, analysis, storage }) {
  const all = () => storage.listProjects(workspace);
  const save = project => storage.saveProject(workspace, project);
  function read(id) {
    const project = storage.getProject(workspace, id);
    requireThat(project, 404, '找不到项目。');
    return project;
  }
  function roleOf(project, user) {
    if (project.owner === user.id) return 'owner';
    const member = project.members?.find(item => item.id === user.id);
    return member?.pending ? 'invited' : member?.role;
  }
  function accessible(user, projectId, roles) {
    const project = read(projectId);
    const role = roleOf(project, user);
    requireThat(role, 404, '找不到项目。');
    requireThat(!roles || roles.includes(role), 403, '当前项目角色无权执行此操作。');
    return project;
  }
  function invited(projectId, invite) {
    const project = read(projectId);
    requireThat(project.invite === invite, 404, '提交链接无效。');
    return project;
  }
  function view(project, user) {
    const role = roleOf(project, user);
    const { id, name, repo, branch, sha, members = [], operations, grouping, groupingHistory, ...rest } = project;
    if (role === 'invited') return { id, name, role, offeredRole: members.find(m => m.id === user.id).role };
    const summary = { id, name, repo, branch, sha, role, pendingKey: project.pendingKey };
    if (role === 'connector') return summary;
    return { ...summary, ...rest, members: role === 'owner' ? members : undefined,
      candidates: activeCandidates(project), canUndoGroup: Boolean(groupingHistory.length) };
  }

  async function mutate(load, key, operation, perform) {
    const project = load();
    const existing = project.operations[key];
    if (existing) {
      requireThat(existing.operation === operation, 409, '此请求编号已被用于其他操作。');
      return existing.result;
    }
    const revision = project.revision;
    const result = await perform(project);
    const latest = load();
    if (latest.operations[key]?.operation === operation) return latest.operations[key].result;
    requireThat(latest.revision === revision, 409, '项目已更新，请重试。');
    project.operations[key] = { operation, result };
    project.revision += 1;
    save(project);
    return result;
  }

  async function callModel(call) {
    try {
      return await call();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      console.warn('Model operation failed:', error.name, error.message?.match(/^Model HTTP \d+$/)?.[0] || '');
      throw new HttpError(502, '模型暂时无法完成分析，请重试。');
    }
  }

  function openSnapshot(project, pinnedSha) {
    const reader = project.repo.type === 'deploy-key' ? deployKeys : github;
    return reader.open(project.repo, project.branch, pinnedSha);
  }
  async function refresh(project, sources) {
    requireThat(project.repo || sources.every(source => source.type === 'inline'), 422, '连接仓库后可选择仓库内的规划文件。');
    const snapshot = project.repo ? await openSnapshot(project) : null;
    const plans = [];
    try {
      for (const source of sources) {
        plans.push(source.type === 'inline' ? { ...source } :
          { ...source, text: await snapshot.read(source.path), sha: snapshot.sha });
      }
    } finally {
      await snapshot?.close?.();
    }
    requireThat(plans.every(plan => plan.text.trim()), 422, '规划文档不能为空。');
    requireThat(plans.reduce((sum, plan) => sum + plan.text.length, 0) <= 48_000, 422, '有效规划合计最多 48,000 个字符。');
    const fingerprint = digest(plans.map(({ sha, ...content }) => content));
    if (project.planFingerprint !== fingerprint) {
      project.planId = randomUUID();
      project.plans.push({ id: project.planId, createdAt: now(), sources: plans });
      project.planFingerprint = fingerprint;
    }
    project.sha = snapshot?.sha ?? null;
    project.sources = sources;
    project.refreshedAt = now();
  }

  async function classify(project, need) {
    const current = decisionFor(project, need);
    if (current) return current;
    const plans = project.plans.find(plan => plan.id === project.planId).sources;
    const { problem, context, outcome, quotes } = need;
    const result = await callModel(() => analysis.classify({ problem, context, outcome, quotes }, plans));
    const decision = { ...result, id: randomUUID(), planId: project.planId, by: 'model', at: now() };
    need.decisions.push(decision);
    return decision;
  }

  async function analyze(project, need) {
    const decision = decisionFor(project, need);
    requireThat(decision?.verdict === 'accepted', 409, '先确认需求符合当前规划。');
    if (need.analysis?.sha === project.sha && need.analysis.decisionId === decision.id) return need.analysis;
    const { problem, context, outcome, quotes } = need;
    const input = { problem, context, outcome, quotes };
    const snapshot = await openSnapshot(project, project.sha);
    let contextFiles;
    try {
      contextFiles = await callModel(() => collectCode(snapshot, input, analysis));
    } finally {
      await snapshot.close?.();
    }
    const candidates = activeCandidates(project).map(({ id, title, parts }) => ({
      id, title, parts: parts.map(({ need, part }) => ({ goal: part.goal, change: part.change, scenario: need.context })),
    }));
    const generated = await callModel(() => analysis.analyze(input, contextFiles, candidates));
    const valid = new Set(candidates.map(candidate => candidate.id));
    for (const old of need.analysis?.parts || []) delete project.grouping[old.id];
    const parts = generated.parts.map(({ mergeWith, ...result }) => {
      const part = { ...result, id: randomUUID(), suggestedMerge: null };
      if (part.kind === 'change') {
        project.grouping[part.id] = randomUUID();
        if (valid.has(mergeWith)) part.suggestedMerge = mergeWith;
      }
      return part;
    });
    need.analysis = { id: randomUUID(), sha: snapshot.sha, decisionId: decision.id, at: now(), summary: generated.summary,
      coverage: contextFiles.coverage, files: contextFiles.files.map(file => file.path), parts };
    project.groupingHistory = [];
    return need.analysis;
  }

  const repoInput = z.object({
    repoId: z.int().positive(), installation: z.int().positive(), branch: short,
  });

  const workers = new Set();

  function runQueue(projectId) {
    if (workers.has(projectId)) return;
    workers.add(projectId);
    async function processQueue() {
      try {
        while (true) {
          const project = read(projectId);
          const queued = project.needs.find(need => need.work?.status === 'queued');
          if (!queued) return;
          try {
            if (!decisionFor(project, queued)) {
              await mutate(() => read(projectId), queued.work.id + '/' + project.planId, 'classify/' + queued.id, async current => {
                await classify(current, find(current.needs, queued.id));
                return {};
              });
            }
            await mutate(() => read(projectId), queued.work.id, 'process/' + queued.id, async current => {
              const need = find(current.needs, queued.id);
              const decision = decisionFor(current, need);
              requireThat(decision, 409, '规划已更新。');
              if (decision.verdict === 'accepted' && !current.repo) {
                need.work.status = 'waiting-repository';
              } else {
                if (decision.verdict === 'accepted') await analyze(current, need);
                need.work.status = 'done';
              }
              return {};
            });
          } catch (error) {
            if (error.status === 409) continue;
            const latest = read(projectId);
            const need = find(latest.needs, queued.id);
            if (need.work.id !== queued.work.id) continue;
            need.work.status = 'failed';
            need.work.error = error instanceof HttpError ? error.message : '处理失败，请重试。';
            latest.revision += 1;
            save(latest);
          }
        }
      } finally {
        workers.delete(projectId);
      }
    }
    processQueue().catch(error => console.error('Queue failed:', error.name, error.code || ''));
  }

  function queue(need) {
    need.work = { id: randomUUID(), status: 'queued' };
  }

  return {
    resume() {
      all().filter(project => project.needs.some(need => need.work?.status === 'queued'))
        .forEach(project => runQueue(project.id));
    },
    list(user) {
      return all().filter(p => roleOf(p, user)).map(p => ({
        id: p.id, name: p.name, role: roleOf(p, user),
        repo: roleOf(p, user) === 'invited' ? null : p.repo?.name,
      }));
    },
    get(user, id) {
      return view(accessible(user, id), user);
    },
    async create(user, input, key) {
      const existing = storage.getProject(workspace, key);
      if (existing) {
        requireThat(existing.owner === user.id, 409, '项目编号已使用。');
        return { id: existing.id };
      }
      const { name, sources } = z.object({ name: short, sources: sourcesSchema }).strict().parse(input);
      const project = { id: key, workspace_id: workspace, owner: user.id, name, repo: null, branch: null, members: [],
        invite: randomUUID(), operations: {}, revision: 0, plans: [], conversations: [], needs: [],
        grouping: {}, groupingHistory: [], drafts: [] };
      await refresh(project, sources);
      const latest = storage.getProject(workspace, key);
      requireThat(!latest || latest.owner === user.id, 409, '项目编号已使用。');
      if (!latest) save(project);
      return { id: project.id };
    },
    publicInfo(projectId, invite) {
      return { name: invited(projectId, invite).name };
    },
    conversation(projectId, invite, conversationId) {
      const project = invited(projectId, invite);
      return publicConversation(find(project.conversations, conversationId), project);
    },
    start(projectId, invite, key) {
      return mutate(() => invited(projectId, invite), key, 'start', project => {
        const conversation = { id: key, createdAt: now(), messages: [], proposed: [] };
        project.conversations.push(conversation);
        return { id: conversation.id };
      });
    },
    message(projectId, invite, conversationId, body, key) {
      const message = z.string().trim().min(1).max(4_000).parse(body.message);
      return mutate(() => invited(projectId, invite), key, 'message/' + conversationId, async project => {
        const conversation = find(project.conversations, conversationId);
        requireThat(!conversation.needIds, 409, '此对话已提交。');
        requireThat(conversation.messages.length < 60, 422, '对话已达到 30 轮，请新开对话。');
        const userMessage = { role: 'user', text: message };
        const history = [...conversation.messages, userMessage];
        const result = await callModel(() => analysis.clarify(history));
        const original = history.filter(item => item.role === 'user');
        requireThat(result.needs.every(need => need.quotes.every(quote => original.some(item => item.text.includes(quote)))),
          502, '模型返回的引用无法在原话中找到，请重试。');
        conversation.messages.push(userMessage, { role: 'assistant', text: result.reply });
        conversation.proposed = result.needs;
        conversation.proposalId = randomUUID();
        return { id: conversation.id };
      });
    },
    async submit(projectId, invite, conversationId, body, key) {
      const load = () => invited(projectId, invite);
      await mutate(load, key, 'submit/' + conversationId, project => {
        const conversation = find(project.conversations, conversationId);
        if (conversation.needIds) return { ids: conversation.needIds };
        requireThat(conversation.proposed.length && body.proposalId === conversation.proposalId, 409, '请先确认最新的需求摘要。');
        const needs = conversation.proposed.map(need => ({ ...need, id: randomUUID(), conversationId,
          submittedAt: now(), decisions: [] }));
        needs.forEach(queue);
        project.needs.push(...needs);
        conversation.needIds = needs.map(need => need.id);
        return { ids: conversation.needIds };
      });
      runQueue(projectId);
      return { id: conversationId };
    },
    async action(user, projectId, command, body, key) {
      const roles = { 'invite-member': ['owner'], 'remove-member': ['owner'],
        'accept-invite': ['invited', 'editor', 'connector'], 'connect-repository': ['owner', 'connector'],
        'prepare-deploy-key': ['owner', 'connector'], 'verify-deploy-key': ['owner', 'connector'],
        'connect-deploy-key': ['owner', 'connector'] };
      const load = () => accessible(user, projectId, Object.hasOwn(roles, command) ? roles[command] : ['owner', 'editor']);
      const result = await mutate(load, user.id + '/' + key, command, async project => {
        switch (command) {
          case 'invite-member': {
            const input = z.object({ login: short.regex(/^[a-zA-Z0-9_-]{1,100}$/), role: z.enum(['editor', 'connector']) }).parse(body);
            const account = await github.account(user, input.login);
            project.members ??= [];
            requireThat(account.id !== project.owner && !project.members.some(m => m.id === account.id), 409, '该账号已经在成员或邀请列表中。');
            project.members.push({ ...account, role: input.role, pending: true });
            return {};
          }
          case 'remove-member': {
            const member = find(project.members || [], short.parse(body.id));
            project.members = project.members.filter(m => m.id !== member.id);
            return {};
          }
          case 'accept-invite': {
            const member = find(project.members, user.id);
            member.pending = false;
            return {};
          }
          case 'prepare-deploy-key': {
            requireThat(!project.repo, 409, '此项目已连接仓库。');
            const input = deployInput.parse(body);
            project.pendingKey = { ...input, publicKey: await deployKeys.publicKey(project.id) };
            return {};
          }
          case 'verify-deploy-key': {
            requireThat(!project.repo && project.pendingKey, 409, '请先准备仓库公钥。');
            const { name, branch } = project.pendingKey;
            const snapshot = await deployKeys.open({ name, projectId }, branch);
            try {
              const tree = await snapshot.files();
              project.pendingKey.verified = { sha: snapshot.sha, files: tree.paths.length, at: now() };
              if (tree.paths.length) await snapshot.read(tree.paths[0]);
            } finally {
              await snapshot.close();
            }
            return {};
          }
          case 'connect-deploy-key':
          case 'connect-repository': {
            requireThat(!project.repo, 409, '此项目已连接仓库。');
            if (command === 'connect-deploy-key') {
              const pending = project.pendingKey;
              requireThat(pending?.verified && body.sha === pending.verified.sha, 409, '请先验证只读连接。');
              project.repo = { type: 'deploy-key', name: pending.name, projectId };
              project.branch = pending.branch;
            } else {
              const input = repoInput.parse(body);
              const repos = await github.repositories(user);
              project.repo = repos.find(r => r.id === input.repoId && r.installation === input.installation);
              requireThat(project.repo, 403, '请选择你有管理权限且已授权给 RoleUnion 的仓库。');
              project.branch = input.branch;
            }
            await refresh(project, project.sources);
            delete project.pendingKey;
            project.needs.filter(n => n.work.status === 'waiting-repository').forEach(queue);
            return {};
          }
          case 'refresh':
            await refresh(project, body.sources === undefined ? project.sources : sourcesSchema.parse(body.sources));
            project.needs.filter(n => !decisionFor(project, n)).forEach(queue);
            return { sha: project.sha };
          case 'process': {
            const need = find(project.needs, id.parse(body.needId));
            if (need.work?.status !== 'queued') queue(need);
            return { id: need.id };
          }
          case 'decide-fit': {
            const input = z.object({ needId: id, decisionId: id, verdict: z.enum(['accepted', 'rejected']), reason: multiline }).parse(body);
            const need = find(project.needs, input.needId);
            const current = decisionFor(project, need);
            requireThat(current?.verdict === 'review' && current.id === input.decisionId, 409, '规划裁定已变化。');
            const decision = { ...current, id: randomUUID(), verdict: input.verdict, reason: input.reason,
              priorDecisionId: current.id, by: user.id, at: now() };
            need.decisions.push(decision);
            if (decision.verdict === 'accepted') queue(need);
            return { id: decision.id };
          }
          case 'regroup': {
            const input = z.object({ partId: id, target: id.nullable(), from: id }).parse(body);
            const active = activeCandidates(project);
            const source = find(active, input.from);
            find(source.parts.map(item => item.part), input.partId);
            if (input.target) find(active, input.target);
            requireThat(input.target !== input.from && (input.target || source.parts.length > 1), 422, '请选择不同的改动，或拆分已合并的改动。');
            const target = input.target || randomUUID();
            project.groupingHistory.push({ partId: input.partId, from: input.from, to: target });
            project.grouping[input.partId] = target;
            return { id: target };
          }
          case 'undo-group': {
            const change = project.groupingHistory.pop();
            requireThat(change, 409, '没有可撤销的合并或拆分。');
            project.grouping[change.partId] = change.from;
            return {};
          }
          case 'draft': {
            const input = z.object({ candidates: z.array(id).min(1).max(12), draftId: id.optional() }).parse(body);
            const context = draftContext(project, [...new Set(input.candidates)]);
            const draft = input.draftId
              ? find(project.drafts, input.draftId)
              : { id: randomUUID(), versions: [], decisions: [] };
            requireThat(draft.decisions.at(-1)?.verdict !== 'accepted', 409, '已采纳的 PRD 可导出，也可以另建草案。');
            const last = draft.versions.at(-1);
            const sections = await callModel(() => analysis.draft({ ...context,
              prior: last?.sections, decision: draft.decisions.at(-1) }));
            const version = { id: randomUUID(), at: now(), sections, context };
            draft.versions.push(version);
            if (!input.draftId) project.drafts.push(draft);
            return { id: draft.id, versionId: version.id };
          }
          case 'edit-draft':
          case 'decide-draft': {
            const input = z.object({ draftId: id, versionId: id }).parse(body);
            const draft = find(project.drafts, input.draftId);
            const version = draft.versions.at(-1);
            requireThat(version.id === input.versionId && !draft.decisions.some(item => item.versionId === version.id), 409, '该版本已被编辑或评审。');
            if (command === 'edit-draft') {
              const next = { ...version, id: randomUUID(), at: now(), sections: draftSections.parse(body.sections) };
              draft.versions.push(next);
              return { id: draft.id, versionId: next.id };
            }
            const decision = z.object({ verdict: z.enum(['accepted', 'returned', 'rejected']), reason: multiline }).parse(body);
            if (decision.verdict === 'accepted') {
              const candidates = new Set(activeCandidates(project).map(candidate => candidate.id));
              requireThat(version.context.candidateIds.every(id => candidates.has(id)),
                409, '规划、代码或改动已更新，请重新生成草案再采纳。');
              const current = draftContext(project, version.context.candidateIds);
              requireThat(digest(current) === digest(version.context), 409, '规划、代码或改动已更新，请重新生成草案再采纳。');
            }
            draft.decisions.push({ ...decision, versionId: version.id, by: user.id, at: now() });
            return { id: draft.id };
          }
          default:
            throw new HttpError(404, '找不到此操作。');
        }
      });
      if (['process', 'decide-fit', 'connect-repository', 'connect-deploy-key', 'refresh'].includes(command)) runQueue(projectId);
      return result;
    },
  };
}
