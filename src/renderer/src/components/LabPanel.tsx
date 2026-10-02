import { useState, type CSSProperties, type ReactNode } from 'react';
import { useLabData } from '@/hooks/useLab';
import {
  formatGain, sortGates,
  type CurvePoint, type LabGateState, type LabPanelModel, type LabStateView, type ReframeRow
} from '../../../shared/labProgress';

/**
 * LAB: the research lab's campaign, live. Everything here is read from the lab-v4 progress snapshot and the control
 * server's state (see shared/labProgress.ts for the reducer). Strings are English-only for now: this panel appears only in
 * lab mode, which is a research-tool configuration, not the shipped product surface.
 */

const H: CSSProperties = { fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)', letterSpacing: 0.5 };
const BOX: CSSProperties = { background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', padding: 8 };

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section style={BOX} aria-label={title}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={H}>{title.toUpperCase()}</span>
        {aside && <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--cth-ink-500)' }}>{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function Chip({ children, color, strong }: { children: ReactNode; color: string; strong?: boolean }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 6px 1px', fontFamily: 'var(--cth-font-display)', fontSize: 9,
      background: color, color: 'var(--cth-on-accent)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
      opacity: strong === false ? 0.6 : 1
    }}>{children}</span>
  );
}

const Empty = ({ children }: { children: ReactNode }) => (
  <div style={{ fontSize: 12, color: 'var(--cth-ink-300)' }}>{children}</div>
);

// ─── progress curve ──────────────────────────────────────────────────────────

