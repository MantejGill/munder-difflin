/**
 * LabControlServer: the loopback-only control plane that lets a research lab drive the office.
 *
 * Modelled on webhook.ts: ONE small HTTP server, transport + auth + validation here, and every effect injected as a
 * callback (`LabControlDeps`) because the effects need the hive, which lives in the main entrypoint. It therefore has no
 * `electron` import and loads as a plain Node module for tests.
 *
 * Off unless lab mode is enabled (config `lab.enabled` or MD_LAB_CONTROL=1, see shared/labMode.ts). When on, the app is the
 * single writer of the shared hive files the lab touches (registry, tasks.json, messages, log, board): the lab calls these
 * endpoints instead of writing the files itself, and the existing merge-safe hive writers do the work.
 *
 * SECURITY (this is a LOCAL control surface, not a public one; there is no tunnel):
 *   - binds 127.0.0.1 only, on a random port; a connection whose peer is not loopback is refused,
 *   - every request needs `Authorization: Bearer <token>` (constant-time compare). The token is minted per start and written,
 *     with the port, to `<hive>/lab-control.json` (mode 0600, gitignored); that file is the only way to learn it,
 *   - the Host header must name the loopback address and port we serve (DNS-rebinding), and a request carrying an Origin
 *     header is refused (a browser page cannot talk to this API, however it got the token),
 *   - JSON bodies only, capped at 1 MiB, every field validated (shared/labControlProtocol.ts) before any effect,
 *   - a global fixed-window rate limit bounds a runaway local client.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LabMode } from '../shared/labMode';
import {
  validateAgentSpec, validateApprove, validateBoard, validateCost, validateGate, validateLog, validateMessage,
  validatePause, validateProgress, validateStart, validateStatus, validateTask, validateTaskPatch,
  type LabAgentSpec, type LabCost, type LabStatus, type Validated
} from '../shared/labControlProtocol';

export const LAB_CONTROL_FILE = 'lab-control.json';
export const LAB_CONTROL_VERSION = 1;

/** Reject bodies larger than this before parsing. */
const MAX_BODY_BYTES = 1024 * 1024;
/** Fixed-window request cap (per minute). A busy campaign posts a handful of requests per event. */
const RATE_LIMIT = 12_000;
const RATE_WINDOW_MS = 60_000;

/** The route table. The contract tests (and any stub) are generated from this, so it is the single list of endpoints. */
export const LAB_ROUTES: ReadonlyArray<{ method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string; summary: string }> = [
  { method: 'GET', path: '/lab/health', summary: 'liveness and protocol version' },
  { method: 'GET', path: '/lab/state', summary: 'phase, god seat, gates' },
  { method: 'POST', path: '/lab/start', summary: 'campaign started' },
  { method: 'POST', path: '/lab/pause', summary: 'pause or resume' },
  { method: 'POST', path: '/lab/approve', summary: 'approve a human gate (all pending when no gateId)' },
  { method: 'POST', path: '/lab/gate', summary: 'raise a human gate: a blocked card with a question' },
  { method: 'POST', path: '/lab/agents', summary: 'register (upsert) a lab agent' },
  { method: 'POST', path: '/lab/tasks', summary: 'add or update a card' },
  { method: 'PATCH', path: '/lab/tasks/:id', summary: 'patch a card' },
  { method: 'DELETE', path: '/lab/tasks/:id', summary: 'delete a card' },
  { method: 'POST', path: '/lab/messages', summary: 'send a hive message (routed and logged by the app)' },
  { method: 'POST', path: '/lab/status', summary: 'avatar status / tool use / context gauge' },
  { method: 'POST', path: '/lab/cost', summary: 'cost sample of one model call' },
  { method: 'POST', path: '/lab/progress', summary: 'a lab-v4-progress/1 snapshot' },
  { method: 'GET', path: '/lab/progress', summary: 'the latest snapshot' },
  { method: 'POST', path: '/lab/board', summary: 'replace one managed section of board.md' },
  { method: 'POST', path: '/lab/log', summary: 'append an event to log.jsonl' }
];

export type LabPhase = 'idle' | 'running' | 'paused';

