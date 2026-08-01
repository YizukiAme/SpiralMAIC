import type { PersistedAgentConfig, Stage } from '@/lib/types/stage';
import type { RevisitAttemptStatus } from '@/lib/revisit/types';
import { mutateDocument } from '@/lib/document-store';
import {
  applyGeneratedAgentsToRegistry,
  useAgentRegistry,
} from '@/lib/orchestration/registry/store';
import type { AgentConfig } from '@/lib/orchestration/registry/types';

const LEGACY_REVISIT_DEFAULT_AGENTS = [
  { id: 'default-2', role: 'assistant' },
  { id: 'default-4', role: 'student' },
  { id: 'default-3', role: 'student' },
  { id: 'default-5', role: 'student' },
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
  const defaults: AgentConfig[] = [];
  for (const descriptor of LEGACY_REVISIT_DEFAULT_AGENTS) {
    const agent = byId.get(descriptor.id);
    if (!agent || agent.isDefault !== true || agent.role !== descriptor.role) return null;
    defaults.push(agent);
  }

  const roster = defaults.map((agent) => {
    return {
      id: `legacy-revisit-${agent.id}`,
      name: agent.name,
      role: agent.role,
      persona: agent.persona,
      avatar: agent.avatar,
      color: agent.color,
      priority: agent.priority,
      ...(agent.voiceConfig ? { voiceConfig: structuredClone(agent.voiceConfig) } : {}),
      ...(agent.voiceDesign ? { voiceDesign: structuredClone(agent.voiceDesign) } : {}),
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
  await mutateDocument(stageId, async (document, store) => {
    if (!document) throw new Error(`Could not persist Spiral agents for stage ${stageId}.`);
    const nextStage: Stage = {
      ...(document.stage as Stage),
      spiralAgentConfigs: structuredClone(agents),
      updatedAt: now,
    };
    await store.putStage(stageId, nextStage);
  });
}

export function hydrateSpiralAgentRegistry(
  stageId: string,
  agents: readonly PersistedAgentConfig[],
): void {
  if (!isValidSpiralAgentRoster(agents)) throw new Error('Invalid Spiral agent roster.');
  applyGeneratedAgentsToRegistry(stageId, agents);
}
