import { describe, expect, it } from 'vitest';

import {
  STUDY_ARTIFACT_GROUPS,
  STUDY_ARTIFACT_KINDS,
  groupArtifactGenerationJobs,
  groupStudyArtifacts,
  latestVisibleArtifactJobs,
  latestStudyArtifactByKind,
} from '@/lib/revisit/studio';
import { buildStudyArtifactSceneChoices } from '@/lib/revisit/artifact-options';
import type { StudyArtifact } from '@/lib/revisit/types';
import type { ArtifactGenerationJob } from '@/lib/revisit/artifact-queue';

function artifact(kind: StudyArtifact['kind'], version: number): StudyArtifact {
  const base = {
    id: `stage-1:${kind}:v${version}`,
    stageId: 'stage-1',
    kind,
    version,
    title: `${kind} ${version}`,
    createdAt: version,
    updatedAt: version,
    stageUpdatedAt: 1,
    language: 'en-US',
    sourceHash: `source-${version}`,
    lessonSourceHash: 'lesson',
    options: {
      focusMode: 'balanced' as const,
      selectedSceneIds: [],
      customInstructions: '',
    },
  };
  if (kind === 'mindMap') {
    return {
      ...base,
      kind,
      options: { ...base.options, depth: 3, includeExamples: true },
      content: { root: { id: 'root', label: 'Root', children: [] } },
    };
  }
  if (kind === 'briefing') {
    return {
      ...base,
      kind,
      options: { ...base.options, orientation: 'portrait', detailLevel: 'standard' },
      content: { blocks: [{ type: 'paragraph', text: 'Briefing' }] },
    };
  }
  if (kind === 'studyGuide') {
    return {
      ...base,
      kind,
      options: { ...base.options, detailLevel: 'standard' },
      content: { blocks: [{ type: 'paragraph', text: 'Guide' }] },
    };
  }
  if (kind === 'faq') {
    return {
      ...base,
      kind,
      options: { ...base.options, count: 10 },
      content: { items: [{ id: 'faq-1', question: 'Q', answer: 'A' }] },
    };
  }
  if (kind === 'flashcards') {
    return {
      ...base,
      kind,
      options: { ...base.options, count: 15, difficulty: 'medium' },
      content: { items: [{ id: 'card-1', front: 'F', back: 'B' }] },
    };
  }
  return {
    ...base,
    kind: 'quiz',
    options: { ...base.options, count: 10, difficulty: 'medium', format: 'mcq' },
    content: {
      items: [
        {
          id: 'quiz-1',
          question: 'Q',
          options: ['A', 'B'],
          answerIndex: 0,
          explanation: 'A',
        },
      ],
    },
  };
}

describe('Spiral Study Studio organization', () => {
  it('numbers selected-page choices from one after sorting by scene order', () => {
    const choices = buildStudyArtifactSceneChoices([
      { id: 'scene-b', order: 2 },
      { id: 'scene-a', order: 1 },
      { id: 'scene-c', order: 3 },
    ]);

    expect(choices.map(({ scene, number }) => ({ id: scene.id, number }))).toEqual([
      { id: 'scene-a', number: 1 },
      { id: 'scene-b', number: 2 },
      { id: 'scene-c', number: 3 },
    ]);
  });

  it('defines all six independent artifact kinds across three semantic groups', () => {
    expect(STUDY_ARTIFACT_KINDS).toEqual([
      'briefing',
      'mindMap',
      'studyGuide',
      'faq',
      'flashcards',
      'quiz',
    ]);
    expect(STUDY_ARTIFACT_GROUPS.map((group) => group.kinds)).toEqual([
      ['briefing', 'studyGuide', 'faq'],
      ['mindMap'],
      ['flashcards', 'quiz'],
    ]);
  });

  it('keeps every version in its semantic group and selects the latest per kind', () => {
    const artifacts = [artifact('faq', 1), artifact('mindMap', 1), artifact('faq', 2)];

    expect(latestStudyArtifactByKind(artifacts).faq?.version).toBe(2);
    const grouped = groupStudyArtifacts(artifacts);
    expect(grouped.understanding.map((item) => item.id)).toEqual([
      'stage-1:faq:v2',
      'stage-1:faq:v1',
    ]);
    expect(grouped.structure[0]?.kind).toBe('mindMap');
    expect(grouped.practice).toEqual([]);
  });

  it('places queued and failed generation placeholders in the same semantic groups', () => {
    const jobs: ArtifactGenerationJob[] = [
      {
        id: 'job-guide',
        stageId: 'stage-1',
        kind: 'studyGuide',
        options: artifact('studyGuide', 1).options,
        status: 'generating',
        createdAt: 10,
        updatedAt: 11,
      },
      {
        id: 'job-map',
        stageId: 'stage-1',
        kind: 'mindMap',
        options: artifact('mindMap', 1).options,
        status: 'queued',
        createdAt: 12,
        updatedAt: 12,
      },
      {
        id: 'job-quiz',
        stageId: 'stage-1',
        kind: 'quiz',
        options: artifact('quiz', 1).options,
        status: 'failed',
        createdAt: 13,
        updatedAt: 14,
      },
    ];

    const grouped = groupArtifactGenerationJobs(jobs);
    expect(grouped.understanding.map((job) => job.id)).toEqual(['job-guide']);
    expect(grouped.structure.map((job) => job.id)).toEqual(['job-map']);
    expect(grouped.practice.map((job) => job.id)).toEqual(['job-quiz']);
  });

  it('does not resurrect an older failed placeholder after a newer job completes', () => {
    const failed: ArtifactGenerationJob = {
      id: 'failed-old',
      stageId: 'stage-1',
      kind: 'studyGuide',
      options: artifact('studyGuide', 1).options,
      status: 'failed',
      createdAt: 10,
      updatedAt: 10,
    };
    const complete: ArtifactGenerationJob = {
      ...failed,
      id: 'complete-new',
      status: 'complete',
      artifactId: 'artifact-new',
      createdAt: 20,
      updatedAt: 20,
    };

    expect(latestVisibleArtifactJobs([failed, complete])).toEqual({});
    expect(
      latestVisibleArtifactJobs([complete, { ...failed, id: 'retry', updatedAt: 30 }]),
    ).toEqual({
      studyGuide: expect.objectContaining({ id: 'retry' }),
    });
  });
});