export interface LabGateState {
  id: string;
  kind: string;
  title: string;
  question: string;
  cardId: string;
  status: 'pending' | 'approved';
  raisedAt: string;
  answer?: string;
  approvedAt?: string;
}

export interface LabStateView {
  phase: LabPhase;
  campaign: string | null;
  startedAt: string | null;
  god: { id: string; name: string; role: string; prompt: string };
  gates: LabGateState[];
  pendingGates: number;
  progressRound: number | null;
}

/** A cumulative cost row for one agent (what the ledger and the cost gauge want). */
export interface LabCostRow {
  agentId: string;
  sessionId: string;
  ts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  model: string;
  usd: number;
}

type Card = Record<string, unknown>;

export interface LabControlDeps {
  /** The hive directory (where lab-control.json goes), or null when there is no hive. */
  hiveDir: () => string | null;
  mode: () => LabMode;
  /** Idempotent by id: returns false when the card already exists. */
  addTask: (task: Card & { id: string }) => boolean;
  patchTask: (id: string, patch: Card) => boolean;
  deleteTask: (id: string) => boolean;
  getTask: (id: string) => Card | null;
  send: (partial: Card, from: string) => { id: string };
  registerAgent: (spec: LabAgentSpec) => { ok: boolean; error?: string };
  /** Drive an avatar: the same payload a hook frame produces. */
  status: (s: LabStatus) => void;
  /** Append a ledger row and publish the usage sample to the cost gauge. `row` is CUMULATIVE for the agent. */
  cost: (row: LabCostRow) => void;
  /** Price tokens when the caller did not supply a dollar figure. */
  priceUsd?: (model: string, tokens: { input: number; output: number; cacheRead: number; cacheCreation: number }) => number;
  board: (section: string, markdown: string) => boolean;
  log: (event: Record<string, unknown>) => void;
  /** Called with each accepted snapshot (the app pushes it to the renderer and may persist it). */
  onProgress?: (snapshot: Record<string, unknown>) => void;
  /** Called whenever phase or gates change. */
  onState?: (state: LabStateView) => void;
  /** Make sure `name` is excluded from the hive's git repo (the control file holds a token). */
  ignoreInGit?: (name: string) => void;
}

export interface LabControlOptions {
  /** Test seam: fixed token. */
  token?: string;
  /** Port to bind (default 0 = random). */
  port?: number;
  now?: () => number;
}

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || /^127\.\d+\.\d+\.\d+$/.test(addr);
}

export class LabControlServer {
  private server: Server | null = null;
  private port = 0;
  private token: string;
  private readonly now: () => number;
  private readonly wantedPort: number;
  private phase: LabPhase = 'idle';
  private campaign: string | null = null;
  private startedAt: string | null = null;
  private progress: Record<string, unknown> | null = null;
  private readonly gates = new Map<string, LabGateState>();
  private readonly cumulative = new Map<string, LabCostRow>();
  private window = { start: 0, count: 0 };

  constructor(private readonly deps: LabControlDeps, opts: LabControlOptions = {}) {
    this.token = opts.token ?? randomBytes(32).toString('hex');
    this.now = opts.now ?? Date.now;
    this.wantedPort = opts.port ?? 0;
  }

  listening(): boolean { return this.server != null; }
  boundPort(): number { return this.port; }
  /** For tests and the in-process owner only; never logged or sent over IPC. */
  bearerToken(): string { return this.token; }

  /** Bind 127.0.0.1 and publish `<hive>/lab-control.json` (0600). */
  async start(): Promise<{ ok: boolean; port?: number; error?: string }> {
    if (this.server) return { ok: true, port: this.port };
    const dir = this.deps.hiveDir();
    if (!dir) return { ok: false, error: 'no hive directory' };
    try {
      await new Promise<void>((resolve, reject) => {
        const server = createServer((req, res) => this.handle(req, res));
        server.once('error', reject);
        server.listen(this.wantedPort, '127.0.0.1', () => {
          server.off('error', reject);
          const addr = server.address();
          this.port = typeof addr === 'object' && addr ? addr.port : 0;
          this.server = server;
          resolve();
        });
      });
    } catch (e) {
      return { ok: false, error: `failed to bind: ${e instanceof Error ? e.message : String(e)}` };
    }
    try {
      this.writeControlFile(dir);
    } catch (e) {
      this.stop();
      return { ok: false, error: `could not write ${LAB_CONTROL_FILE}: ${e instanceof Error ? e.message : String(e)}` };
    }
    this.deps.log({ kind: 'lab-control-start', port: this.port });
    return { ok: true, port: this.port };
  }

