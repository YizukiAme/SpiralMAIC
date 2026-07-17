import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getSpiralAgentPreparationAction,
  isValidSpiralAgentRoster,
  saveStageSpiralAgents,
} from '@/lib/revisit/spiral-agents';
import { db } from '@/lib/utils/database';
import { loadStageData } from '@/lib/utils/stage-storage';
import type { PersistedAgentConfig, Stage } from '@/lib/types/stage';

const assistant: PersistedAgentConfig = {
  id: 'spiral-assistant',
  name: 'Ari',
  role: 'assistant',
  persona: 'Supports the learner-teacher.',
  avatar: '/avatars/assist.png',
  color: '#111111',
  priority: 7,
  voiceDesign: {
    identity: 'young adult assistant',
    texture: 'warm clear',
    delivery: 'calm encouraging',
  },
};

const students: PersistedAgentConfig[] = [
  {
    id: 'spiral-student-1',
    name: 'Bo',
    role: 'student',
    persona: 'Questions definitions.',
    avatar: '/avatars/curious.png',
    color: '#222222',
    priority: 5,
  },
  {
    id: 'spiral-student-2',
    name: 'Cy',
    role: 'student',
    persona: 'Tests examples.',
    avatar: '/avatars/thinker.png',
    color: '#333333',
    priority: 4,
  },
];

const stage: Stage = {
  id: 'stage-spiral-agents',
  name: 'Fallacies',
  createdAt: 1,
  updatedAt: 1,
};

describe('Spiral agent roster persistence', () => {
  beforeEach(async () => {
    await Promise.all([db.stages.clear(), db.scenes.clear(), db.generatedAgents.clear()]);
  });

  afterEach(async () => {
    await Promise.all([db.stages.clear(), db.scenes.clear(), db.generatedAgents.clear()]);
  });

  it('accepts only one assistant plus two or three students', () => {
    expect(isValidSpiralAgentRoster([assistant, ...students])).toBe(true);
    expect(
      isValidSpiralAgentRoster([
        assistant,
        ...students,
        { ...students[0], id: 'spiral-student-3' },
      ]),
    ).toBe(true);
    expect(isValidSpiralAgentRoster([assistant, students[0]])).toBe(false);
    expect(isValidSpiralAgentRoster([{ ...assistant, role: 'teacher' }, ...students])).toBe(false);
    expect(
      isValidSpiralAgentRoster([assistant, { ...assistant, id: 'assistant-2' }, ...students]),
    ).toBe(false);
  });

  it('selects generation, reveal recovery, or continuation without another model call', () => {
    expect(getSpiralAgentPreparationAction(undefined, undefined)).toBe('generate');
    expect(getSpiralAgentPreparationAction([assistant, ...students], 'pending-reveal')).toBe(
      'reveal',
    );
    expect(getSpiralAgentPreparationAction([assistant, ...students], 'revealed')).toBe('continue');
    expect(getSpiralAgentPreparationAction([assistant, ...students], undefined)).toBe('continue');
  });

  it('round-trips the roster on the stage without changing normal generated agents', async () => {
    await db.stages.put(stage);
    await db.generatedAgents.put({
      id: 'gen-course-teacher',
      stageId: stage.id,
      name: 'Course teacher',
      role: 'teacher',
      persona: 'Teaches the normal lesson.',
      avatar: '/avatars/teacher.png',
      color: '#444444',
      priority: 10,
      createdAt: 1,
    });

    await saveStageSpiralAgents(stage.id, [assistant, ...students], 20);

    const loaded = await loadStageData(stage.id);
    expect(loaded?.stage.spiralAgentConfigs).toEqual([assistant, ...students]);
    expect(
      (await db.generatedAgents.where('stageId').equals(stage.id).toArray()).map((a) => a.id),
    ).toEqual(['gen-course-teacher']);
  });
});
