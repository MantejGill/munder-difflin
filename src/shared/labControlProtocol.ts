/**
 * Request validation for the lab control server (src/main/labControl.ts).
 *
 * Every body that crosses the loopback socket is untrusted input (any local process can reach the port; only the bearer
 * token separates it from the hive), so each endpoint has a validator here that returns a CLEAN copy: unknown top-level
 * fields of an endpoint with a fixed shape are dropped, strings are length-capped, numbers must be finite, ids must match a
 * conservative pattern. Task cards are the one open shape (the app already preserves unknown card fields, and the lab adds
 * `kind`, `trialKey`, `evidenceRef`, ...), so they accept extra JSON fields under tight limits.
 *
 * Pure and dependency-free: shared by main, the tests and any stub.
 */
import { LAB_GOD_ID } from './labMode';

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const good = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

export const LAB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done'] as const;
export const MESSAGE_ACTS = ['request', 'inform', 'propose', 'query', 'agree', 'refuse', 'done'] as const;
export const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'UserPromptSubmit', 'SessionStart', 'PreCompact', 'PostCompact'
] as const;
export const GATE_KINDS = ['violation', 'budget-stop', 'other'] as const;
export const ACCENTS = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'] as const;
export const PROGRESS_SCHEMA = 'lab-v4-progress/1';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_CARD_BYTES = 32 * 1024;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function str(v: unknown, max: number, min = 0): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length >= min && t.length <= max ? t : null;
}

function optStr(o: Obj, key: string, max: number): Validated<string | undefined> {
  if (o[key] === undefined || o[key] === null) return good(undefined);
  const s = typeof o[key] === 'string' && (o[key] as string).length <= max ? (o[key] as string) : null;
  return s === null ? fail(`${key}: expected a string of at most ${max} characters`) : good(s);
}

function id(v: unknown, what: string): Validated<string> {
  return typeof v === 'string' && LAB_ID_RE.test(v) ? good(v) : fail(`${what}: expected an id matching ${LAB_ID_RE}`);
}

function finiteNum(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

/** JSON-safe, depth-limited, no prototype keys. Returns an error string or null. */
function checkJson(v: unknown, depth = 0): string | null {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? null : 'non-finite number';
  if (depth > 5) return 'nested too deeply';
  if (Array.isArray(v)) {
    if (v.length > 500) return 'array too long';
    for (const x of v) { const e = checkJson(x, depth + 1); if (e) return e; }
    return null;
  }
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (keys.length > 100) return 'object has too many keys';
    for (const k of keys) {
      if (FORBIDDEN_KEYS.has(k)) return `forbidden key ${k}`;
      const e = checkJson(v[k], depth + 1); if (e) return e;
    }
    return null;
  }
  return 'unsupported value';
}

// ─── agents ──────────────────────────────────────────────────────────────────

export interface LabAgentSpec {
  id: string;
  name: string;
  role: string;
  character?: string;
  accent?: string;
  model?: string;
  capabilities: string[];
  isGod: boolean;
}

export function validateAgentSpec(body: unknown): Validated<LabAgentSpec> {
  if (!isObj(body)) return fail('body must be a JSON object');
  const aid = id(body.id, 'id'); if (!aid.ok) return aid;
  const name = str(body.name, 60, 1); if (name === null) return fail('name: expected 1-60 characters');
  const role = str(body.role ?? '', 200); if (role === null) return fail('role: expected at most 200 characters');
  let character: string | undefined;
  if (body.character !== undefined) {
    const c = str(body.character, 30, 1);
    if (c === null || !/^[a-z]+$/i.test(c)) return fail('character: expected a cast member name');
    character = c.toLowerCase();
  }
  let accent: string | undefined;
  if (body.accent !== undefined) {
    if (typeof body.accent !== 'string' || !(ACCENTS as readonly string[]).includes(body.accent)) return fail(`accent: expected one of ${ACCENTS.join(', ')}`);
    accent = body.accent;
  }
  let model: string | undefined;
  if (body.model !== undefined) {
    const m = str(body.model, 100, 1); if (m === null) return fail('model: expected 1-100 characters'); model = m;
  }
  const capabilities: string[] = [];
  if (body.capabilities !== undefined) {
    if (!Array.isArray(body.capabilities) || body.capabilities.length > 20) return fail('capabilities: expected an array of at most 20 strings');
    for (const c of body.capabilities) { const s = str(c, 60, 1); if (s === null) return fail('capabilities: expected short strings'); capabilities.push(s); }
  }
  const wantsGod = body.isGod === true;
  if (wantsGod && aid.value !== LAB_GOD_ID) return fail(`isGod: only the agent "${LAB_GOD_ID}" may take the god seat`);
  return good({ id: aid.value, name, role, character, accent, model, capabilities, isGod: wantsGod });
}