  stop(): void {
    const dir = this.deps.hiveDir();
    try { this.server?.close(); } catch { /* noop */ }
    this.server = null;
    this.port = 0;
    if (dir) { try { rmSync(join(dir, LAB_CONTROL_FILE), { force: true }); } catch { /* noop */ } }
  }

  private writeControlFile(dir: string): void {
    mkdirSync(dir, { recursive: true });
    this.deps.ignoreInGit?.(LAB_CONTROL_FILE);
    const file = join(dir, LAB_CONTROL_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    const body = JSON.stringify({
      version: LAB_CONTROL_VERSION,
      host: '127.0.0.1',
      port: this.port,
      url: `http://127.0.0.1:${this.port}`,
      token: this.token,
      pid: process.pid,
      startedAt: new Date(this.now()).toISOString()
    }, null, 2) + '\n';
    writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* not supported on this platform */ }
    renameSync(tmp, file);
  }

  // ─── state ────────────────────────────────────────────────────────────────

  /** Resolve each gate against its card: a human who answered it on the ASK ME board has approved it too. */
  private syncGates(): void {
    for (const g of this.gates.values()) {
      if (g.status === 'approved') continue;
      const card = this.deps.getTask(g.cardId);
      if (!card) continue;
      const qa = Array.isArray(card.humanQA) ? (card.humanQA as Array<Record<string, unknown>>) : [];
      const answered = [...qa].reverse().find((e) => typeof e?.a === 'string' && e.a);
      const dismissed = qa.length > 0 && qa.every((e) => !!e?.a || !!e?.dismissedAt);
      if (card.status === 'done' || answered || dismissed) {
        g.status = 'approved';
        g.answer = typeof answered?.a === 'string' ? (answered.a as string) : 'resolved on the board';
        g.approvedAt = new Date(this.now()).toISOString();
        if (card.status === 'blocked') this.deps.patchTask(g.cardId, { status: 'done', result: `Resolved: ${g.answer}` });
      }
    }
  }

  view(): LabStateView {
    this.syncGates();
    const m = this.deps.mode();
    const gates = [...this.gates.values()].map((g) => ({ ...g }));
    const round = this.progress && typeof this.progress.round === 'number' ? (this.progress.round as number) : null;
    return {
      phase: this.phase,
      campaign: this.campaign,
      startedAt: this.startedAt,
      god: { id: m.godId, name: m.godName, role: m.godRole, prompt: m.godPrompt },
      gates,
      pendingGates: gates.filter((g) => g.status === 'pending').length,
      progressRound: round
    };
  }

  latestProgress(): Record<string, unknown> | null { return this.progress; }

  private publish(): void {
    try { this.deps.onState?.(this.view()); } catch { /* observer */ }
  }

  beginCampaign(campaign?: string): LabStateView {
    this.phase = 'running';
    if (campaign) this.campaign = campaign;
    this.startedAt = new Date(this.now()).toISOString();
    this.deps.log({ kind: 'lab-start', campaign: this.campaign });
    this.publish();
    return this.view();
  }

  setPaused(paused: boolean): LabStateView {
    if (this.phase === 'idle' && paused) this.phase = 'paused';
    else this.phase = paused ? 'paused' : 'running';
    this.deps.log({ kind: paused ? 'lab-pause' : 'lab-resume' });
    this.publish();
    return this.view();
  }

