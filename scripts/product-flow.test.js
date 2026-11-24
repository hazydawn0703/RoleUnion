import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { FileStorage } from '../packages/storage/src/fileStorage.js';
import { createRoleUnionServer } from '../apps/server/src/server.js';
import { createModel } from '../apps/server/src/llmAccess.js';
import { HttpError } from '../apps/server/src/http.js';

const origin = 'http://localhost:8787';
const studio = '/apps/studio';
const repo = { id: 501, name: 'example/store', branch: 'main', installation: 77 };
const repoPolicy = 'We support finance reconciliation. Customer-facing quote export is out of scope.';
const code = 'export function exportOrders() {\n  return ["order_id", "gross_total"];\n}\nconst action = button("Export orders", exportOrders);';
const changedFiles = ['src/orders.js', 'docs/roadmap.md'];
const draftSections = {
  title: 'Refund reconciliation', problem: 'Finance needs net totals.', userScenarios: 'Monthly reconciliation',
  currentBehavior: 'Order export contains gross totals.', desiredBehavior: 'Include refund lines.',
  scope: 'Finance export', acceptance: 'A refunded order includes the refund amount.', openQuestions: '',
};

function fakeModel(state) {
  return createModel({ name: 'integration-model', apiKey: 'integration-only', fetchImpl: async (_url, request) => {
    const { messages } = JSON.parse(request.body);
    const { task, data } = JSON.parse(messages[1].content);
    state.calls.push(task);
    let output;
    if (task === 'clarify') {
      const contract = JSON.parse(messages[0].content.split('\n').at(-1));
      assert.deepEqual(contract.required, ['reply', 'needs']);
      assert.equal(contract.properties.needs.items.properties.quotes.type, 'array');
      assert.deepEqual(Object.keys(data).sort(), ['interfaceLabels', 'messages']);
      if (state.calls.includes('investigate-interface')) assert.deepEqual(data.interfaceLabels, ['Export orders']);
      const user = data.messages.at(-1).text;
      output = user === 'Export is confusing'
        ? { reply: 'Who uses this export, and for which task?', needs: [] }
        : { reply: 'Please confirm.', needs: [{ problem: user, context: 'Monthly reporting', outcome: 'Finish reporting', quotes: [user] }] };
    } else if (task === 'investigate-interface') {
      if (data.excerpts.length) assert.deepEqual(data.excerpts.map(item => item.path), ['src/orders.js']);
      output = data.excerpts.length ? { reads: [], labels: ['Export orders', 'gross_total', 'Unobserved'] }
        : { reads: [{ path: 'src/orders.js', line: 1 }, { path: '.env', line: 1 }], labels: [] };
    } else if (task === 'classify') {
      assert(data.plans.length);
      const problem = data.need.problem;
      if (problem.includes('refund') || problem.includes('net totals')) {
        output = { verdict: 'accepted', reason: 'Finance reconciliation is supported.',
          evidence: [{ index: 0, quote: 'We support finance reconciliation.' }] };
      } else if (problem.includes('quote')) {
        output = { verdict: 'rejected', reason: 'Quote export is excluded.',
          evidence: [{ index: 0, quote: 'Customer-facing quote export is out of scope.' }] };
      } else {
        output = { verdict: 'rejected', reason: 'Lacks documented priority.',
          evidence: [{ index: 0, quote: 'The plan explicitly rejects accessibility.' }] };
      }
    } else if (task === 'verify-rejection') {
      output = { confirmed: true, reason: 'Explicit exclusion.' };
    } else if (task === 'select-files') {
      output = { paths: data.knownPaths.length ? [] : ['src/orders.js', '.env'] };
    } else if (task === 'analyze') {
      assert.deepEqual(data.files.map(file => file.path), ['src/orders.js']);
      assert.equal(data.files[0].lines[1].trim(), 'return ["order_id", "gross_total"];');
      output = { summary: 'CSV exists, refund amounts are missing.', parts: [
        { title: 'Include refund lines', goal: 'Reconcile net sales', current: 'CSV has gross totals.',
          change: 'Include refund amounts', reason: 'The export leaves refunds out.', kind: 'change',
          references: [{ path: 'src/orders.js', start: 1, end: 3 }], mergeWith: data.candidates[0]?.id || null },
        { title: 'Keep existing order export', goal: 'Keep reconciliation usable', current: 'Order CSV exists.',
          change: 'Keep order identifiers.', reason: 'Existing behavior is useful.', kind: 'satisfied',
          references: [{ path: 'src/orders.js', start: 2, end: 2 }], mergeWith: null },
        { title: 'Check tax rounding', goal: 'Validate finance calculations', current: 'Tax rounding already works.',
          change: 'No rounding change', reason: 'Rounding is not clear.', kind: 'satisfied',
          references: [{ path: 'src/orders.js', start: 999, end: 999 }], mergeWith: null },
      ] };
    } else if (task === 'draft') {
      assert(data.parts[0].planning.evidence.length);
      assert(data.unresolved.length);
      output = draftSections;
    } else {
      throw new Error('Unexpected model task ' + task);
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] });
  } });
}