/** Best-so-far gain over the trials: a stepped line, a dot per trial, the bar to clear as a dashed rule. */
function ProgressCurve({ model }: { model: LabPanelModel }) {
  const pts = model.curve;
  const W = 420; const Hh = 150; const L = 38; const R = 8; const T = 10; const B = 22;
  const bar = model.objective?.barGain ?? null;
  const top = Math.max(0.05, model.curveMax, bar ?? 0) * 1.15;
  const x = (i: number): number => L + (pts.length <= 1 ? (W - L - R) / 2 : (i / (pts.length - 1)) * (W - L - R));
  const y = (g: number): number => T + (1 - Math.max(0, g) / top) * (Hh - T - B);
  if (pts.length === 0) return <Empty>No trial has been measured yet.</Empty>;
  const stepPath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(i === 0 ? 0 : pts[i - 1].bestGain)} L${x(i)},${y(p.bestGain)}`).join(' ');
  const ticks = [0, top / 2, top];
  return (
    <svg viewBox={`0 0 ${W} ${Hh}`} role="img" aria-label="Best-so-far gain over trials" style={{ width: '100%', height: 'auto', display: 'block' }}>
      {ticks.map((tv) => (
        <g key={tv}>
          <line x1={L} x2={W - R} y1={y(tv)} y2={y(tv)} stroke="var(--cth-ink-100)" strokeWidth={1} />
          <text x={L - 4} y={y(tv) + 3} textAnchor="end" fontSize={9} fill="var(--cth-ink-500)">{formatGain(tv, 0)}</text>
        </g>
      ))}
      {bar !== null && (
        <g>
          <line x1={L} x2={W - R} y1={y(bar)} y2={y(bar)} stroke="var(--cth-coral)" strokeWidth={1} strokeDasharray="4 3" />
          <text x={W - R} y={y(bar) - 3} textAnchor="end" fontSize={9} fill="var(--cth-coral)">bar {formatGain(bar, 0)}</text>
        </g>
      )}
      <path d={stepPath} fill="none" stroke="var(--cth-sky)" strokeWidth={2} />
      {pts.map((p: CurvePoint, i) => (
        <g key={p.trial}>
          <circle cx={x(i)} cy={y(p.gain ?? 0)} r={p.improved ? 4 : 3} fill={p.improved ? 'var(--cth-mint)' : 'var(--cth-paper-100)'} stroke="var(--cth-ink-700)" strokeWidth={1}>
            <title>{`Trial ${p.trial} (round ${p.round ?? '?'}): ${p.label}, gain ${formatGain(p.gain)}, best ${formatGain(p.bestGain)}`}</title>
          </circle>
          <text x={x(i)} y={Hh - 8} textAnchor="middle" fontSize={9} fill="var(--cth-ink-500)">{p.trial}</text>
        </g>
      ))}
      <text x={L} y={Hh - 0} fontSize={8} fill="var(--cth-ink-300)">trial</text>
    </svg>
  );
}

// ─── ladder ──────────────────────────────────────────────────────────────────

function Ladder({ model }: { model: LabPanelModel }) {
  const r = model.rung;
  if (!r) return <Empty>No ladder in this run.</Empty>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
        {r.available.map((id, i) => (
          <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {i > 0 && <span style={{ color: 'var(--cth-ink-300)' }}>›</span>}
            <Chip color={id === r.id ? 'var(--cth-lemon)' : 'var(--cth-cream-300)'} strong={id === r.id}>{id}</Chip>
          </span>
        ))}
        {r.exhausted && <Chip color="var(--cth-coral)">exhausted</Chip>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--cth-ink-900)' }}>
        Rung {r.index + 1} of {r.total}: <b>{r.label}</b>{r.plateau ? <span style={{ color: r.plateau === 'PLATEAU' ? 'var(--cth-coral)' : 'var(--cth-ink-500)' }}> ({r.plateau})</span> : null}
      </div>
      {model.rungHistory.length === 0
        ? <Empty>No escalation yet.</Empty>
        : model.rungHistory.map((h, i) => (
          <div key={i} style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-900)' }}>
            <span style={{ color: 'var(--cth-ink-500)' }}>Round {h.round ?? '?'}:</span> {h.from} → <b>{h.to}</b> ({h.reason})
            {h.detail && <div style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{h.detail}</div>}
          </div>
        ))}
    </div>
  );
}

// ─── reframes ────────────────────────────────────────────────────────────────

const REFRAME_COLOR: Record<ReframeRow['state'], string> = {
  pending: 'var(--cth-cream-300)', running: 'var(--cth-lemon)', tested: 'var(--cth-mint)', dropped: 'var(--cth-status-ghost)'
};

/** Two bars on one scale: what the reframer predicted, and what the trial measured. */
function PredictedVsMeasured({ row, scale }: { row: ReframeRow; scale: number }) {
  const w = (g: number | null): string => `${Math.max(0, Math.min(100, ((g ?? 0) / scale) * 100))}%`;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '58px 1fr 48px', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--cth-ink-500)' }}>
      <span>predicted</span>
      <span style={{ height: 6, background: 'var(--cth-cream-300)' }}><span style={{ display: 'block', height: '100%', width: w(row.predicted), background: 'var(--cth-lilac)' }} /></span>
      <span style={{ textAlign: 'right' }}>{formatGain(row.predicted)}</span>
      <span>measured</span>
      <span style={{ height: 6, background: 'var(--cth-cream-300)' }}><span style={{ display: 'block', height: '100%', width: w(row.measured), background: row.tainted ? 'var(--cth-coral)' : 'var(--cth-mint)' }} /></span>
      <span style={{ textAlign: 'right' }}>{formatGain(row.measured)}</span>
    </div>
  );
}

function Reframes({ model }: { model: LabPanelModel }) {
  if (model.reframes.length === 0) return <Empty>No reframe proposed yet.</Empty>;
  const scale = Math.max(0.05, ...model.reframes.flatMap((r) => [r.predicted ?? 0, r.measured ?? 0])) * 1.1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {model.reframes.map((r) => (
        <div key={r.id} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
            <Chip color={REFRAME_COLOR[r.state]}>{r.state.toUpperCase()}</Chip>
            <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-500)', flexShrink: 0, whiteSpace: 'nowrap' }}>{r.id}</span>
            <span style={{ fontSize: 12, color: 'var(--cth-ink-900)', minWidth: 0 }}>{r.name}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>challenges "{r.assumption}" · trial {r.trial}</div>
          {r.state !== 'dropped' && <PredictedVsMeasured row={r} scale={scale} />}
          <div style={{ fontSize: 11, color: 'var(--cth-ink-900)' }}>{r.summary}{r.error !== null && r.state === 'tested' ? ` (${r.error >= 0 ? '+' : ''}${(r.error * 100).toFixed(1)} pts)` : ''}</div>
        </div>
      ))}
    </div>
  );
}

// ─── lessons, budget ─────────────────────────────────────────────────────────

const LESSON_COLOR: Record<string, string> = { candidate: 'var(--cth-lemon)', validated: 'var(--cth-mint)', rejected: 'var(--cth-coral)' };

function Lessons({ model }: { model: LabPanelModel }) {
  const l = model.lessons;
  if (!l) return <Empty>No lesson store in this run. A lesson is only reusable once it improves held-out cases.</Empty>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        {(['candidate', 'validated', 'rejected'] as const).map((k) => (
          <span key={k} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <Chip color={LESSON_COLOR[k]}>{k.toUpperCase()}</Chip><b style={{ fontSize: 12 }}>{l[k]}</b>
          </span>
        ))}
      </div>
      {l.items.map((it) => (
        <div key={it.id} style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'baseline' }}>
          <Chip color={LESSON_COLOR[it.status] ?? 'var(--cth-cream-300)'}>{it.status.toUpperCase()}</Chip>
          <span>{it.label}</span><span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{it.detail}</span>
        </div>
      ))}
    </div>
  );
}

function Budget({ model }: { model: LabPanelModel }) {
  const b = model.budget;
  if (!b) return <Empty>No budget reported.</Empty>;
  const pct = b.usedFraction === null ? 0 : Math.round(b.usedFraction * 100);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ height: 8, background: 'var(--cth-cream-300)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: pct >= 100 ? 'var(--cth-coral)' : 'var(--cth-sky)' }} />
      </div>
      <div style={{ fontSize: 12 }}>
        {b.used + b.confirmations} of {b.total ?? '?'} trials used ({b.used} exploratory, {b.confirmations} confirmation), {b.remaining ?? '?'} remaining
        {b.reservedConfirmation ? `, ${b.reservedConfirmation} reserved for confirmation` : ''}
      </div>
      {b.reframe && (
        <div style={{ fontSize: 12 }}>
          Reframe trials: <b>{b.reframe.tested}</b> tested of <b>{b.reframe.required}</b> required
          {b.reframe.owed > 0
            ? <span style={{ color: 'var(--cth-coral)' }}>, <b>{b.reframe.owed}</b> owed</span>
            : <span style={{ color: 'var(--cth-mint)' }}>, none owed</span>}
          , {b.reframe.pending} pending
        </div>
      )}
    </div>
  );
}

// ─── gates and header ────────────────────────────────────────────────────────

function Gates({ gates }: { gates: LabGateState[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (gates.length === 0) return null;
  const approve = async (id: string): Promise<void> => {
    setBusy(id);
    try { await window.cth.labApprove(id, answers[id]?.trim() || undefined); } finally { setBusy(null); }
  };
  return (
    <section style={{ ...BOX, boxShadow: 'inset 0 0 0 2px var(--cth-coral)' }} aria-label="Human gates">
      <div style={{ ...H, marginBottom: 6 }}>NEEDS YOU ({gates.filter((g) => g.status === 'pending').length})</div>
      {sortGates(gates).map((g) => (
        <div key={g.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 0', borderTop: '1px solid var(--cth-ink-100)' }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
            <Chip color={g.status === 'pending' ? 'var(--cth-coral)' : 'var(--cth-mint)'}>{g.status === 'pending' ? 'BLOCKED' : 'APPROVED'}</Chip>
            <Chip color="var(--cth-cream-300)">{g.kind.toUpperCase()}</Chip>
            <b style={{ fontSize: 12 }}>{g.title}</b>
          </div>
          <div style={{ fontSize: 12, color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap' }}>{g.question.replace(/\*\*/g, '')}</div>
          {g.status === 'pending'
            ? (
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={answers[g.id] ?? ''} placeholder="optional note" aria-label={`Note for ${g.title}`}
                  onChange={(e) => setAnswers((a) => ({ ...a, [g.id]: e.target.value }))}
                  style={{ flex: 1, fontSize: 12, padding: '3px 6px', background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)', border: '1px solid var(--cth-ink-300)' }}
                />
                <button
                  onClick={() => void approve(g.id)} disabled={busy === g.id}
                  style={{ cursor: 'pointer', fontFamily: 'var(--cth-font-display)', fontSize: 9, padding: '4px 10px', background: 'var(--cth-mint)', color: 'var(--cth-on-accent)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)' }}
                >APPROVE</button>
              </div>
            )
            : <div style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>Approved: {g.answer}</div>}
        </div>
      ))}
    </section>
  );
}

function Header({ state, model }: { state: LabStateView | null; model: LabPanelModel }) {
  const phase = state?.phase ?? 'idle';
  const color = phase === 'running' ? 'var(--cth-mint)' : phase === 'paused' ? 'var(--cth-lemon)' : 'var(--cth-status-idle)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Chip color={color}>{phase.toUpperCase()}</Chip>
      <span style={{ fontSize: 12 }}>{state?.campaign ?? model.caseKey ?? 'no campaign yet'}</span>
      {model.round !== null && <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>round {model.round}</span>}
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
        {state && (
          <button
            onClick={() => void window.cth.labPause(phase !== 'paused')}
            style={{ cursor: 'pointer', fontFamily: 'var(--cth-font-display)', fontSize: 9, padding: '3px 8px', background: 'var(--cth-cream-200)', color: 'var(--cth-ink-900)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}
          >{phase === 'paused' ? 'RESUME' : 'PAUSE'}</button>
        )}
      </span>
    </div>
  );
}

export function LabPanel() {
  const { state, model } = useLabData();
  const gates = state?.gates ?? [];
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--cth-paper-200)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="lab-panel">
      <Header state={state} model={model} />
      <Gates gates={gates} />
      {!model.hasData && <Empty>Waiting for the lab loop to post its first progress snapshot.</Empty>}
      {model.hasData && (
        <>
          <Section title="Progress" aside={model.best ? `best ${formatGain(model.best.gain)} · ${model.best.label}` : 'nothing measured'}>
            <ProgressCurve model={model} />
            {model.objective && (
              <div style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
                {model.objective.direction} <code>{model.objective.metricId}</code>, baseline {model.objective.baseline ?? 'n/a'}
              </div>
            )}
          </Section>
          <Section title="Ladder" aside={model.rung?.label}><Ladder model={model} /></Section>
          <Section title="Reframes" aside={`${model.reframes.filter((r) => r.state === 'tested').length}/${model.reframes.length} tested`}><Reframes model={model} /></Section>
          <Section title="Ruled out" aside={String(model.ruledOut.length)}>
            {model.ruledOut.length === 0
              ? <Empty>Nothing ruled out yet.</Empty>
              : model.ruledOut.map((r, i) => (
                <div key={i} style={{ fontSize: 12, lineHeight: '16px' }}><b>{r.label}</b> <span style={{ color: 'var(--cth-ink-500)' }}>{r.reason}</span></div>
              ))}
          </Section>
          <Section title="Lesson gate (held-out)"><Lessons model={model} /></Section>
          <Section title="Budget"><Budget model={model} /></Section>
          {model.violations.length > 0 && (
            <Section title="Violations">
              {model.violations.map((v, i) => <div key={i} style={{ fontSize: 12, color: 'var(--cth-coral)' }}>{v}</div>)}
            </Section>
          )}
        </>
      )}
    </div>
  );
}
