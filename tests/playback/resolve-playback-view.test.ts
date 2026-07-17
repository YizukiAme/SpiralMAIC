import { describe, expect, it } from 'vitest';

import { resolvePlaybackView } from '@/lib/playback';

describe('resolvePlaybackView', () => {
  it('derives a live discussion view for Spiral speech when no standard playback view exists', () => {
    const view = resolvePlaybackView(undefined, {
      engineMode: 'live',
      lectureSpeech: null,
      liveSpeech: '请解释这一页的核心概念。',
      speakingAgentId: 'student-1',
      thinkingState: null,
      isCueUser: false,
      isTopicPending: false,
      chatIsStreaming: true,
      discussionTrigger: null,
      playbackCompleted: false,
      idleText: null,
      speakingStudent: true,
      sessionType: 'qa',
    });

    expect(view).toMatchObject({
      phase: 'discussionActive',
      sourceText: '请解释这一页的核心概念。',
      bubbleRole: 'agent',
      isInLiveFlow: true,
    });
  });
});
