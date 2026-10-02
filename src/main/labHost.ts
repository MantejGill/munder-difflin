/**
 * The lab host: glue between the lab control server and the app's hive.
 *
 * Everything the lab asks for is executed by the app's own, merge-safe hive writers (HiveManager.addTask/patchTask/send/
 * appendLog/...), and everything the floor must show is pushed to the renderer over the channels it already listens on
 * (`hive:hookEvent`, `hive:contextUpdate`, `telemetry:event`, `hive:agentSpawned`) plus two lab channels (`lab:progress`,
 * `lab:state`). No electron import: the renderer sink is injected, so this loads under plain Node for tests.
 *
 * Off unless lab mode is enabled (shared/labMode.ts). When off, nothing here runs and the app is unchanged.
 */
import type { HiveManager, HiveMessage, HiveTask } from './hive';
import { LabControlServer, type LabCostRow, type LabStateView } from './labControl';
import { labGodIdentity, resolveLabMode, type LabConfigInput, type LabMode } from '../shared/labMode';
import { validateHookEvent } from '../shared/hookEvents';
import { estimateCostUsd } from './pricing';

export interface LabHostDeps {
  hive: HiveManager;
  /** The `lab` object of config.json (or undefined). */
  readLabConfig: () => LabConfigInput | undefined;
  /** Send to the renderer (webContents.send); a no-op when no window is up. */
  sendToRenderer: (channel: string, payload: unknown) => void;
  env?: Record<string, string | undefined>;
  /** Test seam. */
  token?: string;
}

export interface LabHost {
  mode(): LabMode;
  /** Seat the lab god in the registry and bind the control server. A no-op (ok:false) when lab mode is off. */
  start(): Promise<{ ok: boolean; port?: number; error?: string }>;
  stop(): void;
  server(): LabControlServer | null;
  state(): LabStateView | null;
  progress(): Record<string, unknown> | null;
  approve(gateId: string | undefined, answer: string): number;
  setPaused(paused: boolean): LabStateView | null;
}

export function createLabHost(d: LabHostDeps): LabHost {
  const env = d.env ?? process.env;
  const mode = (): LabMode => resolveLabMode(d.readLabConfig(), env);
  let server: LabControlServer | null = null;

  const seatGod = (): void => {
    const m = mode();
    d.hive.registerLabAgent({
      id: m.godId, name: m.godName, role: m.godRole, cwd: d.hive.root() ?? '', isGod: true,
      capabilities: ['orchestrate', 'review', 'budget'], identity: labGodIdentity(m)
    });
  };

  const findTask = (id: string): Record<string, unknown> | null => {
    const ledger = d.hive.tasks() as { tasks?: Array<Record<string, unknown>> };
    return (Array.isArray(ledger?.tasks) ? ledger.tasks : []).find((t) => t?.id === id) ?? null;
  };

  const build = (): LabControlServer => new LabControlServer({
    hiveDir: () => d.hive.root(),
    mode,
    addTask: (t) => d.hive.addTask(t as unknown as HiveTask),
    patchTask: (id, p) => d.hive.patchTask(id, p as Partial<Omit<HiveTask, 'id'>>),
    deleteTask: (id) => d.hive.deleteTask(id),
    getTask: findTask,
    send: (partial, from) => d.hive.send(partial as Partial<HiveMessage>, from),
    registerAgent: (spec) => {
      const m = mode();
      try {
        // The god seat's name, role and prompt come from the lab config, never from the loop: the config is authoritative.
        if (spec.id === m.godId) { seatGod(); return { ok: true }; }
        const cwd = d.hive.root() ?? '';
        d.hive.registerLabAgent({ id: spec.id, name: spec.name, role: spec.role, cwd, capabilities: spec.capabilities });
        d.sendToRenderer('hive:agentSpawned', {
          id: spec.id, name: spec.name, provider: 'lab', cwd, role: spec.role,
          character: spec.character, accent: spec.accent, model: spec.model, ptyless: true
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    status: (s) => {
      const payload = { agentId: s.agentId, event: s.event, tool: s.tool, message: s.message, blocked: false };
      if (validateHookEvent(payload)) d.sendToRenderer('hive:hookEvent', payload);
      if (s.context) d.sendToRenderer('hive:contextUpdate', { agentId: s.agentId, tokens: s.context.tokens, limit: s.context.limit });
    },
    cost: (row: LabCostRow) => {
      const sample = {
        agentId: row.agentId, sessionId: row.sessionId, ts: row.ts, input: row.input, output: row.output,
        cacheRead: row.cacheRead, cacheCreation: row.cacheCreation, model: row.model, usd: row.usd
      };
      d.hive.appendCostLedger(sample);
      d.sendToRenderer('telemetry:event', { kind: 'usage', sample });
    },
    priceUsd: (model, t) => estimateCostUsd(model, {
      inputTokens: t.input, outputTokens: t.output, cacheReadTokens: t.cacheRead, cacheWriteTokens: t.cacheCreation
    }),
    board: (section, markdown) => d.hive.writeBoardSection(section, markdown),
    log: (event) => d.hive.appendLog(event),
    onProgress: (snap) => d.sendToRenderer('lab:progress', snap),
    onState: (view) => d.sendToRenderer('lab:state', view),
    ignoreInGit: (name) => d.hive.ensureGitignored(name)
  }, { token: d.token });

  return {
    mode,
    async start() {
      if (!mode().enabled) return { ok: false, error: 'lab mode is off' };
      if (!d.hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
      if (server?.listening()) return { ok: true, port: server.boundPort() };
      try { seatGod(); } catch (e) { return { ok: false, error: `could not seat the lab god: ${e instanceof Error ? e.message : String(e)}` }; }
      server = build();
      const r = await server.start();
      if (!r.ok) server = null;
      return r;
    },
    stop() { try { server?.stop(); } catch { /* noop */ } server = null; },
    server: () => server,
    state: () => server?.view() ?? null,
    progress: () => server?.latestProgress() ?? null,
    approve: (gateId, answer) => server?.approve(gateId, answer).length ?? 0,
    setPaused: (paused) => server?.setPaused(paused) ?? null
  };
}
