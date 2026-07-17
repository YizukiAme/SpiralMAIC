import { describe, expect, it } from 'vitest';

import { projectRevisitAdaptiveContextForPrompt } from '@/lib/revisit/adaptive-context';
import type { RevisitAdaptiveContext } from '@/lib/revisit/types';

const baseContext: RevisitAdaptiveContext = {
  completedChallengeCount: 2,
  memorySummary: {
    status: 'review',
    recall: 0.42,
    meanRecall: 0.55,
    minRecall: 0.2,
    color: '#ef4444',
  },
  conceptStates: [
    {
      stageId: 'stage-1',
      conceptId: 'subject-vs-predicate',
      label: 'Subject and predicate',
      hDays: 2,
      learnedAt: 1,
      lastRetrievalAt: 1,
      evidenceCount: 1,
      successChallengeDates: [],
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  pendingConcepts: [
    {
      stageId: 'stage-1',
      conceptId: 'verb-agreement',
      label: 'Verb agreement',
      summary: 'Match the verb to the subject.',
      origin: 'lesson',
      sourceSceneIds: ['scene-2'],
      introducedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
};

describe('projectRevisitAdaptiveContextForPrompt', () => {
  it('projects versioned findings without trusted citations or report internals', () => {
    const projected = projectRevisitAdaptiveContextForPrompt({
      ...baseContext,
      latestReport: {
        attemptId: 'attempt-2',
        stageId: 'stage-1',
        completedAt: 200,
        summary: 'Clear structure, but transfer needs work.',
        dimensions: {
          clarity: 0.9,
          doubtResolution: 0.7,
          transfer: 0.4,
          errorCorrection: 0.6,
        },
        qRaw: 0.61,
        q: 0.6,
        errors: [
          {
            id: 'error-1',
            conceptId: 'verb-agreement',
            description: 'Used a plural verb for a singular subject.',
            corrected: false,
            severity: 'major',
          },
        ],
        evidence: [
          {
            id: 'evidence-1',
            attemptId: 'attempt-2',
            stageId: 'stage-1',
            conceptId: 'verb-agreement',
            source: 'teach_back',
            scores: {
              clarity: 0.9,
              doubtResolution: 0.7,
              transfer: 0.4,
              errorCorrection: 0.6,
            },
            q: 0.6,
            qRaw: 0.61,
            polarity: 'mixed',
            timestamp: 200,
            notes: 'private concept evidence',
            errors: [],
          },
        ],
        pageReports: [
          {
            pageId: 'page-1',
            pageIndex: 0,
            passed: true,
            probeCount: 1,
            conceptIds: ['subject-vs-predicate'],
            notes: 'private page report',
          },
        ],
        findingsVersion: 1,
        strengths: [
          {
            id: 'strength-1',
            title: 'Clear distinction',
            feedback: 'The explanation separated the two sentence roles.',
            dimension: 'clarity',
            conceptIds: ['subject-vs-predicate'],
            citations: [
              {
                kind: 'transcript',
                sourceId: 'message-1',
                excerpt: 'trusted transcript excerpt',
              },
            ],
          },
        ],
        improvements: [
          {
            id: 'improvement-1',
            title: 'Practice transfer',
            feedback: 'Apply the rule to unfamiliar sentences.',
            dimension: 'transfer',
            conceptIds: ['verb-agreement'],
            citations: [
              {
                kind: 'pageReport',
                sourceId: 'page-report-1',
                pageId: 'page-1',
                pageIndex: 0,
                passed: false,
                probeCount: 2,
                conceptIds: ['verb-agreement'],
                notes: 'trusted page report notes',
              },
            ],
          },
        ],
      },
    });

    expect(projected).toEqual({
      completedChallengeCount: baseContext.completedChallengeCount,
      memorySummary: baseContext.memorySummary,
      conceptStates: baseContext.conceptStates,
      pendingConcepts: baseContext.pendingConcepts,
      latestReport: {
        completedAt: 200,
        summary: 'Clear structure, but transfer needs work.',
        dimensions: {
          clarity: 0.9,
          doubtResolution: 0.7,
          transfer: 0.4,
          errorCorrection: 0.6,
        },
        q: 0.6,
        errors: [
          {
            id: 'error-1',
            conceptId: 'verb-agreement',
            description: 'Used a plural verb for a singular subject.',
            corrected: false,
            severity: 'major',
          },
        ],
        findingsAvailable: true,
        strengths: [
          {
            id: 'strength-1',
            title: 'Clear distinction',
            feedback: 'The explanation separated the two sentence roles.',
            dimension: 'clarity',
            conceptIds: ['subject-vs-predicate'],
          },
        ],
        improvements: [
          {
            id: 'improvement-1',
            title: 'Practice transfer',
            feedback: 'Apply the rule to unfamiliar sentences.',
            dimension: 'transfer',
            conceptIds: ['verb-agreement'],
          },
        ],
      },
    });

    expect(JSON.stringify(projected)).not.toMatch(
      /"citations"|"excerpt"|"evidence"|"pageReports"|private page report|trusted transcript excerpt/,
    );
  });

  it('marks legacy reports unavailable without synthesizing findings arrays', () => {
    const projected = projectRevisitAdaptiveContextForPrompt({
      ...baseContext,
      latestReport: {
        attemptId: 'attempt-1',
        stageId: 'stage-1',
        completedAt: 100,
        summary: 'Legacy report.',
        dimensions: {
          clarity: 0.7,
          doubtResolution: 0.6,
          transfer: 0.5,
          errorCorrection: 0.4,
        },
        qRaw: 0.56,
        q: 0.55,
        errors: [],
        evidence: [],
        pageReports: [],
      },
    });

    expect(projected.latestReport).toMatchObject({
      completedAt: 100,
      summary: 'Legacy report.',
      findingsAvailable: false,
    });
    expect(projected.latestReport).not.toHaveProperty('strengths');
    expect(projected.latestReport).not.toHaveProperty('improvements');
  });
});
