'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { LabControlServer, LAB_ROUTES, LAB_CONTROL_FILE } = loadTs('src/main/labControl.ts');
const { resolveLabMode } = loadTs('src/shared/labMode.ts');

/** In-memory stand-in for the hive: the control server only ever talks to it through LabControlDeps. */
function makeDeps(dir) {
  const calls = { send: [], status: [], cost: [], log: [], board: [], files: [], registered: [], states: [], progress: [], ignored: [] };
  const tasks = new Map();
  const deps = {
    hiveDir: () => dir,
    mode: () => resolveLabMode({ enabled: true }, {}),
    addTask: (t) => { if (tasks.has(t.id)) return false; tasks.set(t.id, { ...t }); return true; },
    patchTask: (id, p) => { if (!tasks.has(id)) return false; tasks.set(id, { ...tasks.get(id), ...p, id }); return true; },
    deleteTask: (id) => tasks.delete(id),
    getTask: (id) => (tasks.has(id) ? { ...tasks.get(id) } : null),
    send: (partial, from) => { calls.send.push({ partial, from }); return { id: `m${calls.send.length}` }; },
    registerAgent: (spec) => { calls.registered.push(spec); return { ok: true }; },
    status: (s) => calls.status.push(s),
    cost: (row) => calls.cost.push(row),
    priceUsd: (model, t) => (t.input + t.output) / 1e6,
    board: (section, md) => { calls.board.push({ section, md }); return true; },
    agentFile: (agentId, file, md) => { calls.files.push({ agentId, file, md }); return agentId.startsWith('lab-') ? { ok: true } : { ok: false, error: 'not a lab agent' }; },
    log: (e) => calls.log.push(e),
    onProgress: (s) => calls.progress.push(s),
    onState: (s) => calls.states.push(s),
    ignoreInGit: (n) => calls.ignored.push(n)
  };
  return { deps, calls, tasks };
}

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-control-'));
  const { deps, calls, tasks } = makeDeps(dir);
  const server = new LabControlServer(deps, { token: 'test-token-0123456789' });
  const started = await server.start();
  assert.equal(started.ok, true, started.error);
  const call = (method, p, body, { token = 'test-token-0123456789', headers = {}, raw } = {}) => new Promise((resolve, reject) => {
    const payload = raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body);
    const h = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
    if (payload !== undefined && !('content-type' in h)) h['content-type'] = 'application/json';
    if (payload !== undefined) h['content-length'] = Buffer.byteLength(payload);
    const r = http.request({ host: '127.0.0.1', port: server.boundPort(), method, path: p, headers: h }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
  return { dir, server, deps, calls, tasks, call, stop: () => server.stop() };
}

const card = (over = {}) => ({ id: 'lab-t1', title: 'Trial 1', status: 'todo', ...over });

test('start publishes lab-control.json (0600) with port and token, ignores it in git, and stop removes it', async () => {
  const lab = await boot();
  try {
    const file = path.join(lab.dir, LAB_CONTROL_FILE);
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(info.host, '127.0.0.1');
    assert.equal(info.port, lab.server.boundPort());
    assert.equal(info.token, 'test-token-0123456789');
    assert.equal(info.version, 1);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(lab.calls.ignored, [LAB_CONTROL_FILE]);
    assert.ok(lab.server.boundPort() > 0);
  } finally { lab.stop(); }
});

test('the default token is random per start and 256 bits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-control-'));
  const a = new LabControlServer(makeDeps(dir).deps);
  const b = new LabControlServer(makeDeps(dir).deps);
  assert.match(a.bearerToken(), /^[0-9a-f]{64}$/);
  assert.notEqual(a.bearerToken(), b.bearerToken());
});

test('stop removes the control file and closes the port', async () => {
  const lab = await boot();
  const file = path.join(lab.dir, LAB_CONTROL_FILE);
  assert.ok(fs.existsSync(file));
  lab.stop();
  assert.ok(!fs.existsSync(file));
  assert.equal(lab.server.listening(), false);
});

