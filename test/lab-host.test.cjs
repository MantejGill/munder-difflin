'use strict';

/**
 * Lab mode end to end inside the main process, with the app's REAL HiveManager and the REAL control server over a real
 * loopback socket: only the renderer is faked (a list of sends). No model, no network beyond 127.0.0.1.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { clientFromControlFile } = require('./lab-http.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { createLabHost } = loadTs('src/main/labHost.ts');
const { selectOrphansToArchive } = loadTs('src/shared/orphanedAgents.ts');

function floor(t, { lab = undefined, env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-lab-host-'));
  const sends = [];
  const hive = new HiveManager(() => home, (channel, payload) => { sends.push({ channel, payload }); return true; });
  const host = createLabHost({
    hive, readLabConfig: () => lab, env,
    sendToRenderer: (channel, payload) => sends.push({ channel, payload })
  });
  t.after(() => { host.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, hive, host, sends, root: path.join(home, 'hive') };
}
const sent = (sends, channel) => sends.filter((s) => s.channel === channel).map((s) => s.payload);

test('lab mode off: the host is inert (no control file, no god seat, nothing written)', async (t) => {
  const f = floor(t);
  assert.equal(f.host.mode().enabled, false);
  const r = await f.host.start();
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(path.join(f.root, 'lab-control.json')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'registry.json')), false, 'the hive was not even created');
  assert.equal(f.host.server(), null);
});

test('lab mode on: the god seat is Dwight, PTY-less, with the lab contract as identity', async (t) => {
  const f = floor(t, { env: { MD_LAB_CONTROL: '1' } });
  const r = await f.host.start();
  assert.equal(r.ok, true, r.error);
  const reg = f.hive.registry();
  assert.equal(reg.godId, 'god');
  const god = reg.agents.god;
  assert.equal(god.name, 'Dwight');
  assert.equal(god.provider, 'lab');
  assert.equal(god.isGod, true);
  assert.equal(god.archived, false);
  assert.match(god.role, /Lab orchestrator/);
  const identity = fs.readFileSync(path.join(f.root, 'agents', 'god', 'identity.md'), 'utf8');
  assert.match(identity, /# Dwight \(god\)/);
  assert.match(identity, /orchestrator of a research lab/);
  assert.match(identity, /No terminal/);
  assert.ok(fs.existsSync(path.join(f.root, 'agents', 'god', 'inbox', '.done')));
  // nothing was spawned: the hive has no spawn queue activity and the registry holds exactly the god
  assert.deepEqual(Object.keys(reg.agents), ['god']);
  assert.equal(f.host.server().view().phase, 'idle');
  // and the PTY-less god is never an orphan
  assert.deepEqual(selectOrphansToArchive(reg.agents, reg.godId, () => false), []);
});

test('the god name, role and prompt come from the lab config; env wins; the loop cannot rename the seat', async (t) => {
  const f = floor(t, { lab: { enabled: true, godName: 'Angela', godRole: 'Head of the lab', godPrompt: 'Be careful with the budget.' }, env: {} });
  await f.host.start();
  assert.equal(f.hive.registry().agents.god.name, 'Angela');
  assert.equal(f.hive.registry().agents.god.role, 'Head of the lab');
  assert.match(fs.readFileSync(path.join(f.root, 'agents', 'god', 'identity.md'), 'utf8'), /Be careful with the budget\./);
  const { call } = clientFromControlFile(f.root);
  const res = await call('POST', '/lab/agents', { id: 'god', name: 'Usurper', role: 'x', isGod: true });
  assert.equal(res.status, 200);
  assert.equal(f.hive.registry().agents.god.name, 'Angela', 'the lab config is authoritative for the god seat');
  assert.equal((await call('GET', '/lab/state')).json.state.god.name, 'Angela');

  const g = floor(t, { lab: { enabled: true, godName: 'Angela' }, env: { MD_LAB_GOD_NAME: 'Dwight' } });
  await g.host.start();
  assert.equal(g.hive.registry().agents.god.name, 'Dwight');
});

test('the control file is gitignored and never lands in the hive repository', async (t) => {
  const f = floor(t, { env: { MD_LAB_CONTROL: '1' } });
  await f.host.start();
  const { call } = clientFromControlFile(f.root);
  await call('POST', '/lab/tasks', { id: 'lab-t1', title: 'Trial', status: 'todo' }); // forces a commit (git add -A)
  assert.match(fs.readFileSync(path.join(f.root, '.gitignore'), 'utf8'), /^lab-control\.json$/m);
  assert.ok(fs.existsSync(path.join(f.root, '.git')));
  const tracked = execFileSync('git', ['ls-files'], { cwd: f.root, encoding: 'utf8' });
  assert.ok(tracked.includes('tasks.json'));
  assert.ok(!tracked.includes('lab-control.json'), 'the token never enters history');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.root, 'lab-control.json')).mode & 0o777, 0o600);
});

test('lab agents register over the API: registry row (provider lab), dirs, a floor card without a PTY, not an orphan', async (t) => {
  const f = floor(t, { env: { MD_LAB_CONTROL: '1' } });
  await f.host.start();
  const { call } = clientFromControlFile(f.root);
  const res = await call('POST', '/lab/agents', { id: 'lab-e1', name: 'Kevin', role: 'Trial Executor', character: 'kevin', accent: 'sky' });
  assert.equal(res.status, 200);
  const entry = f.hive.registry().agents['lab-e1'];
  assert.equal(entry.provider, 'lab');
  assert.equal(entry.name, 'Kevin');
  assert.equal(entry.archived, false);
  assert.ok(fs.existsSync(path.join(f.root, 'agents', 'lab-e1', 'outbox', '.sent')));
  assert.ok(fs.existsSync(path.join(f.root, 'agents', 'lab-e1', 'memory.md')));
  const spawned = sent(f.sends, 'hive:agentSpawned');
  assert.equal(spawned.length, 1);
  assert.deepEqual([spawned[0].id, spawned[0].provider, spawned[0].ptyless, spawned[0].character], ['lab-e1', 'lab', true, 'kevin']);
  const reg = f.hive.registry();
  assert.deepEqual(selectOrphansToArchive(reg.agents, reg.godId, () => false), []);
  // re-registering is an update, not a duplicate
  await call('POST', '/lab/agents', { id: 'lab-e1', name: 'Kevin', role: 'Trial Executor (updated)' });
  assert.equal(f.hive.registry().agents['lab-e1'].role, 'Trial Executor (updated)');
});

test('tasks go through the app\'s merge-safe writers: foreign cards and fields survive, upsert keeps createdAt', async (t) => {
  const f = floor(t, { env: { MD_LAB_CONTROL: '1' } });
  await f.host.start();
  f.hive.addTask({ id: 'human-1', title: 'A human card', status: 'todo', dependsOn: [], priority: 2, createdAt: '2026-01-01T00:00:00.000Z', repo: 'keep-me' });
  const { call } = clientFromControlFile(f.root);
  await call('POST', '/lab/tasks', { id: 'lab-t1', title: 'Trial 1', status: 'doing', assignee: 'lab-e1', kind: 'experiment', createdAt: '2026-02-02T00:00:00.000Z' });
  await call('POST', '/lab/tasks', { id: 'lab-t1', title: 'Trial 1', status: 'done', result: '+10%', gain: 0.1 });
  await call('PATCH', '/lab/tasks/human-1', { priority: 1 });
  const list = f.hive.tasks().tasks;
  assert.deepEqual(list.map((c) => c.id), ['human-1', 'lab-t1']);
  assert.equal(list[0].repo, 'keep-me');
  assert.equal(list[0].priority, 1);
  assert.equal(list[1].status, 'done');
  assert.equal(list[1].createdAt, '2026-02-02T00:00:00.000Z');
  assert.equal(list[1].kind, 'experiment');
  assert.equal(list[1].gain, 0.1);
  assert.equal((await call('DELETE', '/lab/tasks/lab-t1')).status, 200);
  assert.deepEqual(f.hive.tasks().tasks.map((c) => c.id), ['human-1']);
});

test('messages are routed by the app: into the recipient inbox (no terminal handoff), logged, hop-capped', async (t) => {
  const f = floor(t, { env: { MD_LAB_CONTROL: '1' } });
  await f.host.start();
  const { call } = clientFromControlFile(f.root);
  await call('POST', '/lab/agents', { id: 'lab-e1', name: 'Kevin', role: 'Trial Executor' });
  const a = await call('POST', '/lab/messages', { from: 'lab-e1', to: 'god', act: 'propose', subject: 'Plan', body: 'p' });
  const b = await call('POST', '/lab/messages', { from: 'god', to: 'lab-e1', act: 'request', subject: 'Run trial', body: 'go' });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  // delivered by the router into each recipient's inbox, then acknowledged by the app (the files are kept in inbox/.done for audit)
  const doneOf = (id) => fs.readdirSync(path.join(f.root, 'agents', id, 'inbox', '.done')).map((n) => JSON.parse(fs.readFileSync(path.join(f.root, 'agents', id, 'inbox', '.done', n), 'utf8')));
  assert.deepEqual(doneOf('god').map((m) => m.subject), ['Plan']);
  assert.deepEqual(doneOf('lab-e1').map((m) => m.subject), ['Run trial']);
  assert.equal(f.hive.inbox('lab-e1').length, 0);
  assert.equal(sent(f.sends, 'hive:terminalHandoff').length, 0, 'a lab agent has no terminal to hand work to');
  const log = f.hive.logTail(50).filter((e) => e.kind === 'message');
  assert.equal(log.length, 2);
  assert.deepEqual(log[1].delivered, ['lab-e1']);
  // past the hop cap the app drops it, exactly as for any agent
  await call('POST', '/lab/messages', { from: 'god', to: 'lab-e1', act: 'inform', subject: 'loop', hops: 99 });
});

test('lab agents\' identity/memory sections are written by the app, and only for lab agents; their mail is acknowledged', async (t) => {
  const f = floor(t, { env: { MD_LAB_CONTROL: '1' } });
  await f.host.start();
  const { call } = clientFromControlFile(f.root);
  await call('POST', '/lab/agents', { id: 'lab-e1', name: 'Kevin', role: 'Trial Executor' });
  assert.equal((await call('POST', '/lab/agent-files', { agentId: 'lab-e1', file: 'memory', markdown: '## Lab memory\n- noted' })).status, 200);
  assert.equal((await call('POST', '/lab/agent-files', { agentId: 'lab-e1', file: 'memory', markdown: '## Lab memory\n- noted again' })).status, 200);
  const memory = fs.readFileSync(path.join(f.root, 'agents', 'lab-e1', 'memory.md'), 'utf8');
  assert.match(memory, /^# Memory — Kevin \(lab-e1\)/, 'the app\'s own header is kept');
  assert.match(memory, /noted again/);
  assert.ok(!memory.includes('- noted\n'), 'the section was replaced, not appended twice');
  // a human agent (not lab) is refused: the lab can never write into another agent's directory
  fs.mkdirSync(path.join(f.root, 'agents', 'pam'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'agents', 'pam', 'memory.md'), 'Pam remembers.\n');
  const reg = f.hive.registry(); reg.agents.pam = { id: 'pam', name: 'Pam', provider: 'claude', role: 'x', cwd: '/x', status: 'idle', lastSeen: 1 };
  fs.writeFileSync(path.join(f.root, 'registry.json'), JSON.stringify(reg));
  assert.equal((await call('POST', '/lab/agent-files', { agentId: 'pam', file: 'memory', markdown: 'hijack' })).status, 403);
  assert.equal(fs.readFileSync(path.join(f.root, 'agents', 'pam', 'memory.md'), 'utf8'), 'Pam remembers.\n');
  assert.equal((await call('POST', '/lab/agent-files', { agentId: 'ghost', file: 'memory', markdown: 'x' })).status, 403);
  // mail: delivered into the inbox by the router, then acknowledged by the app (inbox/.done, cursor advanced)
  await call('POST', '/lab/messages', { from: 'god', to: 'lab-e1', act: 'request', subject: 'Run trial', body: 'go' });
  assert.equal(f.hive.inbox('lab-e1').length, 0, 'no backlog builds up for an agent nobody can wake');
  const done = fs.readdirSync(path.join(f.root, 'agents', 'lab-e1', 'inbox', '.done'));
  assert.equal(done.length, 1);
  const cursor = JSON.parse(fs.readFileSync(path.join(f.root, 'agents', 'lab-e1', 'cursor.json'), 'utf8'));
  assert.equal(cursor.lastProcessed, done[0].replace(/\.json$/, ''));
  // a non-lab agent's mail is NOT touched by the acknowledgement
  fs.mkdirSync(path.join(f.root, 'agents', 'pam', 'inbox'), { recursive: true });
  await call('POST', '/lab/messages', { from: 'god', to: 'pam', act: 'inform', subject: 'hi', body: 'b' });
  assert.equal(f.hive.inbox('pam').length, 1);
});

test('status and context drive the avatar and gauge; cost lands in the ledger as cumulative rows and on the telemetry channel', async (t) => {
  const f = floor(t, { env: { MD_LAB_CONTROL: '1' } });
  await f.host.start();
  const { call } = clientFromControlFile(f.root);
  await call('POST', '/lab/agents', { id: 'lab-e1', name: 'Kevin', role: 'Trial Executor' });
  await call('POST', '/lab/status', { agentId: 'lab-e1', event: 'PreToolUse', tool: 'Bash', context: { tokens: 50000, limit: 200000 } });
  await call('POST', '/lab/status', { agentId: 'lab-e1', event: 'Stop' });
  const hooks = sent(f.sends, 'hive:hookEvent');
  assert.deepEqual(hooks.map((h) => [h.agentId, h.event, h.tool]), [['lab-e1', 'PreToolUse', 'Bash'], ['lab-e1', 'Stop', undefined]]);
  assert.deepEqual(sent(f.sends, 'hive:contextUpdate'), [{ agentId: 'lab-e1', tokens: 50000, limit: 200000 }]);
  // a gauge-only report moves the gauge and produces NO avatar event (it used to read as an idle Notification)
  await call('POST', '/lab/status', { agentId: 'lab-e1', context: { tokens: 60000, limit: 200000 } });
  assert.equal(sent(f.sends, 'hive:hookEvent').length, 2);
  assert.equal(sent(f.sends, 'hive:contextUpdate').length, 2);

  await call('POST', '/lab/cost', { agentId: 'lab-e1', sessionId: 's1', model: 'claude-opus-4-8', input: 1000, output: 200, usd: 0.25 });
  await call('POST', '/lab/cost', { agentId: 'lab-e1', sessionId: 's1', model: 'claude-opus-4-8', input: 500, output: 100 });
  const rows = fs.readFileSync(path.join(f.root, 'cost-ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].agent_id, 'lab-e1');
  assert.equal(rows[0].usd, 0.25);
  assert.equal(rows[1].input, 1500);
  assert.ok(rows[1].usd > 0.25, 'cumulative: the second row includes the first');
  const usage = sent(f.sends, 'telemetry:event').filter((e) => e.kind === 'usage');
  assert.equal(usage.length, 2);
  assert.equal(usage[1].sample.usd, rows[1].usd);
});

test('board sections replace only their own fenced block of board.md', async (t) => {
  const f = floor(t, { env: { MD_LAB_CONTROL: '1' } });
  await f.host.start();
  fs.appendFileSync(path.join(f.root, 'board.md'), '\nHuman note: do not touch me.\n');
  const { call } = clientFromControlFile(f.root);
  assert.equal((await call('POST', '/lab/board', { section: 'lab-board', markdown: '## Round 1' })).json.changed, true);
  assert.equal((await call('POST', '/lab/board', { section: 'lab-board', markdown: '## Round 1' })).json.changed, false);
  await call('POST', '/lab/board', { section: 'lab-board', markdown: '## Round 2' });
  const board = fs.readFileSync(path.join(f.root, 'board.md'), 'utf8');
  assert.match(board, /Human note: do not touch me\./);
  assert.match(board, /## Round 2/);
  assert.ok(!board.includes('## Round 1'));
  assert.equal(board.split('hive-bridge:lab-board:begin').length - 1, 1);
});

test('human gates: blocked card with a question in tasks.json; approve through the host resumes it', async (t) => {
  const f = floor(t, { env: { MD_LAB_CONTROL: '1' } });
  await f.host.start();
  const { call } = clientFromControlFile(f.root);
  await call('POST', '/lab/gate', { id: 'viol-1', kind: 'violation', title: 'Invariant violation', question: '**A sealed term reached a prompt.** Accept the run?' });
  const card = f.hive.tasks().tasks.find((c) => c.id === 'lab-gate-viol-1');
  assert.equal(card.status, 'blocked');
  assert.equal(card.humanQA[0].q.startsWith('**A sealed term'), true);
  assert.equal(f.host.state().pendingGates, 1);
  assert.equal(f.host.approve(undefined, 'accepted by the human'), 1);
  const after = f.hive.tasks().tasks.find((c) => c.id === 'lab-gate-viol-1');
  assert.equal(after.status, 'done');
  assert.equal(after.humanQA[0].a, 'accepted by the human');
  assert.equal(f.host.state().pendingGates, 0);
  assert.ok(sent(f.sends, 'lab:state').length >= 2, 'the panel is told about the gate and its approval');
});

test('progress snapshots reach the renderer channel and are readable back', async (t) => {
  const f = floor(t, { env: { MD_LAB_CONTROL: '1' } });
  await f.host.start();
  const { call } = clientFromControlFile(f.root);
  const snap = { schema: 'lab-v4-progress/1', round: 2, curve: [], reframes: [] };
  await call('POST', '/lab/progress', { snapshot: snap });
  assert.deepEqual(sent(f.sends, 'lab:progress'), [snap]);
  assert.deepEqual(f.host.progress(), snap);
});

test('stopping the host removes the control file; the registry keeps the seat (the next launch re-seats it)', async (t) => {
  const f = floor(t, { env: { MD_LAB_CONTROL: '1' } });
  await f.host.start();
  assert.ok(fs.existsSync(path.join(f.root, 'lab-control.json')));
  f.host.stop();
  assert.equal(fs.existsSync(path.join(f.root, 'lab-control.json')), false);
  assert.equal(f.hive.registry().godId, 'god');
});