test('GitHub project, conversation clarification, planning gate, code evidence, grouping and PRD decisions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roleunion-test-'));
  const state = { sha: 'a'.repeat(40), calls: [], blocked: false, policy: repoPolicy };
  const git = {
    authorizationUrl: token => 'https://github.com/login/oauth/authorize?state=' + token,
    signIn: async login => ({ id: login, login }),
    account: async (_user, login) => ({ id: login, login }),
    repositories: async user => user.id === 'tech' ? [repo] : [],
    open: async (_repo, _branch, pinned) => {
      if (state.blocked) throw new HttpError(503, 'GitHub access revoked.');
      return {
        sha: pinned || state.sha,
        files: async () => ({ paths: changedFiles, truncated: false }),
        read: async path => ({ [changedFiles[0]]: code, [changedFiles[1]]: state.policy })[path],
      };
    },
  };

  let server;
  let address;
  const deployKeys = {
    publicKey: async () => 'ssh-ed25519 project-test',
    open: async (repo, branch) => {
      assert.equal(repo.name, 'external/private');
      assert.equal(branch, 'main');
      if (!state.keyAuthorized) throw new HttpError(422, 'Waiting for repository administrator.');
      return { sha: state.sha, files: async () => ({ paths: ['README.md'] }),
        read: async () => repoPolicy, close: async () => {} };
    },
  };
  async function start() {
    server = createRoleUnionServer({ origin, github: git, deployKeys, model: fakeModel(state), storage: new FileStorage(directory),
      sessionSecret: 'a strong test secret of sufficient length' });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    address = 'http://127.0.0.1:' + server.address().port;
  }
  function request(path, options) {
    return fetch(address + studio + path, { redirect: 'manual', ...options });
  }
  async function login(code) {
    const response = await request('/api/auth/login');
    const state = new URL(response.headers.get('location')).searchParams.get('state');
    const oauthCookie = response.headers.get('set-cookie').split(';')[0];
    const result = await request('/api/auth/callback?state=' + state + '&code=' + code, { headers: { cookie: oauthCookie } });
    assert.equal(result.status, 303);
    assert.equal(result.headers.get('location'), studio + '/');
    return result.headers.getSetCookie()[0].split(';')[0];
  }

  async function api(path, { cookie, body, key = randomUUID(), expected = 200 } = {}) {
    const headers = cookie ? { cookie } : {};
    if (body !== undefined) Object.assign(headers, { origin, 'content-type': 'application/json', 'idempotency-key': key });
    const response = await request('/api' + path, { method: body === undefined ? 'GET' : 'POST',
      headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    assert.equal(response.status, expected, path + ' ' + JSON.stringify(data).slice(0, 200));
    return data;
  }

  try {
    await start();
    assert.match(await (await request('/')).text(), /RoleUnion/);
    assert.equal((await request('/.env')).status, 404);
    assert.equal((await fetch(address + '/api/auth/login')).status, 404);
    await api('/projects', { expected: 401 });
    let cookie = await login('owner');
    const other = await login('other');
    const tech = await login('tech');
    const editor = await login('editor');
    const create = { name: 'Store', sources: [{ type: 'inline', title: 'Roadmap', text: repoPolicy }] };
    await api('/projects', { body: { ...create, sources: [{ type: 'repository', path: 'docs/roadmap.md' }] }, cookie, expected: 422 });
    const key = randomUUID();
    const { id } = await api('/projects', { body: create, cookie, key });
    assert.equal((await api('/projects', { body: create, cookie, key })).id, id);
    const path = '/projects/' + id;
    const get = () => api(path, { cookie });
    const act = (command, body, expected) => api(path + '/' + command, { cookie, body, expected });
    const initial = await get();
    assert.equal(initial.repo, null);
    assert.equal(initial.sha, null);
    await api(path, { cookie: other, expected: 404 });
    const invite = '/submit/' + id + '/' + initial.invite;
    assert.deepEqual(await api(invite), { name: 'Store' });

    async function submit(text, followup = false) {
      const { id } = await api(invite + '/conversations', { body: {}, expected: 201 });
      const thread = invite + '/conversations/' + id;
      if (followup) {
        await api(thread + '/message', { body: { message: 'Export is confusing' } });
        assert.equal((await api(thread)).proposed.length, 0);
        await api(thread + '/confirm', { body: {}, expected: 409 });
      }
      const key = randomUUID();
      await api(thread + '/message', { body: { message: text }, key });
      await api(thread + '/message', { body: { message: text }, key });
      const conversation = await api(thread);
      assert.equal(conversation.messages.length, followup ? 4 : 2);
      await api(thread + '/confirm', { body: { proposalId: randomUUID() }, expected: 409 });
      const confirmation = { proposalId: conversation.proposalId };
      await api(thread + '/confirm', { body: confirmation });
      await api(thread + '/confirm', { body: confirmation });
      assert.equal((await api(thread)).outcomes[0].problem, text);
      return id;
    }

    async function when(check) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const project = await get();
        if (check(project)) return project;
        await delay(20);
      }
      assert.fail('Timed out waiting for pipeline');
    }
    const a = await submit('Need order refund lines', true);
    const waiting = await when(p => p.needs[0]?.work.status === 'waiting-repository');
    assert.equal(waiting.needs[0].decisions[0].verdict, 'accepted');
    assert.equal(waiting.needs[0].analysis, undefined);
    assert(!state.calls.includes('select-files'));
    const connect = { repoId: repo.id, installation: repo.installation, branch: 'main' };
    await act('connect-repository', connect, 403);
    await act('invite-member', { login: 'tech', role: 'connector' });
    await act('invite-member', { login: 'editor', role: 'editor' });
    const memberAction = (cookie, command, body, expected) => api(path + '/' + command, { cookie, body, expected });
    assert.equal((await api(path, { cookie: tech })).offeredRole, 'connector');
    await memberAction(tech, 'connect-repository', connect, 403);
    await memberAction(other, 'accept-invite', {}, 404);
    await memberAction(tech, 'accept-invite', {});
    await memberAction(editor, 'accept-invite', {});
    assert.deepEqual(Object.keys(await api(path, { cookie: tech })).sort(), ['id','name','repo','branch','sha','role'].sort());
    await memberAction(tech, 'refresh', {}, 403);
    await memberAction(tech, 'edit-project', create, 403);
    const edit = { name: 'Finance', sources: [{ ...create.sources[0], title: 'Finance priorities' }], revision: (await get()).revision };
    await memberAction(editor, 'edit-project', edit);
    await when(p => p.needs[0].work.status === 'waiting-repository');
    assert.equal((await get()).name, 'Finance');
    assert.equal((await get()).sources[0].title, 'Finance priorities');
    await memberAction(editor, 'edit-project', edit, 409);
    await memberAction(editor, 'invite-member', { login: 'other', role: 'editor' }, 403);
    await memberAction(editor, 'connect-repository', connect, 403);
    await memberAction(tech, 'connect-repository', { ...connect, repoId: 999 }, 403);
    await memberAction(tech, 'connect-repository', connect);
    await memberAction(tech, 'connect-repository', connect, 409);
    await when(project => project.candidates.length === 1);
    const second = await api('/projects', { body: { ...create, name: 'Second' }, cookie: editor });
    assert.deepEqual(new Set((await api('/projects', { cookie: editor })).map(p => p.id)), new Set([id, second.id]));
    assert.equal((await api('/projects/' + second.id, { cookie: editor })).name, 'Second');
    await api('/projects/' + second.id, { cookie, expected: 404 });
    const secondAction = (command, body, expected, actor = editor) =>
      api('/projects/' + second.id + '/' + command, { cookie: actor, body, expected });
    const target = { name: 'external/private', branch: 'main' };
    await secondAction('prepare-deploy-key', target, 404, other);
    await secondAction('prepare-deploy-key', { ...target, name: 'file:///repo' }, 422);
    await secondAction('prepare-deploy-key', target);
    await secondAction('connect-deploy-key', {}, 409);
    await secondAction('verify-deploy-key', {}, 422);
    state.keyAuthorized = true;
    const modelCount = state.calls.length;
    await secondAction('verify-deploy-key', {});
    const verified = await api('/projects/' + second.id, { cookie: editor });
    assert.equal(verified.pendingKey.verified.sha, state.sha);
    assert.equal(verified.repo, null);
    assert.equal(state.calls.length, modelCount);
    await secondAction('connect-deploy-key', { sha: state.sha });
    assert.equal((await api('/projects/' + second.id, { cookie: editor })).repo.type, 'deploy-key');
    await act('remove-member', { id: 'tech' });
    await api(path, { cookie: tech, expected: 404 });
    await submit('Need net totals for reconciliation');
    const rejected = await submit('Need customer quote export');
    const uncertain = await submit('Need accessible controls');

    const project = await when(project => project.needs.length === 4 && project.needs.every(need => need.work.status === 'done'));
    assert.equal(project.needs.find(need => need.conversationId === rejected).decisions[0].verdict, 'rejected');
    const unclear = project.needs.find(need => need.conversationId === uncertain);
    assert.equal(unclear.decisions[0].verdict, 'review');
    await act('decide-fit', { needId: unclear.id, decisionId: unclear.decisions[0].id, verdict: 'rejected', reason: 'Requires discovery.' });
    const first = project.needs.find(need => need.conversationId === a);
    assert.deepEqual(first.analysis.parts.map(part => part.kind), ['change', 'satisfied', 'verify']);
    assert.match(first.analysis.parts[0].references[0].excerpt, /gross_total/);

    const [left, right] = project.candidates;
    const part = right.parts[0].part;
    assert.equal(part.suggestedMerge, left.id);
    await act('regroup', { from: right.id, target: left.id, partId: part.id });
    assert.equal((await get()).candidates[0].parts.length, 2);
    await act('undo-group', {});
    assert.equal((await get()).candidates.length, 2);
    await act('regroup', { from: right.id, target: left.id, partId: part.id });
    const singleton = await act('regroup', { from: left.id, target: null, partId: part.id });
    assert.notEqual(singleton.id, left.id);
    await act('undo-group', {});

    const draft = await memberAction(editor, 'draft', { candidates: [left.id] });
    const edited = await act('edit-draft', { draftId: draft.id, versionId: draft.versionId,
      sections: { ...draftSections, scope: 'Refund lines only' } });
    await act('decide-draft', { draftId: draft.id, versionId: edited.versionId, verdict: 'returned', reason: 'Clarify scope.' });
    const regenerated = await act('draft', { draftId: draft.id, candidates: [left.id] });
    await act('decide-draft', { draftId: draft.id, versionId: regenerated.versionId, verdict: 'accepted', reason: 'Ready.' });
    const outdated = await act('draft', { candidates: [left.id] });
    state.sha = 'b'.repeat(40);
    await act('refresh', {});
    assert.equal((await get()).planId, project.planId);
    await act('decide-draft', { draftId: outdated.id, versionId: outdated.versionId, verdict: 'accepted', reason: 'Wrong commit.' }, 409);

    await new Promise(resolve => server.close(resolve));
    await start();
    cookie = await login('owner');
    const restored = await get();
    assert.equal(restored.drafts[0].versions.length, 3);
    assert.equal(restored.drafts[0].decisions.at(-1).verdict, 'accepted');
    assert.equal(restored.drafts[0].versions[2].context.sha, 'a'.repeat(40));
    state.policy = repoPolicy + '\nNew roadmap.';
    state.blocked = true;
    await act('process', { needId: first.id });
    const failed = await when(project => project.needs.find(need => need.id === first.id).work.status === 'failed');
    assert.equal(failed.needs.find(need => need.id === first.id).decisions.at(-1).verdict, 'accepted');
    assert.match(failed.needs.find(need => need.id === first.id).work.error, /access revoked/);
    state.blocked = false;
    await act('process', { needId: first.id });
    await when(project => project.needs.find(need => need.id === first.id).analysis.sha === state.sha);
    await memberAction(await login('editor'), 'refresh', { sources: [{ type: 'repository', path: 'docs/roadmap.md' }] });
    assert.notEqual((await get()).planId, initial.planId);
    await when(p => p.needs.every(n => n.work.status === 'done'));
    assert(state.calls.includes('verify-rejection'));
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
