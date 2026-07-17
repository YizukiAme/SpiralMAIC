import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildLegacyRevisitAgentRoster,
  getSpiralAgentPreparationAction,
  hydrateSpiralAgentRegistry,
  isValidSpiralAgentRoster,
  resolveAttemptSpiralAgentRoster,
  saveStageSpiralAgents,
} from '@/lib/revisit/spiral-agents';
import { resolveRevisitAgentIds } from '@/lib/revisit/session';
import { db } from '@/lib/utils/database';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
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

  it('uses a complete legacy generated roster only for completed attempts', () => {
    const legacyStage: Stage = {
      ...stage,
      generatedAgentConfigs: [
        {
          ...assistant,
          id: 'legacy-teacher',
          role: 'teacher',
        },
        assistant,
        ...students,
      ],
    };

    expect(resolveAttemptSpiralAgentRoster(legacyStage, 'completed')).toEqual([
      assistant,
      ...students,
    ]);
    expect(resolveAttemptSpiralAgentRoster(legacyStage, 'preparing')).toBeNull();
  });

  it('keeps explicit Spiral and complete generated rosters ahead of compatibility defaults', () => {
    const generatedRoster = [assistant, ...students];
    const explicitRoster = [
      { ...assistant, id: 'explicit-assistant' },
      { ...students[0], id: 'explicit-student-1' },
      { ...students[1], id: 'explicit-student-2' },
    ];

    expect(
      resolveAttemptSpiralAgentRoster(
        { ...stage, spiralAgentConfigs: explicitRoster, generatedAgentConfigs: generatedRoster },
        'completed',
      ),
    ).toEqual(explicitRoster);
    expect(
      resolveAttemptSpiralAgentRoster(
        { ...stage, generatedAgentConfigs: generatedRoster },
        'completed',
      ),
    ).toEqual(generatedRoster);
  });

  it('reconstructs the historical default roster only for completed attempts', () => {
    const roster = resolveAttemptSpiralAgentRoster(stage, 'completed');

    expect(roster?.map(({ id, name, role }) => ({ id, name, role }))).toEqual([
      { id: 'legacy-revisit-default-2', name: 'AI助教', role: 'assistant' },
      { id: 'legacy-revisit-default-4', name: '好奇宝宝', role: 'student' },
      { id: 'legacy-revisit-default-3', name: '显眼包', role: 'student' },
      { id: 'legacy-revisit-default-5', name: '笔记员', role: 'student' },
    ]);
    expect(resolveRevisitAgentIds(roster ?? [])).toEqual({
      assistantAgentId: 'legacy-revisit-default-2',
      studentAgentId: 'legacy-revisit-default-4',
      studentAgentIds: [
        'legacy-revisit-default-4',
        'legacy-revisit-default-3',
        'legacy-revisit-default-5',
      ],
    });
    expect(resolveAttemptSpiralAgentRoster(stage, 'ready')).toBeNull();
  });

  it('copies complete runtime metadata and rejects an incomplete built-in set', () => {
    const defaults = useAgentRegistry.getState().listAgents();
    const roster = buildLegacyRevisitAgentRoster(defaults);
    const original = defaults.find((agent) => agent.id === 'default-2');

    expect(roster?.[0]).toMatchObject({
      name: original?.name,
      role: original?.role,
      persona: original?.persona,
      avatar: original?.avatar,
      color: original?.color,
      priority: original?.priority,
    });
    expect(roster?.[0]?.voiceConfig).toEqual(original?.voiceConfig);
    expect(roster?.[0]?.voiceDesign).toEqual(original?.voiceDesign);
    expect(
      buildLegacyRevisitAgentRoster(defaults.filter((agent) => agent.id !== 'default-5')),
    ).toBeNull();
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

  it('hydrates only the runtime registry and leaves normal generated records intact', async () => {
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

    hydrateSpiralAgentRegistry(stage.id, [assistant, ...students]);

    expect(
      useAgentRegistry
        .getState()
        .listAgents()
        .filter((agent) => agent.isGenerated)
        .map((agent) => agent.id),
    ).toEqual([assistant.id, ...students.map((student) => student.id)]);
    expect(await db.generatedAgents.get('gen-course-teacher')).toBeDefined();
  });

  it('hydrates compatibility defaults without mutating built-ins or IndexedDB', async () => {
    const defaultBefore = useAgentRegistry.getState().getAgent('default-2');
    const roster = resolveAttemptSpiralAgentRoster(stage, 'completed');
    expect(roster).not.toBeNull();

    hydrateSpiralAgentRegistry(stage.id, roster!);

    expect(useAgentRegistry.getState().getAgent('default-2')).toEqual(defaultBefore);
    expect(
      useAgentRegistry
        .getState()
        .listAgents()
        .filter((agent) => agent.isGenerated)
        .map((agent) => agent.id),
    ).toEqual(roster!.map((agent) => agent.id));
    expect(await db.generatedAgents.toArray()).toEqual([]);
  });
});
