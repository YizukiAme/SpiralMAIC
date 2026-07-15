import { describe, expect, it } from 'vitest';

import { mergeAgentLoopMessages } from '@/lib/chat/session-messages';
import type { ChatMessageMetadata } from '@/lib/types/chat';
import type { UIMessage } from 'ai';

function message(
  id: string,
  role: UIMessage<ChatMessageMetadata>['role'],
  text: string,
): UIMessage<ChatMessageMetadata> {
  return {
    id,
    role,
    parts: [{ type: 'text', text }],
    metadata: { createdAt: 1 },
  };
}

describe('mergeAgentLoopMessages', () => {
  it('keeps the current user message when a new live session is still empty', () => {
    const currentUser = message('user-current', 'user', '本轮消息');

    expect(mergeAgentLoopMessages([currentUser], [])).toEqual([currentUser]);
  });

  it('does not let a stale live snapshot overwrite the current turn baseline', () => {
    const previousUser = message('user-previous', 'user', '上一轮消息');
    const previousAssistant = message('assistant-previous', 'assistant', '上一轮回答');
    const currentUser = message('user-current', 'user', '这一轮一定要看到');

    expect(
      mergeAgentLoopMessages(
        [previousUser, previousAssistant, currentUser],
        [previousUser, previousAssistant],
      ),
    ).toEqual([previousUser, previousAssistant, currentUser]);
  });

  it('uses the latest live version for a message with the same id', () => {
    const baselineAssistant = message('assistant-current', 'assistant', '正在');
    const liveAssistant = message('assistant-current', 'assistant', '正在生成完整回答');

    expect(mergeAgentLoopMessages([baselineAssistant], [liveAssistant])).toEqual([liveAssistant]);
  });

  it('appends live-only agent messages once and in live order', () => {
    const currentUser = message('user-current', 'user', '本轮消息');
    const firstAgent = message('assistant-1', 'assistant', '第一位老师');
    const secondAgent = message('assistant-2', 'assistant', '第二位老师');

    expect(
      mergeAgentLoopMessages([currentUser], [currentUser, firstAgent, secondAgent, firstAgent]),
    ).toEqual([currentUser, firstAgent, secondAgent]);
  });
});
