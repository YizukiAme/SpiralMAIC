import { Type } from 'typebox';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest } from '@/lib/types/chat';
import type { RevisitAgentPromptContext, RevisitGateStatus } from './types';

export const RevisitGateParams = Type.Object({
  status: Type.Union([
    Type.Literal('pass'),
    Type.Literal('probe'),
    Type.Literal('rescue'),
    Type.Literal('fail'),
  ]),
  pageIndex: Type.Integer({ minimum: 0 }),
  reason: Type.String(),
  nextProbeId: Type.Optional(Type.String()),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  studentStates: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Union([
        Type.Literal('questioning'),
        Type.Literal('uncertain'),
        Type.Literal('satisfied'),
      ]),
    ),
  ),
});

export function revisitResponseDirective(
  status: RevisitGateStatus | undefined,
  fallback: 'probe' | 'rescue' = 'probe',
): RevisitAgentPromptContext['responseDirective'] {
  if (status === 'pass') return 'acknowledge';
  if (status === 'rescue') return 'rescue';
  if (status === 'probe' || status === 'fail') return 'probe';
  return fallback;
}

export function buildRevisitChildContext(context?: RevisitAgentPromptContext): string {
  if (!context) return '';
  const instructions = {
    acknowledge:
      'Directive: ACKNOWLEDGE. Give one brief acceptance or one-sentence summary. Do not ask a question, introduce a new topic, or extend into later pages.',
    probe:
      'Directive: PROBE. Ask exactly one short, concrete question about a genuine unresolved point on the current page. Do not ask about later pages.',
    rescue:
      'Directive: RESCUE. Briefly correct or reframe the current-page explanation to unblock the human teacher. Do not create another question.',
  };
  return [
    '# Reverse Teaching',
    'The human is the teacher. You are responding to their current-page explanation, not taking over the lesson.',
    context.pageContext,
    instructions[context.responseDirective],
  ].join('\n');
}

export function buildRevisitDirectorPrompt(
  body: StatelessChatRequest,
  agents: AgentConfig[],
): string {
  return [
    "You direct a reverse-teaching lesson. The latest human turn is the human teacher's lesson attempt, not a student question.",
    '# Reverse Teaching Gate',
    'Evaluate the current page, then call exactly one student agent (assistant only for rescue), using call_agent.revisitGate to report the assessment.',
    'Do NOT output an agent whose role is teacher. The human is teaching this page.',
    'After the listener responds, the runtime hands the turn back to the human. Do not close the session or invite multiple agents.',
    'Gate status: pass = covered sufficiently; probe = a genuine unresolved point; rescue = the human is stuck or the page probe cap is reached; fail = material issues remain but rescue is not needed yet.',
    'For pass, choose an AI student for a brief acknowledgment. For probe/fail, ask at most one current-page question. For rescue, choose an assistant to correct or reframe briefly.',
    'Include pageIndex, reason, optional nextProbeId and confidence, and studentStates in revisitGate.',
    'studentStates MUST contain every id listed in active_student_ids and no other id: questioning, uncertain or satisfied.',
    'Use pass only when all active AI students are satisfied. A real question makes its student questioning, not satisfied.',
    'Questions are not participation rewards. Do not invent a probe to satisfy a persona, and never probe later pages.',
    'When a prior question was just resolved, prefer the most recent student whose question was resolved for the acknowledgment.',
    'If you need course evidence, use read_scene before delegation; do not guess it.',
    '# Current page and learner progress',
    body.config.revisitGateContext,
    body.config.revisitProbeContext,
    '# Available agents',
    ...agents.map((agent) => `- id: ${agent.id}, name: ${agent.name}, role: ${agent.role}`),
  ]
    .filter(Boolean)
    .join('\n');
}
