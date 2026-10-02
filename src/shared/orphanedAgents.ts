import { isPtylessProvider, type AgentProvider } from './agentProvider';

/**
 * Which registry agents the app-start sweep (`archiveOrphanedAgents`, main/index.ts) should archive.
 *
 * An orphan is an agent that is not archived, is not the god, and owns no live PTY. A PTY-less provider
 * (`lab`) never owns a PTY by design, so "no live PTY" says nothing about it: its driver (the lab
 * loop) re-registers it and it must stay active, otherwise every app launch would archive the lab's
 * whole team and wipe it from the floor.
 */
export function selectOrphansToArchive(
  agents: Record<string, { archived?: boolean; provider?: AgentProvider }>,
  godId: string | null,
  hasLivePty: (id: string) => boolean
): string[] {
  const orphans: string[] = [];
  for (const [id, a] of Object.entries(agents)) {
    if (a.archived) continue;
    if (id === godId) continue; // god is never archived
    if (isPtylessProvider(a.provider)) continue; // lab agents have no terminal by design
    if (hasLivePty(id)) continue; // has a live PTY: genuinely active
    orphans.push(id);
  }
  return orphans;
}
