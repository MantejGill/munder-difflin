/**
 * Lab mode: the app as the live office of a research lab.
 *
 * In lab mode the god seat (Michael's room) is NOT a Claude Code terminal. It is a PTY-less agent whose
 * name, role and prompt come from the lab config (default "Dwight"), and an external orchestration loop
 * drives the floor over the loopback lab control server (src/main/labControl.ts). Outside lab mode none
 * of this runs and the app behaves exactly as before.
 *
 * Pure and dependency-free so main, renderer and the node:test suite share one definition.
 */

/** The id of the god seat. Same constant the renderer (`useHive.ts`) and the router use. */
export const LAB_GOD_ID = 'god';
export const DEFAULT_LAB_GOD_NAME = 'Dwight';
export const DEFAULT_LAB_GOD_ROLE = 'Lab orchestrator (Opus)';
const MAX_NAME = 40;
const MAX_ROLE = 120;
const MAX_PROMPT = 8000;

/** What may be stored in config.json under `lab`. Every field is optional. */
export interface LabConfigInput {
  enabled?: boolean;
  godName?: string;
  godRole?: string;
  godPrompt?: string;
}

export interface LabMode {
  /** Lab mode on: control server running, god seat replaced. */
  enabled: boolean;
  godId: string;
  godName: string;
  godRole: string;
  /** The orchestrator's contract (identity.md of the god seat, and what the loop reads from /lab/state). */
  godPrompt: string;
}

/** The environment variable that turns lab mode on (the issue's `MD_LAB_CONTROL=1`). */
export const LAB_ENV_FLAG = 'MD_LAB_CONTROL';

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? '').trim());
}

/** Single-line, control-character-free, length-capped text. */
export function cleanLabText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The default orchestrator contract, parameterised by the seat's name. */
export function defaultLabGodPrompt(name: string): string {
  return [
    `You are ${name}, the orchestrator of a research lab. You run the lab campaign: you grant trials to the executors,`,
    'review plans, answer the red team, escalate the method ladder when progress plateaus, and own the budget.',
    'You are not a terminal: the lab loop drives you and the office shows what you do. Do not guess results; every claim',
    'cites evidence. A reframe proposal must be tested with the budget reserved for it, and its measured gain is compared',
    'with the prediction. Stop and ask the human (a blocked card) for an invariant violation or a budget stop.'
  ].join(' ');
}

/**
 * Resolve lab mode from the stored config and the environment. The environment wins for the on/off switch and the
 * name/role, so a one-off `MD_LAB_CONTROL=1 MD_LAB_GOD_NAME=Dwight npm run dev` needs no config edit.
 */
export function resolveLabMode(
  input: LabConfigInput | undefined | null,
  env: Record<string, string | undefined> = {}
): LabMode {
  const cfg = input && typeof input === 'object' ? input : {};
  const enabled = truthy(env[LAB_ENV_FLAG]) || cfg.enabled === true;
  const godName = cleanLabText(env.MD_LAB_GOD_NAME, MAX_NAME) || cleanLabText(cfg.godName, MAX_NAME) || DEFAULT_LAB_GOD_NAME;
  const godRole = cleanLabText(env.MD_LAB_GOD_ROLE, MAX_ROLE) || cleanLabText(cfg.godRole, MAX_ROLE) || DEFAULT_LAB_GOD_ROLE;
  const prompt = typeof cfg.godPrompt === 'string' ? cfg.godPrompt.replace(/\r/g, '').trim().slice(0, MAX_PROMPT) : '';
  return {
    enabled,
    godId: LAB_GOD_ID,
    godName,
    godRole,
    godPrompt: prompt || defaultLabGodPrompt(godName)
  };
}

/**
 * The floor-card fields of the god seat in lab mode. `character` is the cast member whose name matches the seat (so
 * "Dwight" gets the Dwight sprite) and falls back to Michael's, the boss sprite, for any other name.
 */
export function labGodCard(
  mode: Pick<LabMode, 'godName' | 'godRole'>,
  castNames: readonly string[]
): { character: string; accent: string; description: string; action: string } {
  const wanted = mode.godName.trim().toLowerCase();
  const character = castNames.find((n) => n.toLowerCase() === wanted) ?? 'michael';
  return {
    character,
    accent: 'lemon',
    description: mode.godRole,
    action: 'running the lab'
  };
}

/** The `identity.md` body of the god seat in lab mode. */
export function labGodIdentity(mode: LabMode): string {
  return [
    `# ${mode.godName} (${mode.godId})`,
    '',
    `- Role: ${mode.godRole}`,
    '- Seat: the god seat. No terminal: driven by the lab loop over the lab control server.',
    '',
    mode.godPrompt,
    ''
  ].join('\n');
}