// ─── tasks ───────────────────────────────────────────────────────────────────

function checkCardFields(o: Obj, partial: boolean): Validated<Obj> {
  const out: Obj = {};
  for (const k of Object.keys(o)) {
    if (FORBIDDEN_KEYS.has(k)) return fail(`forbidden key ${k}`);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k)) return fail(`field name "${k}" is not allowed`);
  }
  if (!partial || o.title !== undefined) {
    const t = str(o.title, 300, 1); if (t === null) return fail('title: expected 1-300 characters'); out.title = t;
  }
  if (!partial || o.status !== undefined) {
    if (typeof o.status !== 'string' || !(TASK_STATUSES as readonly string[]).includes(o.status)) return fail(`status: expected one of ${TASK_STATUSES.join(', ')}`);
    out.status = o.status;
  }
  if (o.description !== undefined) { const d = str(o.description, 4000); if (d === null) return fail('description: expected at most 4000 characters'); out.description = d; }
  if (o.result !== undefined) { const r = str(o.result, 4000); if (r === null) return fail('result: expected at most 4000 characters'); out.result = r; }
  if (o.assignee !== undefined && o.assignee !== null) { const a = id(o.assignee, 'assignee'); if (!a.ok) return a; out.assignee = a.value; }
  if (o.assignee === null) out.assignee = null;
  if (o.dependsOn !== undefined) {
    if (!Array.isArray(o.dependsOn) || o.dependsOn.length > 50) return fail('dependsOn: expected an array of at most 50 ids');
    const deps: string[] = [];
    for (const d of o.dependsOn) { const v = id(d, 'dependsOn[]'); if (!v.ok) return v; deps.push(v.value); }
    out.dependsOn = deps;
  } else if (!partial) out.dependsOn = [];
  if (o.priority !== undefined) { const p = finiteNum(o.priority, 1, 9); if (p === null) return fail('priority: expected a number from 1 to 9'); out.priority = p; }
  else if (!partial) out.priority = 3;
  if (o.createdAt !== undefined) {
    if (typeof o.createdAt !== 'string' || Number.isNaN(Date.parse(o.createdAt))) return fail('createdAt: expected an ISO date');
    out.createdAt = o.createdAt;
  }
  if (o.humanQA !== undefined) {
    if (!Array.isArray(o.humanQA) || o.humanQA.length > 50) return fail('humanQA: expected an array');
    const qa = [];
    for (const e of o.humanQA) {
      if (!isObj(e) || str(e.q, 2000, 1) === null) return fail('humanQA[]: expected {q, a?, askedAt?, answeredAt?}');
      const entry: Obj = { q: str(e.q, 2000, 1) };
      for (const f of ['a', 'askedAt', 'answeredAt', 'dismissedAt']) if (e[f] !== undefined) { const s = str(e[f], 2000); if (s === null) return fail(`humanQA[].${f}: expected a string`); entry[f] = s; }
      qa.push(entry);
    }
    out.humanQA = qa;
  }
  // everything else is the lab's own extra fields (kind, trialKey, evidenceRef, gain, ...): any JSON, under tight limits.
  const fixed = new Set(['id', 'title', 'status', 'description', 'result', 'assignee', 'dependsOn', 'priority', 'createdAt', 'humanQA', 'webhook', 'slack']);
  for (const k of Object.keys(o)) {
    if (fixed.has(k)) continue;
    const e = checkJson(o[k]); if (e) return fail(`${k}: ${e}`);
    out[k] = o[k];
  }
  if (new TextEncoder().encode(JSON.stringify(out)).length > MAX_CARD_BYTES) return fail(`card is larger than ${MAX_CARD_BYTES} bytes`);
  return good(out);
}

