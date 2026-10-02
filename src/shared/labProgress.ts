/**
 * The lab panel's data model: a pure reducer from the lab-v4 progress snapshot (`lab-v4-progress/1`, produced by the
 * research lab's loop and delivered through the lab control server) to exactly what the panels draw.
 *
 * Kept free of React so it is unit-tested in node:test and the panel stays a thin renderer. Everything tolerates a
 * missing or partial snapshot (an older loop, a first round), because the panel mounts before any round has run.
 */

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

/** What `GET /lab/state` and the `lab:state` push carry. */
export interface LabStateView {
  phase: LabPhase;
  campaign: string | null;
  startedAt: string | null;
  god: { id: string; name: string; role: string; prompt: string };
  gates: LabGateState[];
  pendingGates: number;
  progressRound: number | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** "placement::{"density":"higher"}" -> "placement (density=higher)". Mirrors the lab bridge's describeTrial. */
export function describeTrialKey(key: unknown): string {
  const k = text(key);
  const i = k.indexOf('::');
  if (i < 0) return k || 'n/a';
  let params: Obj = {};
  try { const p = JSON.parse(k.slice(i + 2)); if (isObj(p)) params = p; } catch { /* keep {} */ }
  const body = Object.entries(params).map(([n, v]) => `${n}=${String(v)}`).join(', ');
  return body ? `${k.slice(0, i)} (${body})` : k.slice(0, i);
}

/** Relative gain as a signed percentage string: 0.2472 -> "+24.7%". */
export function formatGain(g: number | null | undefined, digits = 1): string {
  return typeof g === 'number' && Number.isFinite(g) ? `${g >= 0 ? '+' : ''}${(g * 100).toFixed(digits)}%` : 'n/a';
}

export interface CurvePoint {
  trial: number;
  round: number | null;
  label: string;
  gain: number | null;
  bestGain: number;
  /** This trial set a new best. */
  improved: boolean;
}

export interface RungHistoryRow { round: number | null; from: string; to: string; reason: string; detail: string }

export type ReframeState = 'pending' | 'running' | 'tested' | 'dropped';

export interface ReframeRow {
  id: string;
  name: string;
  assumption: string;
  state: ReframeState;
  predicted: number | null;
  confidence: number | null;
  measured: number | null;
  /** measured minus predicted, in gain points (0.097 = 9.7 points better than predicted). */
  error: number | null;
  tainted: boolean;
  /** Prediction versus measurement, one line. */
  summary: string;
  trial: string;
}

export interface LessonGate {
  candidate: number;
  validated: number;
  rejected: number;
  items: Array<{ id: string; status: string; label: string; detail: string }>;
}

export interface LabPanelModel {
  hasData: boolean;
  round: number | null;
  caseKey: string | null;
  objective: { metricId: string; direction: string; baseline: number | null; barGain: number | null } | null;
  best: { label: string; gain: number | null; value: number | null; round: number | null; evidenceRef: string | null } | null;
  curve: CurvePoint[];
  /** Largest best-so-far gain on the curve, for scaling. */
  curveMax: number;
  rung: { id: string; label: string; index: number; total: number; exhausted: boolean; available: string[]; plateau: string | null } | null;
  rungHistory: RungHistoryRow[];
  reframes: ReframeRow[];
  ruledOut: Array<{ label: string; reason: string; gain: number | null; evidenceRef: string | null }>;
  lessons: LessonGate | null;
  budget: {
    total: number | null; used: number; confirmations: number; remaining: number | null; reservedConfirmation: number | null;
    usedFraction: number | null;
    reframe: { required: number; tested: number; owed: number; pending: number } | null;
  } | null;
  violations: string[];
}

export const EMPTY_LAB_MODEL: LabPanelModel = {
  hasData: false, round: null, caseKey: null, objective: null, best: null, curve: [], curveMax: 0, rung: null, rungHistory: [],
  reframes: [], ruledOut: [], lessons: null, budget: null, violations: []
};

function reframeRow(r: Obj, inFlight: Set<string>): ReframeRow {
  const status = text(r.status, 'pending');
  const trialKey = text(r.trialKey);
  const pe = isObj(r.predictedEffect) ? r.predictedEffect : null;
  const m = isObj(r.measured) ? r.measured : null;
  const predicted = num(m?.predictedGain) ?? num(pe?.magnitude);
  const measured = m ? num(m.gain) : null;
  const tainted = !!m?.tainted;
  const state: ReframeState = status === 'tested' ? 'tested' : status === 'dropped' ? 'dropped' : inFlight.has(trialKey) ? 'running' : 'pending';
  const drop = isObj(r.drop) ? r.drop : null;
  const summary =
    state === 'tested' ? `predicted ${formatGain(predicted)}, measured ${formatGain(measured)}${tainted ? ' (tainted, does not count)' : ''}`
    : state === 'dropped' ? `dropped: ${text(drop?.reason, 'no reason recorded')}`
    : `predicts ${formatGain(predicted)}${num(pe?.confidence) !== null ? ` (confidence ${num(pe?.confidence)})` : ''}`;
  return {
    id: text(r.id), name: text(r.name), assumption: text(r.assumption), state, predicted,
    confidence: num(pe?.confidence), measured, error: m ? num(m.error) : null, tainted, summary, trial: describeTrialKey(trialKey)
  };
}

function lessonGate(v: unknown): LessonGate | null {
  if (!isObj(v)) return null;
  const items = list(v.items).filter(isObj).map((it) => ({
    id: text(it.id), status: text(it.status, 'candidate'),
    label: text(it.approach) || text(it.id),
    detail: `${text(it.problemType)}${num(it.heldOutCases) !== null ? `, held-out ${num(it.improved) ?? 0}/${num(it.heldOutCases)} improved` : ''}`.replace(/^, /, '')
  }));
  return { candidate: num(v.candidate) ?? 0, validated: num(v.validated) ?? 0, rejected: num(v.rejected) ?? 0, items };
}

/** Reduce a snapshot (or null) to the panel model. `inFlight` = trial keys granted but not yet measured (optional). */
export function buildLabModel(snapshot: unknown, inFlight: Iterable<string> = []): LabPanelModel {
  if (!isObj(snapshot)) return EMPTY_LAB_MODEL;
  const flight = new Set(inFlight);
  const o = isObj(snapshot.objective) ? snapshot.objective : null;
  const bar = o && isObj(o.bar) ? o.bar : null;
  const curveRaw = list(snapshot.curve).filter(isObj);
  let prevBest = 0;
  const curve: CurvePoint[] = curveRaw.map((p, i) => {
    const bestGain = num(p.bestGain) ?? prevBest;
    const point: CurvePoint = {
      trial: num(p.trial) ?? i + 1, round: num(p.round), label: describeTrialKey(p.key), gain: num(p.gain), bestGain,
      improved: bestGain > prevBest + 1e-12
    };
    prevBest = Math.max(prevBest, bestGain);
    return point;
  });
  const best = isObj(snapshot.best) ? snapshot.best : null;
  const rungRaw = isObj(snapshot.rung) ? snapshot.rung : null;
  const plateau = isObj(snapshot.plateau) ? snapshot.plateau : null;
  const available = list(rungRaw?.available).map((x) => text(x)).filter(Boolean);
  const budget = isObj(snapshot.budget) ? snapshot.budget : null;
  const rf = budget && isObj(budget.reframe) ? budget.reframe : null;
  const total = budget ? num(budget.total) : null;
  const used = budget ? (num(budget.experimentsUsed) ?? 0) : 0;
  const conf = budget ? (num(budget.confirmationsUsed) ?? 0) : 0;
  return {
    hasData: true,
    round: num(snapshot.round),
    caseKey: text(snapshot.caseKey) || null,
    objective: o ? { metricId: text(o.metricId, 'objective'), direction: text(o.direction, 'maximize'), baseline: num(o.baseline), barGain: bar ? num(bar.minRelativeGain) : null } : null,
    best: best ? { label: describeTrialKey(best.key), gain: num(best.gain), value: num(best.value), round: num(best.round), evidenceRef: text(best.evidenceRef) || null } : null,
    curve,
    curveMax: curve.reduce((m, p) => Math.max(m, p.bestGain, p.gain ?? 0), 0),
    rung: rungRaw
      ? {
        id: text(rungRaw.id), label: text(rungRaw.label) || text(rungRaw.id), index: num(rungRaw.index) ?? 0, total: available.length || 1,
        exhausted: !!rungRaw.exhausted, available,
        plateau: plateau ? (plateau.plateaued ? 'PLATEAU' : text(plateau.reason) || null) : null
      }
      : null,
    rungHistory: list(rungRaw?.history).filter(isObj).map((h) => {
      const w = isObj(h.window) ? h.window : null;
      return {
        round: num(h.round), from: text(h.fromLabel) || text(h.from), to: text(h.toLabel) || text(h.to), reason: text(h.reason),
        detail: w ? `best gain over the last ${num(w.k) ?? '?'} trials ${formatGain(num(w.improvement))}, threshold ${formatGain(num(w.minGain))}` : ''
      };
    }),
    reframes: list(snapshot.reframes).filter(isObj).map((r) => reframeRow(r, flight)),
    ruledOut: list(snapshot.ruledOut).filter(isObj).map((r) => ({ label: describeTrialKey(r.key), reason: text(r.reason), gain: num(r.gain), evidenceRef: text(r.evidenceRef) || null })),
    lessons: lessonGate(snapshot.lessons),
    budget: budget
      ? {
        total, used, confirmations: conf, remaining: num(budget.remaining), reservedConfirmation: num(budget.reservedConfirmation),
        usedFraction: total && total > 0 ? Math.min(1, (used + conf) / total) : null,
        reframe: rf ? { required: num(rf.required) ?? 0, tested: num(rf.tested) ?? 0, owed: num(rf.owed) ?? 0, pending: num(rf.pending) ?? 0 } : null
      }
      : null,
    violations: list(snapshot.violations).map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
  };
}

/** Open gates first, newest first; resolved after. */
export function sortGates(gates: readonly LabGateState[]): LabGateState[] {
  return [...gates].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
    return b.raisedAt.localeCompare(a.raisedAt);
  });
}