  /** Raise (idempotently) a human gate: a blocked card with a question, on the ASK ME board. */
  raiseGate(g: { id: string; kind: string; title: string; question: string; cardId?: string }): LabGateState {
    const existing = this.gates.get(g.id);
    if (existing) return existing;
    const cardId = g.cardId ?? `lab-gate-${g.id}`;
    const askedAt = new Date(this.now()).toISOString();
    const god = this.deps.mode().godId;
    const prior = this.deps.getTask(cardId);
    if (!prior) {
      this.deps.addTask({
        id: cardId, title: g.title, description: g.question, status: 'blocked', assignee: god, dependsOn: [], priority: 1,
        createdAt: askedAt, kind: 'gate', gateKind: g.kind, gateId: g.id, origin: 'lab-control',
        humanQA: [{ q: g.question, askedAt }]
      });
    } else {
      const qa = Array.isArray(prior.humanQA) ? (prior.humanQA as unknown[]) : [];
      this.deps.patchTask(cardId, { status: 'blocked', gateKind: g.kind, gateId: g.id, humanQA: [...qa, { q: g.question, askedAt }] });
    }
    const state: LabGateState = { id: g.id, kind: g.kind, title: g.title, question: g.question, cardId, status: 'pending', raisedAt: askedAt };
    this.gates.set(g.id, state);
    this.deps.log({ kind: 'lab-gate', gate: g.id, gateKind: g.kind, cardId });
    this.publish();
    return state;
  }

  /** Approve one gate (or every pending one). Returns the gates that changed. */
  approve(gateId: string | undefined, answer: string): LabGateState[] {
    this.syncGates();
    const targets = gateId ? [this.gates.get(gateId)].filter((g): g is LabGateState => !!g) : [...this.gates.values()];
    const changed: LabGateState[] = [];
    const at = new Date(this.now()).toISOString();
    for (const g of targets) {
      if (g.status !== 'pending') continue;
      const card = this.deps.getTask(g.cardId);
      const qa = Array.isArray(card?.humanQA) ? (card!.humanQA as Array<Record<string, unknown>>) : [];
      let closed = false;
      const next = [...qa].reverse().map((e) => {
        if (!closed && e && typeof e.q === 'string' && !e.a && !e.dismissedAt) { closed = true; return { ...e, a: answer, answeredAt: at }; }
        return e;
      }).reverse();
      this.deps.patchTask(g.cardId, { status: 'done', humanQA: next, result: `Approved: ${answer}` });
      g.status = 'approved'; g.answer = answer; g.approvedAt = at;
      this.deps.log({ kind: 'lab-approve', gate: g.id, cardId: g.cardId });
      try {
        this.deps.send({ to: this.deps.mode().godId, act: 'inform', subject: `Approved: ${g.title}`, body: answer }, 'human');
      } catch { /* the approval stands even if the note cannot be routed */ }
      changed.push({ ...g });
    }
    if (changed.length) this.publish();
    return changed;
  }

  // ─── http ─────────────────────────────────────────────────────────────────

  private rateOk(): boolean {
    const t = this.now();
    if (t - this.window.start > RATE_WINDOW_MS) this.window = { start: t, count: 1 };
    else this.window.count += 1;
    return this.window.count <= RATE_LIMIT;
  }