export interface LabTask extends Obj { id: string; title: string; status: string; dependsOn: string[]; priority: number; createdAt: string }

export function validateTask(body: unknown, now: () => string = () => new Date().toISOString()): Validated<LabTask> {
  const raw = isObj(body) && isObj(body.task) ? body.task : body;
  if (!isObj(raw)) return fail('body must be a JSON object (a card, or {task: card})');
  const tid = id(raw.id, 'id'); if (!tid.ok) return tid;
  const card = checkCardFields(raw, false); if (!card.ok) return card;
  return good({ ...card.value, id: tid.value, createdAt: (card.value.createdAt as string | undefined) ?? now() } as LabTask);
}

export function validateTaskPatch(body: unknown): Validated<Obj> {
  const raw = isObj(body) && isObj(body.patch) ? body.patch : body;
  if (!isObj(raw)) return fail('body must be a JSON object (a patch, or {patch})');
  if (raw.id !== undefined) return fail('id: a patch cannot change the card id');
  const card = checkCardFields(raw, true); if (!card.ok) return card;
  if (Object.keys(card.value).length === 0) return fail('patch: nothing to change');
  return card;
}

// ─── messages ────────────────────────────────────────────────────────────────

export interface LabMessage {
  from: string;
  partial: {
    id?: string; conversation?: string; in_reply_to?: string | null; to: string; act: string; subject: string; body: string;
    hops?: number; requires_reply?: boolean; needs_human?: boolean; created_at?: string;
  };
}

export function validateMessage(body: unknown): Validated<LabMessage> {
  if (!isObj(body)) return fail('body must be a JSON object');
  const m = isObj(body.message) ? body.message : body;
  const from = id(body.from ?? m.from, 'from'); if (!from.ok) return from;
  const toRaw = m.to;
  const to = toRaw === 'broadcast' || toRaw === 'human' ? good(toRaw as string) : id(toRaw, 'to'); if (!to.ok) return to;
  if (typeof m.act !== 'string' || !(MESSAGE_ACTS as readonly string[]).includes(m.act)) return fail(`act: expected one of ${MESSAGE_ACTS.join(', ')}`);
  const subject = str(m.subject ?? '', 300); if (subject === null) return fail('subject: expected at most 300 characters');
  const bodyText = typeof (m.body ?? '') === 'string' && String(m.body ?? '').length <= 20000 ? String(m.body ?? '') : null;
  if (bodyText === null) return fail('body: expected at most 20000 characters');
  const partial: LabMessage['partial'] = { to: to.value, act: m.act, subject, body: bodyText };
  if (m.id !== undefined) { const v = id(m.id, 'id'); if (!v.ok) return v; partial.id = v.value; }
  if (m.conversation !== undefined) { const v = id(m.conversation, 'conversation'); if (!v.ok) return v; partial.conversation = v.value; }
  if (m.in_reply_to !== undefined && m.in_reply_to !== null) { const v = id(m.in_reply_to, 'in_reply_to'); if (!v.ok) return v; partial.in_reply_to = v.value; }
  if (m.hops !== undefined) { const h = finiteNum(m.hops, 0, 100); if (h === null || !Number.isInteger(h)) return fail('hops: expected an integer 0-100'); partial.hops = h; }
  if (m.requires_reply !== undefined) { if (typeof m.requires_reply !== 'boolean') return fail('requires_reply: expected a boolean'); partial.requires_reply = m.requires_reply; }
  if (m.needs_human !== undefined) { if (typeof m.needs_human !== 'boolean') return fail('needs_human: expected a boolean'); partial.needs_human = m.needs_human; }
  if (m.created_at !== undefined) { if (typeof m.created_at !== 'string' || Number.isNaN(Date.parse(m.created_at))) return fail('created_at: expected an ISO date'); partial.created_at = m.created_at; }
  return good({ from: from.value, partial });
}

// ─── status, cost ────────────────────────────────────────────────────────────

export interface LabStatus {
  agentId: string;
  event: string;
  tool?: string;
  message?: string;
  context?: { tokens: number; limit: number };
}