test('binds 127.0.0.1 only', async () => {
  const lab = await boot();
  try {
    assert.equal(lab.server.server.address().address, '127.0.0.1');
    // Not reachable on any non-loopback address of this machine.
    const external = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (external) {
      await assert.rejects(new Promise((resolve, reject) => {
        const s = require('node:net').connect({ host: external.address, port: lab.server.boundPort() }, () => { s.destroy(); resolve(); });
        s.on('error', reject);
      }));
    }
  } finally { lab.stop(); }
});

test('a peer that is not loopback is refused before anything else (even with the right token)', async () => {
  const lab = await boot();
  try {
    let status = 0; let body = '';
    const res = { setHeader() {}, writeHead(s) { status = s; }, end(b) { body = b; } };
    const req = { socket: { remoteAddress: '10.1.2.3' }, headers: { host: `127.0.0.1:${lab.server.boundPort()}`, authorization: 'Bearer test-token-0123456789' }, method: 'GET', url: '/lab/health', destroy() {} };
    lab.server.handle(req, res);
    assert.equal(status, 403);
    assert.match(body, /loopback/);
  } finally { lab.stop(); }
});

test('auth: no token, wrong token, wrong scheme and a prefix of the token are all 401; the right token is 200', async () => {
  const lab = await boot();
  try {
    assert.equal((await lab.call('GET', '/lab/health', undefined, { token: null })).status, 401);
    assert.equal((await lab.call('GET', '/lab/health', undefined, { token: 'wrong-token-0123456789x' })).status, 401);
    assert.equal((await lab.call('GET', '/lab/health', undefined, { token: 'test-token' })).status, 401);
    assert.equal((await lab.call('GET', '/lab/health', undefined, { token: null, headers: { authorization: 'Basic dGVzdC10b2tlbi0wMTIzNDU2Nzg5' } })).status, 401);
    const ok = await lab.call('GET', '/lab/health');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.version, 1);
    // an unauthenticated request never reaches a route, so a mutation cannot happen
    assert.equal((await lab.call('POST', '/lab/tasks', card(), { token: null })).status, 401);
    assert.equal(lab.tasks.size, 0);
  } finally { lab.stop(); }
});

test('a foreign Host header (DNS rebinding) or any Origin header (a browser) is refused', async () => {
  const lab = await boot();
  try {
    assert.equal((await lab.call('GET', '/lab/health', undefined, { headers: { host: 'evil.example:80' } })).status, 403);
    assert.equal((await lab.call('GET', '/lab/health', undefined, { headers: { origin: 'http://localhost:3000' } })).status, 403);
    assert.equal((await lab.call('GET', '/lab/health', undefined, { headers: { host: `localhost:${lab.server.boundPort()}` } })).status, 200);
  } finally { lab.stop(); }
});