  private authorized(req: IncomingMessage): boolean {
    const h = req.headers.authorization;
    if (typeof h !== 'string' || !h.startsWith('Bearer ')) return false;
    const given = Buffer.from(h.slice(7).trim());
    const want = Buffer.from(this.token);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  private hostOk(req: IncomingMessage): boolean {
    const host = req.headers.host;
    if (typeof host !== 'string') return false;
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}` || host === `[::1]:${this.port}`;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (!isLoopback(req.socket.remoteAddress)) { send(res, 403, { ok: false, error: 'loopback only' }); req.destroy(); return; }
    if (!this.hostOk(req)) { send(res, 403, { ok: false, error: 'bad host' }); return; }
    if (req.headers.origin !== undefined) { send(res, 403, { ok: false, error: 'browser origins are refused' }); return; }
    if (!this.authorized(req)) { res.setHeader('www-authenticate', 'Bearer'); send(res, 401, { ok: false, error: 'unauthorized' }); return; }
    if (!this.rateOk()) { send(res, 429, { ok: false, error: 'rate limited' }); return; }

    let pathname: string;
    try { pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname; } catch { send(res, 400, { ok: false, error: 'bad url' }); return; }
    const method = req.method ?? '';
    const route = matchRoute(method, pathname);
    if (route === 'method') { send(res, 405, { ok: false, error: 'method not allowed' }); return; }
    if (!route) { send(res, 404, { ok: false, error: 'not found' }); return; }

    if (method === 'GET' || method === 'DELETE') {
      this.dispatch(route.name, route.param, undefined, res);
      return;
    }
    const type = (req.headers['content-type'] ?? '').toString().toLowerCase();
    if (!type.startsWith('application/json')) { send(res, 415, { ok: false, error: 'content-type must be application/json' }); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { aborted = true; send(res, 413, { ok: false, error: 'too large' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      let body: unknown;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim()) {
        try { body = JSON.parse(text); } catch { send(res, 400, { ok: false, error: 'bad json' }); return; }
      }
      this.dispatch(route.name, route.param, body, res);
    });
    req.on('error', () => { if (!aborted) { try { res.writeHead(400); res.end(); } catch { /* socket gone */ } } });
  }

  private dispatch(name: string, param: string | undefined, body: unknown, res: ServerResponse): void {
    try {
      const out = this.run(name, param, body);
      send(res, out.status, out.body);
    } catch (e) {
      send(res, 500, { ok: false, error: e instanceof Error ? e.message : 'internal error' });
    }
  }

  private run(name: string, param: string | undefined, body: unknown): { status: number; body: unknown } {
    const bad = (error: string): { status: number; body: unknown } => ({ status: 400, body: { ok: false, error } });
    const ok = (extra: Record<string, unknown> = {}): { status: number; body: unknown } => ({ status: 200, body: { ok: true, ...extra } });
    const need = <T>(v: Validated<T>): T | { __err: string } => (v.ok ? v.value : { __err: v.error });
    const failed = (x: unknown): x is { __err: string } => !!x && typeof x === 'object' && '__err' in (x as object);

    switch (name) {
      case 'health': return ok({ version: LAB_CONTROL_VERSION, phase: this.phase });
      case 'state': return ok({ state: this.view() });
      case 'start': {
        const v = need(validateStart(body)); if (failed(v)) return bad(v.__err);
        return ok({ state: this.beginCampaign(v.campaign) });
      }
      case 'pause': {
        const v = need(validatePause(body)); if (failed(v)) return bad(v.__err);
        return ok({ state: this.setPaused(v.paused) });
      }
      case 'approve': {
        const v = need(validateApprove(body)); if (failed(v)) return bad(v.__err);
        if (v.gateId && !this.gates.has(v.gateId)) return { status: 404, body: { ok: false, error: `no gate "${v.gateId}"` } };
        const changed = this.approve(v.gateId, v.answer);
        return ok({ approved: changed.map((g) => g.id), state: this.view() });
      }
      case 'gate': {
        const v = need(validateGate(body)); if (failed(v)) return bad(v.__err);
        const g = this.raiseGate(v);
        return ok({ gate: g });
      }
      case 'agents': {
        const v = need(validateAgentSpec(body)); if (failed(v)) return bad(v.__err);
        const r = this.deps.registerAgent(v);
        return r.ok ? ok({ id: v.id }) : { status: 500, body: { ok: false, error: r.error ?? 'could not register agent' } };
      }
      case 'tasks:add': {
        const v = need(validateTask(body, () => new Date(this.now()).toISOString())); if (failed(v)) return bad(v.__err);
        if (this.deps.addTask(v)) return ok({ created: true, id: v.id });
        // Upsert: the lab re-sends a card whenever its state changes. createdAt and id are never rewritten.
        const { id: _id, createdAt: _created, ...rest } = v;
        void _id; void _created;
        this.deps.patchTask(v.id, rest);
        return ok({ created: false, id: v.id });
      }
      case 'tasks:patch': {
        if (!param) return bad('task id required');
        const v = need(validateTaskPatch(body)); if (failed(v)) return bad(v.__err);
        return this.deps.patchTask(param, v) ? ok({ id: param }) : { status: 404, body: { ok: false, error: `no card "${param}"` } };
      }
      case 'tasks:delete': {
        if (!param) return bad('task id required');
        return this.deps.deleteTask(param) ? ok({ id: param }) : { status: 404, body: { ok: false, error: `no card "${param}"` } };
      }
      case 'messages': {
        const v = need(validateMessage(body)); if (failed(v)) return bad(v.__err);
        const msg = this.deps.send(v.partial as Card, v.from);
        return ok({ id: msg.id });
      }
      case 'status': {
        const v = need(validateStatus(body)); if (failed(v)) return bad(v.__err);
        this.deps.status(v);
        return ok();
      }
      case 'cost': {
        const v = need(validateCost(body)); if (failed(v)) return bad(v.__err);
        return ok({ total: this.addCost(v) });
      }
      case 'progress:post': {
        const v = need(validateProgress(body)); if (failed(v)) return bad(v.__err);
        this.progress = v;
        try { this.deps.onProgress?.(v); } catch { /* observer */ }
        this.publish();
        return ok({ round: typeof v.round === 'number' ? v.round : null });
      }
      case 'progress:get': return ok({ snapshot: this.progress });
      case 'board': {
        const v = need(validateBoard(body)); if (failed(v)) return bad(v.__err);
        return ok({ changed: this.deps.board(v.section, v.markdown) });
      }
      case 'log': {
        const v = need(validateLog(body)); if (failed(v)) return bad(v.__err);
        this.deps.log(v);
        return ok();
      }
      default: return { status: 404, body: { ok: false, error: 'not found' } };
    }
  }

  /** Fold one call into the agent's cumulative totals and hand the row to the ledger / gauge. */
  private addCost(c: LabCost): { usd: number; input: number; output: number } {
    const key = `${c.agentId}\t${c.sessionId}`;
    const callUsd = c.usd ?? this.deps.priceUsd?.(c.model, c) ?? 0;
    const prev = this.cumulative.get(key);
    const row: LabCostRow = {
      agentId: c.agentId, sessionId: c.sessionId, ts: this.now(), model: c.model || prev?.model || '',
      input: (prev?.input ?? 0) + c.input,
      output: (prev?.output ?? 0) + c.output,
      cacheRead: (prev?.cacheRead ?? 0) + c.cacheRead,
      cacheCreation: (prev?.cacheCreation ?? 0) + c.cacheCreation,
      usd: Math.round(((prev?.usd ?? 0) + callUsd) * 1e8) / 1e8
    };
    this.cumulative.set(key, row);
    this.deps.cost(row);
    return { usd: row.usd, input: row.input, output: row.output };
  }
}

type RouteHit = { name: string; param?: string };

function matchRoute(method: string, pathname: string): RouteHit | 'method' | null {
  const table: Array<[RegExp, Record<string, string>]> = [
    [/^\/lab\/health$/, { GET: 'health' }],
    [/^\/lab\/state$/, { GET: 'state' }],
    [/^\/lab\/start$/, { POST: 'start' }],
    [/^\/lab\/pause$/, { POST: 'pause' }],
    [/^\/lab\/approve$/, { POST: 'approve' }],
    [/^\/lab\/gate$/, { POST: 'gate' }],
    [/^\/lab\/agents$/, { POST: 'agents' }],
    [/^\/lab\/tasks$/, { POST: 'tasks:add' }],
    [/^\/lab\/tasks\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/, { PATCH: 'tasks:patch', DELETE: 'tasks:delete' }],
    [/^\/lab\/messages$/, { POST: 'messages' }],
    [/^\/lab\/status$/, { POST: 'status' }],
    [/^\/lab\/cost$/, { POST: 'cost' }],
    [/^\/lab\/progress$/, { POST: 'progress:post', GET: 'progress:get' }],
    [/^\/lab\/board$/, { POST: 'board' }],
    [/^\/lab\/log$/, { POST: 'log' }]
  ];
  for (const [re, methods] of table) {
    const m = re.exec(pathname);
    if (!m) continue;
    const name = methods[method];
    return name ? { name, param: m[1] } : 'method';
  }
  return null;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  try {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  } catch { /* socket already gone */ }
}
