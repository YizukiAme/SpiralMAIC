import type { PersistedAgentConfig, Stage } from '@/lib/types/stage';
import type { RevisitAttemptStatus } from '@/lib/revisit/types';
import { db } from '@/lib/utils/database';
import { withStagePersistenceLock } from '@/lib/utils/stage-persistence-lock';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { getActionsForRole } from '@/lib/orchestration/registry/types';
import type { AgentConfig } from '@/lib/orchestration/registry/types';

const LEGACY_REVISIT_DEFAULT_AGENT_IDS = [
  'default-2',
  'default-4',
  'default-3',
  'default-5',
] as const;

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

export function buildLegacyRevisitAgentRoster(
  candidates: readonly AgentConfig[],
): PersistedAgentConfig[] | null {
  const byId = new Map(candidates.map((agent) => [agent.id, agent]));
  const defaults = LEGACY_REVISIT_DEFAULT_AGENT_IDS.map((id) => byId.get(id));
  if (defaults.some((agent) => !agent)) return null;

  const roster = defaults.map((agent) => {
    const resolved = agent!;
    return {
      id: `legacy-revisit-${resolved.id}`,
      name: resolved.name,
      role: resolved.role,
      persona: resolved.persona,
      avatar: resolved.avatar,
      color: resolved.color,
      priority: resolved.priority,
      ...(resolved.voiceConfig ? { voiceConfig: structuredClone(resolved.voiceConfig) } : {}),
      ...(resolved.voiceDesign ? { voiceDesign: structuredClone(resolved.voiceDesign) } : {}),
    };
  });
  return isValidSpiralAgentRoster(roster) ? roster : null;
}

export function resolveAttemptSpiralAgentRoster(
  stage: Stage,
  status: RevisitAttemptStatus,
): PersistedAgentConfig[] | null {
  if (isValidSpiralAgentRoster(stage.spiralAgentConfigs)) return stage.spiralAgentConfigs;
  if (status !== 'completed') return null;
  const legacyCandidates = stage.generatedAgentConfigs?.filter(
    (agent) => agent.role === 'assistant' || agent.role === 'student',
  );
  if (isValidSpiralAgentRoster(legacyCandidates)) return legacyCandidates;
  return buildLegacyRevisitAgentRoster(useAgentRegistry.getState().listAgents());
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

export function hydrateSpiralAgentRegistry(
  stageId: string,
  agents: readonly PersistedAgentConfig[],
): void {
  if (!isValidSpiralAgentRoster(agents)) throw new Error('Invalid Spiral agent roster.');
  const registry = useAgentRegistry.getState();
  for (const agent of registry.listAgents()) {
    if (agent.isGenerated) registry.deleteAgent(agent.id);
  }
  const now = new Date();
  for (const agent of agents) {
    registry.addAgent({
      ...agent,
      allowedActions: getActionsForRole(agent.role),
      createdAt: now,
      updatedAt: now,
      isDefault: false,
      isGenerated: true,
      boundStageId: stageId,
    });
  }
}
