import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest } from '@/lib/types/chat';
import type { RevisitGateDecision } from '@/lib/revisit/types';

type DirectorDecision = {
  nextAgentId: string | null;
  shouldEnd: boolean;
  revisitGate?: RevisitGateDecision;
};

export interface ResolvedDirectorDecision {
  nextAgentId: string | null;
  shouldEnd: boolean;
  cueUser: boolean;
  fallbackUsed: boolean;
}

export function resolveDirectorDecisionForAvailableAgents({
  decision,
  agents,
  revisitMode,
  agentRespondedAfterLatestHuman = false,
  revisitFallbackDirective = 'probe',
}: {
  decision: DirectorDecision;
  agents: Pick<AgentConfig, 'id' | 'role' | 'priority'>[];
  revisitMode: boolean;
  agentRespondedAfterLatestHuman?: boolean;
  revisitFallbackDirective?: 'probe' | 'rescue';
}): ResolvedDirectorDecision {
  const effectiveGateStatus = decision.revisitGate?.status ?? revisitFallbackDirective;
  const fallbackAgentId = revisitMode
    ? selectRevisitFallbackAgentId(agents, effectiveGateStatus)
    : null;

  if (decision.nextAgentId === 'USER') {
    if (revisitMode && !agentRespondedAfterLatestHuman && fallbackAgentId) {
      return {
        nextAgentId: fallbackAgentId,
        shouldEnd: false,
        cueUser: false,
        fallbackUsed: true,
      };
    }
    return {
      nextAgentId: null,
      shouldEnd: true,
      cueUser: true,
      fallbackUsed: false,
    };
  }

  if (decision.shouldEnd || !decision.nextAgentId) {
    if (revisitMode && !agentRespondedAfterLatestHuman && fallbackAgentId) {
      return {
        nextAgentId: fallbackAgentId,
        shouldEnd: false,
        cueUser: false,
        fallbackUsed: true,
      };
    }
    return {
      nextAgentId: null,
      shouldEnd: true,
      cueUser: false,
      fallbackUsed: false,
    };
  }

  const selectedAgent = agents.find((agent) => agent.id === decision.nextAgentId);
  const requiredRevisitRole = effectiveGateStatus === 'rescue' ? 'assistant' : 'student';
  if (
    selectedAgent &&
    (!revisitMode ||
      (selectedAgent.role !== 'teacher' && selectedAgent.role === requiredRevisitRole))
  ) {
    return {
      nextAgentId: decision.nextAgentId,
      shouldEnd: false,
      cueUser: false,
      fallbackUsed: false,
    };
  }

  if (revisitMode && fallbackAgentId) {
    return {
      nextAgentId: fallbackAgentId,
      shouldEnd: false,
      cueUser: false,
      fallbackUsed: true,
    };
  }

  return {
    nextAgentId: null,
    shouldEnd: true,
    cueUser: false,
    fallbackUsed: false,
  };
}

export function hasAgentResponseAfterLatestHumanTurn(
  messages: StatelessChatRequest['messages'],
): boolean {
  const latestHumanIndex = messages.findLastIndex((message) => message.role === 'user');
  if (latestHumanIndex < 0) return false;
  return messages.slice(latestHumanIndex + 1).some((message) => message.role === 'assistant');
}

function selectRevisitFallbackAgentId(
  agents: Pick<AgentConfig, 'id' | 'role' | 'priority'>[],
  gateStatus?: string,
): string | null {
  const byPriority = (a: Pick<AgentConfig, 'priority'>, b: Pick<AgentConfig, 'priority'>) =>
    (b.priority ?? 0) - (a.priority ?? 0);
  const students = agents.filter((agent) => agent.role === 'student').sort(byPriority);
  const assistants = agents.filter((agent) => agent.role === 'assistant').sort(byPriority);

  if (gateStatus === 'rescue') {
    return assistants[0]?.id ?? null;
  }
  return students[0]?.id ?? null;
}
