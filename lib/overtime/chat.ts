import { courseIsComplete } from '@/lib/classroom/course-end';
import type { OvertimeChatContext } from '@/lib/overtime/types';
import type { StatelessChatRequest } from '@/lib/types/chat';
import type { Scene } from '@/lib/types/stage';
import type { AgentConfig } from '@/lib/orchestration/registry/types';

export function selectOvertimeInstructorIds(
  agents: Pick<AgentConfig, 'id' | 'role' | 'priority'>[],
): string[] {
  const byPriority = (a: Pick<AgentConfig, 'priority'>, b: Pick<AgentConfig, 'priority'>) =>
    (b.priority ?? 0) - (a.priority ?? 0);
  const teacher = agents.filter((agent) => agent.role === 'teacher').sort(byPriority)[0];
  if (teacher) return [teacher.id];
  const assistant = agents.filter((agent) => agent.role === 'assistant').sort(byPriority)[0];
  return assistant ? [assistant.id] : [];
}

export function buildOvertimeChatContext(args: {
  stageId?: string;
  currentSceneId: string | null;
  scenes: Scene[];
  generationComplete: boolean;
  activeDemoSessionId: string | null;
  /** The completed-course card now overlays the final real page. */
  courseEndOpen?: boolean;
}): OvertimeChatContext | undefined {
  if (!args.stageId || args.activeDemoSessionId) return undefined;

  if (
    args.generationComplete &&
    (args.currentSceneId === '__pending__' ||
      (args.courseEndOpen && args.currentSceneId === args.scenes.at(-1)?.id))
  ) {
    return {
      stageId: args.stageId,
      entry: 'course_complete',
      formal: true,
    };
  }

  const currentScene = args.scenes.find((scene) => scene.id === args.currentSceneId);
  if (!currentScene?.overtime?.extensionId) return undefined;
  return {
    stageId: args.stageId,
    entry: 'overtime_page',
    formal: true,
  };
}

/**
 * Resolve overtime eligibility from the live classroom state at the exact
 * moment a learner sends a message. Older courses may not have persisted the
 * `generationComplete` flag, so retain the classroom's materialized-outline
 * fallback instead of relying on a React prop that can lag one render behind.
 */
export function buildOvertimeRequestContext(args: {
  stageId?: string;
  currentSceneId: string | null;
  scenes: Scene[];
  generationComplete: boolean;
  outlineCount: number;
  generatingOutlineCount: number;
  activeDemoSessionId: string | null;
  /** The completed-course card now overlays the final real page. */
  courseEndOpen?: boolean;
}): OvertimeChatContext | undefined {
  const courseComplete = courseIsComplete({
    generationComplete: args.generationComplete,
    outlineCount: args.outlineCount,
    sceneCount: args.scenes.length,
    generatingCount: args.generatingOutlineCount,
    agentBuilding: false,
  });

  return buildOvertimeChatContext({
    stageId: args.stageId,
    currentSceneId: args.currentSceneId,
    scenes: args.scenes,
    generationComplete: courseComplete,
    activeDemoSessionId: args.activeDemoSessionId,
    courseEndOpen: args.courseEndOpen,
  });
}

export function validateOvertimeChatContext(
  value: unknown,
  storeState: StatelessChatRequest['storeState'],
): OvertimeChatContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const context = value as Partial<OvertimeChatContext>;
  if (context.formal !== true || !context.stageId || context.stageId !== storeState.stage?.id) {
    return undefined;
  }
  if (
    context.entry === 'course_complete' &&
    (storeState.currentSceneId === '__pending__' ||
      (storeState.scenes.length > 0 && storeState.currentSceneId === storeState.scenes.at(-1)?.id))
  ) {
    return context as OvertimeChatContext;
  }
  if (context.entry === 'overtime_page') {
    const scene = storeState.scenes.find((candidate) => candidate.id === storeState.currentSceneId);
    if (scene?.overtime?.extensionId) return context as OvertimeChatContext;
  }
  return undefined;
}

export function getOvertimeAgentActions(
  actions: string[],
  role: string,
  context?: OvertimeChatContext,
): string[] {
  if (!context || (role !== 'teacher' && role !== 'assistant')) return actions;
  return ['request_learning_extension'];
}
