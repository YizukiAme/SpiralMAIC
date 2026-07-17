import { describe, expect, it } from 'vitest';

import {
  AGENT_AVATAR_CATALOG,
  buildAgentProfileRequestBody,
} from '@/lib/generation/agent-profile-request';

describe('agent profile request builder', () => {
  it('shares avatars, voices, and mode across course and Spiral generation', () => {
    const body = buildAgentProfileRequestBody({
      mode: 'spiral',
      stageInfo: { name: 'Algebra', description: 'Equations' },
      sceneOutlines: [{ title: 'Balance', description: 'Keep both sides equal.' }],
      languageDirective: 'Respond in English.',
      availableVoices: [
        {
          providerId: 'browser-native-tts',
          voiceId: 'voice-1',
          voiceName: 'Voice One',
          voiceLanguage: 'en-US',
        },
      ],
    });

    expect(body).toMatchObject({
      mode: 'spiral',
      stageInfo: { name: 'Algebra' },
      availableAvatars: AGENT_AVATAR_CATALOG.map((avatar) => avatar.path),
      avatarDescriptions: AGENT_AVATAR_CATALOG,
      availableVoices: [{ voiceId: 'voice-1' }],
    });
  });
});
