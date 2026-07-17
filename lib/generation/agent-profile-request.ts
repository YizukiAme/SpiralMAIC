export const AGENT_AVATAR_CATALOG = [
  {
    path: '/avatars/teacher.png',
    desc: 'Male teacher with glasses, holding a book, green background',
  },
  {
    path: '/avatars/teacher-2.png',
    desc: 'Female teacher with long dark hair, blue traditional outfit, gentle expression',
  },
  {
    path: '/avatars/assist.png',
    desc: 'Young female assistant with glasses, pink background, friendly smile',
  },
  {
    path: '/avatars/assist-2.png',
    desc: 'Young female in orange top and purple overalls, cheerful and approachable',
  },
  {
    path: '/avatars/clown.png',
    desc: 'Energetic girl with glasses pointing up, green shirt, lively and fun',
  },
  {
    path: '/avatars/clown-2.png',
    desc: 'Playful girl with curly hair doing rock gesture, blue shirt, humorous vibe',
  },
  {
    path: '/avatars/curious.png',
    desc: 'Surprised boy with glasses, hand on cheek, curious expression',
  },
  {
    path: '/avatars/curious-2.png',
    desc: 'Boy with backpack holding a book and question mark bubble, inquisitive',
  },
  {
    path: '/avatars/note-taker.png',
    desc: 'Studious boy with glasses, blue shirt, calm and organized',
  },
  {
    path: '/avatars/note-taker-2.png',
    desc: 'Active boy with yellow backpack waving, blue outfit, enthusiastic learner',
  },
  {
    path: '/avatars/thinker.png',
    desc: 'Thoughtful girl with hand on chin, purple background, contemplative',
  },
  {
    path: '/avatars/thinker-2.png',
    desc: 'Girl reading a book intently, long dark hair, intellectual and focused',
  },
] as const;

export interface AvailableAgentVoice {
  providerId: string;
  voiceId: string;
  voiceName: string;
  voiceLanguage?: string;
}

export function buildAgentProfileRequestBody(args: {
  mode: 'course' | 'spiral';
  stageInfo: { name: string; description?: string };
  sceneOutlines: Array<{ title: string; description?: string }>;
  languageDirective: string;
  availableVoices: AvailableAgentVoice[];
}) {
  return {
    mode: args.mode,
    stageInfo: args.stageInfo,
    sceneOutlines: args.sceneOutlines,
    languageDirective: args.languageDirective,
    availableAvatars: AGENT_AVATAR_CATALOG.map((avatar) => avatar.path),
    avatarDescriptions: AGENT_AVATAR_CATALOG.map((avatar) => ({ ...avatar })),
    availableVoices: args.availableVoices,
  };
}
