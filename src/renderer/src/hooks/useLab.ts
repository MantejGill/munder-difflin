import { useEffect, useMemo, useState } from 'react';
import { buildLabModel, type LabPanelModel, type LabStateView } from '../../../shared/labProgress';

/** Is the app running in lab mode? Read once; the answer cannot change without a relaunch. */
export function useLabEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    window.cth.labConfig?.().then((c) => { if (alive) setEnabled(!!c?.enabled); }).catch(() => { /* not lab mode */ });
    return () => { alive = false; };
  }, []);
  return enabled;
}

const POLL_MS = 5000;

/** The lab panel's live data: control-server state (phase, gates), the latest progress snapshot, and the reduced model. */
export function useLabData(): { state: LabStateView | null; snapshot: Record<string, unknown> | null; model: LabPanelModel } {
  const [state, setState] = useState<LabStateView | null>(null);
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null);
  const [inFlight, setInFlight] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    const pull = async (): Promise<void> => {
      try {
        const [s, p, tasks] = await Promise.all([window.cth.labState(), window.cth.labProgress(), window.cth.hiveTasks()]);
        if (!alive) return;
        setState(s);
        if (p) setSnapshot(p);
        const list = (tasks as { tasks?: Array<Record<string, unknown>> } | null)?.tasks;
        // A trial whose card is "doing" has been granted and not yet measured: its reframe reads "running".
        setInFlight((Array.isArray(list) ? list : [])
          .filter((t) => t?.kind === 'experiment' && t.status === 'doing' && typeof t.trialKey === 'string')
          .map((t) => t.trialKey as string));
      } catch { /* keep the last good view */ }
    };
    void pull();
    const iv = setInterval(pull, POLL_MS);
    const offProgress = window.cth.onLabProgress?.((snap) => { if (alive) setSnapshot(snap); });
    const offState = window.cth.onLabState?.((s) => { if (alive) setState(s); });
    return () => { alive = false; clearInterval(iv); offProgress?.(); offState?.(); };
  }, []);

  const model = useMemo(() => buildLabModel(snapshot, inFlight), [snapshot, inFlight]);
  return { state, snapshot, model };
}