export function validateStatus(body: unknown): Validated<LabStatus> {
  if (!isObj(body)) return fail('body must be a JSON object');
  const agentId = id(body.agentId, 'agentId'); if (!agentId.ok) return agentId;
  const event = body.event ?? 'Notification';
  if (typeof event !== 'string' || !(HOOK_EVENTS as readonly string[]).includes(event)) return fail(`event: expected one of ${HOOK_EVENTS.join(', ')}`);
  const out: LabStatus = { agentId: agentId.value, event };
  if (body.tool !== undefined) { const t = str(body.tool, 60, 1); if (t === null) return fail('tool: expected 1-60 characters'); out.tool = t; }
  if (body.message !== undefined) { const t = str(body.message, 500); if (t === null) return fail('message: expected at most 500 characters'); out.message = t; }
  if (body.context !== undefined) {
    if (!isObj(body.context)) return fail('context: expected {tokens, limit}');
    const tokens = finiteNum(body.context.tokens, 0, 1e9); const limit = finiteNum(body.context.limit, 1, 1e9);
    if (tokens === null || limit === null) return fail('context: tokens and limit must be finite numbers (limit > 0)');
    out.context = { tokens, limit };
  }
  if (out.tool === undefined && out.message === undefined && out.context === undefined && body.event === undefined) return fail('status: nothing to report');
  return good(out);
}

