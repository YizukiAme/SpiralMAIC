import type { PersistedAgentConfig } from '@/lib/types/stage';
import { db } from '@/lib/utils/database';
import { withStagePersistenceLock } from '@/lib/utils/stage-persistence-lock';

export function isValidSpiralAgentRoster(
  agents: readonly PersistedAgentConfig[] | null | undefined,
): agents is PersistedAgentConfig[] {
  if (!agents || agents.length < 3 || agents.length > 4) return false;
  const assistants = agents.filter((agent) => agent.role === 'assistant');
  const students = agents.filter((agent) => agent.role === 'student');
  return (
    assistants.length === 1 &&
    students.length >= 2 &&
    students.length <= 3 &&
    assistants.length + students.length === agents.length
  );
}

export function getSpiralAgentPreparationAction(
  agents: readonly PersistedAgentConfig[] | null | undefined,
  state: 'pending-reveal' | 'revealed' | undefined,
): 'generate' | 'reveal' | 'continue' {
  if (!isValidSpiralAgentRoster(agents)) return 'generate';
  return state === 'pending-reveal' ? 'reveal' : 'continue';
}

export async function saveStageSpiralAgents(
  stageId: string,
  agents: readonly PersistedAgentConfig[],
  now = Date.now(),
): Promise<void> {
  if (!isValidSpiralAgentRoster(agents)) {
    throw new Error('Invalid Spiral agent roster.');
  }
  await withStagePersistenceLock(stageId, async () => {
    const updated = await db.stages.update(stageId, {
      spiralAgentConfigs: structuredClone(agents),
      updatedAt: now,
    });
    if (updated !== 1) throw new Error(`Could not persist Spiral agents for stage ${stageId}.`);
  });
}
