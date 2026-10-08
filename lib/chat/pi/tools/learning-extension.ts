import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { nanoid } from 'nanoid';
import { validateOvertimeChatContext } from '@/lib/overtime/chat';
import { parseRequestLearningExtensionParams } from '@/lib/overtime/types';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest } from '@/lib/types/chat';
import type { SendEvent } from '../types';

const ExtensionParams = Type.Object({
  disposition: Type.Union([Type.Literal('append_page'), Type.Literal('new_course')]),
  topic: Type.String({ minLength: 1 }),
  teachingMove: Type.Union([
    Type.Literal('extend'),
    Type.Literal('remediate'),
    Type.Literal('apply'),
    Type.Literal('trace'),
  ]),
  reason: Type.Optional(Type.String()),
});

/** A request only: the client creates the owner-bound, durable generation task. */
export function buildLearningExtensionTools(opts: {
  body: StatelessChatRequest;
  agent: AgentConfig;
  messageId: string;
  send: SendEvent;
  onActionDone?: () => void;
}): AgentTool[] {
  if (
    !validateOvertimeChatContext(opts.body.config.overtimeContext, opts.body.storeState) ||
    (opts.agent.role !== 'teacher' && opts.agent.role !== 'assistant')
  )
    return [];

  let dispatched = false;
  return [
    {
      name: 'request_learning_extension',
      label: 'Request learning extension',
      description:
        'After answering the learner, request one durable follow-up page, or a new course for a multi-page/off-topic request. This submits a request and never means the page is ready.',
      parameters: ExtensionParams,
      executionMode: 'sequential',
      execute: async (_callId, value, signal) => {
        signal?.throwIfAborted();
        const params = parseRequestLearningExtensionParams(value);
        if (!params) throw new Error('Invalid learning extension parameters');
        if (dispatched)
          return {
            content: [
              { type: 'text', text: 'A learning extension was already requested this turn.' },
            ],
            details: {},
          };
        dispatched = true;
        const actionId = nanoid();
        await opts.send({
          type: 'action',
          data: {
            actionId,
            actionName: 'request_learning_extension',
            params: { ...params },
            agentId: opts.agent.id,
            messageId: opts.messageId,
          },
        });
        opts.onActionDone?.();
        return {
          content: [
            {
              type: 'text',
              text: 'Learning extension request dispatched; generation is not yet complete.',
            },
          ],
          details: {
            actionId,
            actionName: 'request_learning_extension',
            params,
            dispatchedAction: true,
          },
        };
      },
    },
  ];
}