export interface LabCost {
  agentId: string;
  sessionId: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Cost of THIS call, when the caller knows it (the CLI's total_cost_usd for a fresh call). Absent: the app prices the tokens. */
  usd?: number;
}

export function validateCost(body: unknown): Validated<LabCost> {
  if (!isObj(body)) return fail('body must be a JSON object');
  const agentId = id(body.agentId, 'agentId'); if (!agentId.ok) return agentId;
  const sessionId = body.sessionId === undefined ? good('lab-session') : id(body.sessionId, 'sessionId'); if (!sessionId.ok) return sessionId;
  const model = str(body.model ?? '', 100); if (model === null) return fail('model: expected at most 100 characters');
  const counts: Record<string, number> = {};
  for (const [src, dst] of [['input', 'input'], ['output', 'output'], ['cacheRead', 'cacheRead'], ['cacheCreation', 'cacheCreation']] as const) {
    const v = body[src] === undefined ? 0 : finiteNum(body[src], 0, 1e10);
    if (v === null) return fail(`${src}: expected a non-negative number`);
    counts[dst] = Math.round(v);
  }
  let usd: number | undefined;
  if (body.usd !== undefined && body.usd !== null) { const u = finiteNum(body.usd, 0, 1e6); if (u === null) return fail('usd: expected a non-negative number'); usd = u; }
  if (counts.input + counts.output + counts.cacheRead + counts.cacheCreation === 0 && usd === undefined) return fail('cost: no tokens and no usd');
  return good({ agentId: agentId.value, sessionId: sessionId.value, model, input: counts.input, output: counts.output,
    cacheRead: counts.cacheRead, cacheCreation: counts.cacheCreation, ...(usd !== undefined ? { usd } : {}) });
}

// ─── gates, lab verbs ────────────────────────────────────────────────────────

export interface LabGate { id: string; kind: string; title: string; question: string; cardId?: string; detail?: unknown }

export function validateGate(body: unknown): Validated<LabGate> {
  if (!isObj(body)) return fail('body must be a JSON object');
  const gid = id(body.id, 'id'); if (!gid.ok) return gid;
  const kind = body.kind ?? 'other';
  if (typeof kind !== 'string' || !(GATE_KINDS as readonly string[]).includes(kind)) return fail(`kind: expected one of ${GATE_KINDS.join(', ')}`);
  const title = str(body.title, 300, 1); if (title === null) return fail('title: expected 1-300 characters');
  const question = str(body.question, 2000, 1); if (question === null) return fail('question: expected 1-2000 characters');
  const out: LabGate = { id: gid.value, kind, title, question };
  if (body.cardId !== undefined) { const c = id(body.cardId, 'cardId'); if (!c.ok) return c; out.cardId = c.value; }
  if (body.detail !== undefined) { const e = checkJson(body.detail); if (e) return fail(`detail: ${e}`); out.detail = body.detail; }
  return good(out);
}

export function validateApprove(body: unknown): Validated<{ gateId?: string; answer: string }> {
  const o = body === undefined || body === null ? {} : body;
  if (!isObj(o)) return fail('body must be a JSON object');
  let gateId: string | undefined;
  if (o.gateId !== undefined) { const g = id(o.gateId, 'gateId'); if (!g.ok) return g; gateId = g.value; }
  const answer = o.answer === undefined ? 'approved' : str(o.answer, 2000);
  if (answer === null) return fail('answer: expected at most 2000 characters');
  return good({ gateId, answer: answer || 'approved' });
}

export function validateStart(body: unknown): Validated<{ campaign?: string }> {
  const o = body === undefined || body === null ? {} : body;
  if (!isObj(o)) return fail('body must be a JSON object');
  if (o.campaign === undefined) return good({});
  const c = str(o.campaign, 200, 1); if (c === null) return fail('campaign: expected 1-200 characters');
  return good({ campaign: c });
}

export function validatePause(body: unknown): Validated<{ paused: boolean }> {
  const o = body === undefined || body === null ? {} : body;
  if (!isObj(o)) return fail('body must be a JSON object');
  if (o.paused !== undefined && typeof o.paused !== 'boolean') return fail('paused: expected a boolean');
  return good({ paused: o.paused !== false });
}

// ─── progress, board, log ────────────────────────────────────────────────────

export function validateProgress(body: unknown): Validated<Obj> {
  const snap = isObj(body) && isObj(body.snapshot) ? body.snapshot : body;
  if (!isObj(snap)) return fail('body must be a lab-v4-progress/1 snapshot (or {snapshot})');
  if (snap.schema !== PROGRESS_SCHEMA) return fail(`schema: expected "${PROGRESS_SCHEMA}"`);
  if (snap.round !== null && snap.round !== undefined && finiteNum(snap.round, 0, 1e6) === null) return fail('round: expected a number or null');
  for (const k of ['curve', 'ruledOut', 'reframes', 'nextCandidates', 'violations']) {
    if (snap[k] !== undefined && (!Array.isArray(snap[k]) || (snap[k] as unknown[]).length > 2000)) return fail(`${k}: expected an array of at most 2000 entries`);
  }
  for (const k of ['objective', 'best', 'rung', 'plateau', 'budget', 'lessons']) {
    if (snap[k] !== undefined && snap[k] !== null && !isObj(snap[k])) return fail(`${k}: expected an object or null`);
  }
  const e = checkJson(snap, -20); // generous depth: snapshots nest (rung.history[].window, reframes[].measured, ...)
  if (e) return fail(`snapshot: ${e}`);
  return good(snap);
}

/** A marker-fenced section of one lab agent's identity.md or memory.md. */
export function validateAgentFile(body: unknown): Validated<{ agentId: string; file: 'identity' | 'memory'; markdown: string }> {
  if (!isObj(body)) return fail('body must be a JSON object');
  const agentId = id(body.agentId, 'agentId'); if (!agentId.ok) return agentId;
  if (body.file !== 'identity' && body.file !== 'memory') return fail('file: expected "identity" or "memory"');
  if (typeof body.markdown !== 'string' || body.markdown.length > 100_000) return fail('markdown: expected at most 100000 characters');
  return good({ agentId: agentId.value, file: body.file, markdown: body.markdown });
}

export function validateBoard(body: unknown): Validated<{ section: string; markdown: string }> {
  if (!isObj(body)) return fail('body must be a JSON object');
  if (typeof body.section !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(body.section)) return fail('section: expected a lowercase slug');
  if (typeof body.markdown !== 'string' || body.markdown.length > 200_000) return fail('markdown: expected at most 200000 characters');
  return good({ section: body.section, markdown: body.markdown });
}

export function validateLog(body: unknown): Validated<Obj> {
  if (!isObj(body)) return fail('body must be a JSON object');
  if (typeof body.kind !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(body.kind)) return fail('kind: expected a lowercase slug');
  const e = checkJson(body); if (e) return fail(`log: ${e}`);
  if (new TextEncoder().encode(JSON.stringify(body)).length > 8192) return fail('log record is larger than 8192 bytes');
  return good(body);
}