test('transport errors: 404, 405, 415, 400 (bad json), 413 (too large)', async () => {
  const lab = await boot();
  try {
    assert.equal((await lab.call('GET', '/nope')).status, 404);
    assert.equal((await lab.call('GET', '/lab/../etc/passwd')).status, 404);
    assert.equal((await lab.call('PUT', '/lab/tasks', card())).status, 405);
    assert.equal((await lab.call('GET', '/lab/tasks')).status, 405);
    assert.equal((await lab.call('POST', '/lab/tasks', undefined, { raw: JSON.stringify(card()), headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await lab.call('POST', '/lab/tasks', undefined, { raw: '{not json' })).status, 400);
    const big = await lab.call('POST', '/lab/log', undefined, { raw: JSON.stringify({ kind: 'x', pad: 'a'.repeat(1024 * 1024 + 10) }) }).catch((e) => ({ status: e.code }));
    assert.ok(big.status === 413 || big.status === 'ECONNRESET' || big.status === 'EPIPE', String(big.status));
    assert.equal(lab.calls.log.filter((e) => e.kind === 'x').length, 0);
  } finally { lab.stop(); }
});

test('every route in the exported table is served (no 404 on a valid method)', async () => {
  const lab = await boot();
  try {
    for (const r of LAB_ROUTES) {
      const p = r.path.replace(':id', 'lab-t1');
      const res = await lab.call(r.method, p, r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
      // PATCH/DELETE of a card that does not exist answer 404 from the handler ("no card"), not from the router.
      if (res.status === 404) assert.match(res.json.error, /no card/, `${r.method} ${r.path}`);
      assert.notEqual(res.status, 405, `${r.method} ${r.path}`);
      assert.notEqual(res.status, 401, `${r.method} ${r.path}`);
    }
  } finally { lab.stop(); }
});

test('validation: a bad body is a 400 with a reason and has NO effect', async () => {
  const lab = await boot();
  try {
    const bad = async (p, body, method = 'POST') => {
      const res = await lab.call(method, p, body);
      assert.equal(res.status, 400, `${method} ${p} ${JSON.stringify(body)} -> ${res.status}`);
      assert.equal(res.json.ok, false);
      assert.ok(typeof res.json.error === 'string' && res.json.error.length > 0);
    };
    await bad('/lab/tasks', card({ status: 'finished' }));
    await bad('/lab/tasks', card({ id: '../escape' }));
    await bad('/lab/tasks', card({ title: '' }));
    await bad('/lab/tasks', card({ priority: 99 }));
    await bad('/lab/tasks', card({ dependsOn: ['ok', 'not ok/'] }));
    await bad('/lab/tasks', JSON.parse('{"id":"lab-x","title":"t","status":"todo","__proto__":{"x":1}}'));
    await bad('/lab/tasks', card({ weird: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } }));
    await bad('/lab/tasks/lab-t1', {}, 'PATCH');
    await bad('/lab/tasks/lab-t1', { id: 'other' }, 'PATCH');
    await bad('/lab/messages', { from: 'a', to: 'b', act: 'shout', subject: 's' });
    await bad('/lab/messages', { from: '../a', to: 'b', act: 'inform', subject: 's' });
    await bad('/lab/agents', { id: 'lab-e1', name: '' });
    await bad('/lab/agents', { id: 'lab-e1', name: 'Kevin', isGod: true });
    await bad('/lab/agents', { id: 'lab-e1', name: 'Kevin', accent: 'puce' });
    await bad('/lab/status', { agentId: 'lab-e1', event: 'Explode' });
    await bad('/lab/status', { agentId: 'lab-e1', context: { tokens: -1, limit: 10 } });
    await bad('/lab/status', { agentId: 'lab-e1', context: { tokens: 5, limit: 0 } });
    await bad('/lab/cost', { agentId: 'lab-e1', model: 'm' });
    await bad('/lab/cost', { agentId: 'lab-e1', model: 'm', input: 'many' });
    await bad('/lab/cost', { agentId: 'lab-e1', model: 'm', input: Infinity });
    await bad('/lab/progress', { schema: 'something-else/1' });
    await bad('/lab/progress', { schema: 'lab-v4-progress/1', curve: 'nope' });
    await bad('/lab/board', { section: 'Bad Section!', markdown: 'x' });
    await bad('/lab/agent-files', { agentId: 'lab-e1', file: 'passwd', markdown: 'x' });
    await bad('/lab/agent-files', { agentId: '../x', file: 'memory', markdown: 'x' });
    await bad('/lab/log', { kind: 'Not A Slug' });
    await bad('/lab/gate', { id: 'g1', title: 't' });
    await bad('/lab/gate', { id: 'g1', kind: 'mystery', title: 't', question: 'q' });
    await bad('/lab/approve', { gateId: 'a b' });
    await bad('/lab/start', { campaign: 5 });
    await bad('/lab/pause', { paused: 'yes' });
    assert.equal(lab.tasks.size, 0);
    assert.equal(lab.calls.send.length, 0);
    assert.equal(lab.calls.registered.length, 0);
    assert.equal(lab.calls.status.length, 0);
    assert.equal(lab.calls.cost.length, 0);
    assert.equal(lab.calls.board.length, 0);
    assert.equal(lab.calls.files.length, 0);
    assert.equal(lab.calls.progress.length, 0);
  } finally { lab.stop(); }
});

test('tasks: add is an upsert that keeps createdAt, patch and delete work, a missing card is 404', async () => {
  const lab = await boot();
  try {
    const first = await lab.call('POST', '/lab/tasks', card({ createdAt: '2026-01-01T00:00:00.000Z', gain: 0.1, kind: 'experiment' }));
    assert.deepEqual([first.status, first.json.created], [200, true]);
    const again = await lab.call('POST', '/lab/tasks', { task: card({ status: 'doing', createdAt: '2030-01-01T00:00:00.000Z' }) });
    assert.deepEqual([again.status, again.json.created], [200, false]);
    assert.equal(lab.tasks.get('lab-t1').status, 'doing');
    assert.equal(lab.tasks.get('lab-t1').createdAt, '2026-01-01T00:00:00.000Z', 'the card keeps its first-seen date');
    assert.equal(lab.tasks.get('lab-t1').gain, 0.1, 'fields the update does not mention stay');
    assert.equal((await lab.call('PATCH', '/lab/tasks/lab-t1', { patch: { status: 'done', result: 'ok' } })).status, 200);
    assert.equal(lab.tasks.get('lab-t1').result, 'ok');
    assert.equal((await lab.call('PATCH', '/lab/tasks/nope', { status: 'done' })).status, 404);
    assert.equal((await lab.call('DELETE', '/lab/tasks/lab-t1')).status, 200);
    assert.equal((await lab.call('DELETE', '/lab/tasks/lab-t1')).status, 404);
    assert.equal(lab.tasks.size, 0);
  } finally { lab.stop(); }
});

test('messages, agents, status, board and log reach their callbacks with clean values', async () => {
  const lab = await boot();
  try {
    const m = await lab.call('POST', '/lab/messages', { from: 'lab-e1', to: 'god', act: 'request', subject: 'Run trial', body: 'b', hops: 1, extra: 'dropped' });
    assert.equal(m.status, 200);
    assert.equal(lab.calls.send[0].from, 'lab-e1');
    assert.equal(lab.calls.send[0].partial.act, 'request');
    assert.equal('extra' in lab.calls.send[0].partial, false);
    const a = await lab.call('POST', '/lab/agents', { id: 'lab-e1', name: 'Kevin', role: 'Trial Executor', character: 'Kevin', accent: 'sky' });
    assert.equal(a.status, 200);
    assert.deepEqual(lab.calls.registered[0], { id: 'lab-e1', name: 'Kevin', role: 'Trial Executor', character: 'kevin', accent: 'sky', model: undefined, capabilities: [], isGod: false });
    await lab.call('POST', '/lab/agents', { id: 'god', name: 'Dwight', role: 'Lab orchestrator (Opus)', isGod: true });
    assert.equal(lab.calls.registered[1].isGod, true);
    assert.equal((await lab.call('POST', '/lab/status', { agentId: 'lab-e1', event: 'PreToolUse', tool: 'Bash', context: { tokens: 1000, limit: 200000 } })).status, 200);
    assert.deepEqual(lab.calls.status[0], { agentId: 'lab-e1', event: 'PreToolUse', tool: 'Bash', context: { tokens: 1000, limit: 200000 } });
    assert.equal((await lab.call('POST', '/lab/board', { section: 'lab-board', markdown: '## Board' })).json.changed, true);
    assert.deepEqual(lab.calls.board[0], { section: 'lab-board', md: '## Board' });
    assert.equal((await lab.call('POST', '/lab/agent-files', { agentId: 'lab-e1', file: 'memory', markdown: '## Notes' })).status, 200);
    assert.deepEqual(lab.calls.files[0], { agentId: 'lab-e1', file: 'memory', md: '## Notes' });
    assert.equal((await lab.call('POST', '/lab/agent-files', { agentId: 'pam', file: 'memory', markdown: 'x' })).status, 403, 'only lab agents');
    assert.equal((await lab.call('POST', '/lab/log', { kind: 'lab-event', type: 'round' })).status, 200);
    assert.ok(lab.calls.log.some((e) => e.kind === 'lab-event' && e.type === 'round'));
  } finally { lab.stop(); }
});

test('cost samples fold into CUMULATIVE rows per (agent, session); a stated usd beats the priced estimate', async () => {
  const lab = await boot();
  try {
    await lab.call('POST', '/lab/cost', { agentId: 'lab-e1', sessionId: 's1', model: 'claude-opus-4-8', input: 1000, output: 500 });
    const second = await lab.call('POST', '/lab/cost', { agentId: 'lab-e1', sessionId: 's1', model: 'claude-opus-4-8', input: 2000, output: 100, cacheRead: 7, usd: 0.5 });
    assert.equal(second.status, 200);
    const [r1, r2] = lab.calls.cost;
    assert.equal(r1.usd, 0.0015, 'priced from tokens by the injected pricer');
    assert.deepEqual([r2.input, r2.output, r2.cacheRead], [3000, 600, 7]);
    assert.equal(r2.usd, 0.5015, 'cumulative: 0.0015 + 0.5');
    await lab.call('POST', '/lab/cost', { agentId: 'lab-e1', sessionId: 's2', model: 'm', input: 10 });
    assert.equal(lab.calls.cost[2].input, 10, 'another session starts its own counter');
    await lab.call('POST', '/lab/cost', { agentId: 'lab-r1', model: 'm', usd: 0.25 });
    assert.equal(lab.calls.cost[3].usd, 0.25);
  } finally { lab.stop(); }
});

test('progress snapshots are stored, pushed to the observer and served back', async () => {
  const lab = await boot();
  try {
    assert.equal((await lab.call('GET', '/lab/progress')).json.snapshot, null);
    const snap = { schema: 'lab-v4-progress/1', round: 3, curve: [{ trial: 1, bestGain: 0.1 }], reframes: [], ruledOut: [], violations: [] };
    assert.equal((await lab.call('POST', '/lab/progress', { snapshot: snap })).json.round, 3);
    assert.deepEqual((await lab.call('GET', '/lab/progress')).json.snapshot, snap);
    assert.equal(lab.calls.progress.length, 1);
    assert.equal(lab.calls.states.at(-1).progressRound, 3);
  } finally { lab.stop(); }
});

test('lab verbs: start, pause, resume change the phase and notify the app', async () => {
  const lab = await boot();
  try {
    assert.equal((await lab.call('GET', '/lab/state')).json.state.phase, 'idle');
    assert.equal((await lab.call('POST', '/lab/start', { campaign: 'ibex' })).json.state.phase, 'running');
    assert.equal((await lab.call('GET', '/lab/state')).json.state.campaign, 'ibex');
    assert.equal((await lab.call('POST', '/lab/pause', {})).json.state.phase, 'paused');
    assert.equal((await lab.call('POST', '/lab/pause', { paused: false })).json.state.phase, 'running');
    const st = (await lab.call('GET', '/lab/state')).json.state;
    assert.equal(st.god.name, 'Dwight');
    assert.deepEqual(lab.calls.states.map((s) => s.phase).slice(-3), ['running', 'paused', 'running']);
    assert.equal((await lab.call('POST', '/lab/finish', {})).json.state.phase, 'idle');
    assert.equal(lab.calls.states.at(-1).phase, 'idle');
  } finally { lab.stop(); }
});

test('human gates: a gate is a blocked card with a question; approve resumes it; raising twice is idempotent', async () => {
  const lab = await boot();
  try {
    const raised = await lab.call('POST', '/lab/gate', { id: 'budget-1', kind: 'budget-stop', title: 'Budget stop', question: '**Budget exhausted.** Continue?' });
    assert.equal(raised.status, 200);
    const c = lab.tasks.get('lab-gate-budget-1');
    assert.equal(c.status, 'blocked');
    assert.equal(c.assignee, 'god');
    assert.equal(c.priority, 1);
    assert.equal(c.humanQA.length, 1);
    assert.equal(c.humanQA[0].q, '**Budget exhausted.** Continue?');
    assert.equal(c.humanQA[0].a, undefined, 'unanswered: it lands on the ASK ME board');
    await lab.call('POST', '/lab/gate', { id: 'budget-1', kind: 'budget-stop', title: 'Budget stop', question: 'again' });
    assert.equal(lab.tasks.get('lab-gate-budget-1').humanQA.length, 1, 'idempotent');
    let st = (await lab.call('GET', '/lab/state')).json.state;
    assert.equal(st.pendingGates, 1);
    assert.equal(st.gates[0].status, 'pending');

    assert.equal((await lab.call('POST', '/lab/approve', { gateId: 'nope' })).status, 404);
    const ap = await lab.call('POST', '/lab/approve', { gateId: 'budget-1', answer: 'continue, +$5' });
    assert.deepEqual(ap.json.approved, ['budget-1']);
    const done = lab.tasks.get('lab-gate-budget-1');
    assert.equal(done.status, 'done');
    assert.equal(done.humanQA[0].a, 'continue, +$5');
    assert.ok(done.humanQA[0].answeredAt);
    assert.match(done.result, /Approved/);
    st = (await lab.call('GET', '/lab/state')).json.state;
    assert.equal(st.pendingGates, 0);
    assert.equal(st.gates[0].status, 'approved');
    assert.equal(st.gates[0].answer, 'continue, +$5');
    assert.equal(lab.calls.send.at(-1).from, 'human', 'an approval note is routed as the human');
    // a gate that is already approved stays approved when the lab re-raises it
    await lab.call('POST', '/lab/gate', { id: 'budget-1', kind: 'budget-stop', title: 'Budget stop', question: 'again' });
    assert.equal(lab.tasks.get('lab-gate-budget-1').status, 'done');
  } finally { lab.stop(); }
});

test('a gate on an EXISTING card (an invariant violation) reuses it; approve without a gateId approves every pending gate', async () => {
  const lab = await boot();
  try {
    await lab.call('POST', '/lab/tasks', card({ id: 'lab-violation-ab12', title: 'Violation: sealed label', status: 'blocked', kind: 'violation' }));
    await lab.call('POST', '/lab/gate', { id: 'v1', kind: 'violation', cardId: 'lab-violation-ab12', title: 'Violation', question: 'A sealed term reached a prompt. Accept?' });
    await lab.call('POST', '/lab/gate', { id: 'b1', kind: 'budget-stop', title: 'Budget', question: 'Continue?' });
    const v = lab.tasks.get('lab-violation-ab12');
    assert.equal(v.kind, 'violation');
    assert.equal(v.humanQA.length, 1);
    const ap = await lab.call('POST', '/lab/approve', {});
    assert.deepEqual(ap.json.approved.sort(), ['b1', 'v1']);
    assert.equal(lab.tasks.get('lab-violation-ab12').status, 'done');
    assert.equal(lab.tasks.get('lab-gate-b1').status, 'done');
  } finally { lab.stop(); }
});

test('a human who answers the card on the ASK ME board has approved the gate too', async () => {
  const lab = await boot();
  try {
    await lab.call('POST', '/lab/gate', { id: 'g9', kind: 'other', title: 'T', question: 'Q?' });
    // what AskMeTab does: fills humanQA[].a through hive:patchTask and leaves the card blocked
    lab.deps.patchTask('lab-gate-g9', { humanQA: [{ q: 'Q?', a: 'yes go', answeredAt: new Date().toISOString() }] });
    const st = (await lab.call('GET', '/lab/state')).json.state;
    assert.equal(st.gates[0].status, 'approved');
    assert.equal(st.gates[0].answer, 'yes go');
    assert.equal(lab.tasks.get('lab-gate-g9').status, 'done', 'the card leaves the blocked column');
  } finally { lab.stop(); }
});

test('start fails cleanly without a hive directory', async () => {
  const { deps } = makeDeps(null);
  const server = new LabControlServer(deps);
  const r = await server.start();
  assert.equal(r.ok, false);
  assert.equal(server.listening(), false);
});
