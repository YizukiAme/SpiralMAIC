import type { Page } from '@playwright/test';

import { createSettingsStorage } from './test-data/settings';
import { defaultTheme } from './test-data/scene-content';
import { openHomeAndWaitForDatabase } from './indexed-db';

export const SPIRAL_STAGE_ID = 'spiral-v032-stage';
export const SPIRAL_ATTEMPT_ID = 'spiral-v032-attempt';
export const SPIRAL_ARTIFACT_ID = `${SPIRAL_STAGE_ID}:studyGuide:v1`;

const SETTINGS_STORAGE = createSettingsStorage({
  sidebarCollapsed: false,
  reverseChallengeEnabled: true,
  demoGateSkipEnabled: false,
});

function createScenario(now: number) {
  const spiralAgentConfigs = [
    {
      id: 'spiral-assistant',
      name: 'Ari',
      role: 'assistant',
      persona: 'Helps only when the learner is stuck.',
      avatar: '/avatars/assist.png',
      color: '#7c3aed',
      priority: 7,
    },
    {
      id: 'spiral-student-1',
      name: 'Bo',
      role: 'student',
      persona: 'Asks for concrete examples.',
      avatar: '/avatars/curious.png',
      color: '#2563eb',
      priority: 5,
    },
    {
      id: 'spiral-student-2',
      name: 'Cy',
      role: 'student',
      persona: 'Checks causal explanations.',
      avatar: '/avatars/thinker.png',
      color: '#059669',
      priority: 4,
    },
  ];
  const stage = {
    id: SPIRAL_STAGE_ID,
    name: 'Photosynthesis review',
    description: 'A v0.3.2-compatible Spiral learning record',
    languageDirective: 'en-US',
    spiralAgentConfigs,
    createdAt: now - 10 * 24 * 60 * 60 * 1000,
    updatedAt: now - 8 * 24 * 60 * 60 * 1000,
  };
  const makeSlide = (id: string, title: string, order: number, overtime = false) => ({
    id,
    stageId: SPIRAL_STAGE_ID,
    type: 'slide',
    title,
    order,
    content: {
      type: 'slide',
      canvas: {
        id: `canvas-${id}`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: defaultTheme,
        elements: [
          {
            type: 'text',
            id: `text-${id}`,
            content: title,
            left: 80,
            top: 80,
            width: 840,
            height: 120,
          },
        ],
      },
    },
    ...(overtime
      ? {
          overtime: {
            extensionId: 'overtime-v032-1',
            sequence: 1,
            teachingMove: 'apply',
            conceptIds: ['photosynthesis'],
            sourceSceneIds: ['source-scene-1'],
          },
        }
      : {}),
    createdAt: stage.createdAt,
    updatedAt: stage.updatedAt,
  });
  const sourceScene = makeSlide('source-scene-1', 'How photosynthesis stores energy', 0);
  const overtimeScene = makeSlide('overtime-scene-1', 'Overtime: photosynthesis at home', 1, true);
  const reviewScene = makeSlide('review-scene-1', 'Explain photosynthesis', 0);
  const blueprint = {
    id: 'blueprint-v032-1',
    stageId: SPIRAL_STAGE_ID,
    generatedAt: now - 7 * 24 * 60 * 60 * 1000,
    language: 'en-US',
    sourceHash: 'v032-source-hash',
    openingBrief: 'The lesson connected light energy, carbon dioxide, water, and stored sugar.',
    concepts: [
      {
        id: 'photosynthesis',
        label: 'Photosynthesis',
        summary: 'Plants convert light energy into stored chemical energy.',
        anchors: {
          clarity: ['Name the inputs and output.'],
          doubtResolution: ['Explain where the energy goes.'],
          transfer: ['Apply the idea to a plant at home.'],
          errorCorrection: ['Distinguish energy from matter.'],
        },
        probes: [
          {
            id: 'probe-1',
            conceptId: 'photosynthesis',
            pageIndex: 0,
            kind: 'transfer',
            prompt: 'What would change if the plant received less light?',
            expectedAnswer: 'The rate of sugar production would usually fall.',
          },
        ],
      },
    ],
    skeleton: {
      pages: [
        {
          id: 'review-page-1',
          title: 'Explain photosynthesis',
          summary: 'Teach the energy conversion in your own words.',
          conceptIds: ['photosynthesis'],
          cues: ['inputs', 'energy conversion', 'sugar'],
        },
      ],
    },
  };
  const attempt = {
    attemptId: SPIRAL_ATTEMPT_ID,
    stageId: SPIRAL_STAGE_ID,
    sequence: 1,
    status: 'ready',
    sourceStage: stage,
    sourceScenes: [sourceScene, overtimeScene],
    blueprint,
    scenes: [reviewScene],
    spiralAgentGenerationState: 'revealed',
    createdAt: blueprint.generatedAt,
    updatedAt: blueprint.generatedAt,
  };
  const artifact = {
    id: SPIRAL_ARTIFACT_ID,
    stageId: SPIRAL_STAGE_ID,
    kind: 'studyGuide',
    version: 1,
    title: 'Photosynthesis study guide',
    createdAt: blueprint.generatedAt,
    updatedAt: blueprint.generatedAt,
    stageUpdatedAt: stage.updatedAt,
    language: 'en-US',
    sourceHash: 'v032-source-hash',
    lessonSourceHash: 'v032-source-hash',
    options: {
      focusMode: 'balanced',
      selectedSceneIds: [],
      customInstructions: '',
      detailLevel: 'standard',
    },
    content: {
      blocks: [
        { type: 'heading', text: 'Photosynthesis', level: 2 },
        {
          type: 'paragraph',
          text: 'Light energy is stored as chemical energy in sugar.',
          conceptIds: ['photosynthesis'],
        },
      ],
    },
  };
  const overtimeExtension = {
    id: 'overtime-v032-1',
    stageId: SPIRAL_STAGE_ID,
    sequence: 1,
    reservedOrder: 1,
    status: 'ready',
    phase: 'commit',
    userPrompt: 'How does this apply to a plant at home?',
    decision: {
      disposition: 'append_page',
      topic: 'Photosynthesis at home',
      teachingMove: 'apply',
    },
    outline: {
      id: overtimeScene.id,
      order: overtimeScene.order,
      type: 'slide',
      title: overtimeScene.title,
      description: 'Apply the lesson after class.',
      keyPoints: ['light', 'water', 'growth'],
    },
    scene: overtimeScene,
    createdAt: stage.updatedAt,
    updatedAt: stage.updatedAt,
    completedAt: stage.updatedAt,
  };
  return {
    stage,
    sourceScene,
    overtimeScene,
    reviewScene,
    blueprint,
    attempt,
    artifact,
    overtimeExtension,
  };
}

async function seedCourseDatabase(page: Page, scenario: ReturnType<typeof createScenario>) {
  await page.evaluate((data) => {
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('MAIC-Database');
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(
          ['stages', 'scenes', 'stageOutlines', 'overtimeExtensions'],
          'readwrite',
        );
        transaction.objectStore('stages').put(data.stage);
        transaction.objectStore('scenes').put(data.sourceScene);
        transaction.objectStore('scenes').put(data.overtimeScene);
        transaction.objectStore('stageOutlines').put({
          stageId: data.stage.id,
          outlines: [],
          generationComplete: true,
          createdAt: data.stage.createdAt,
          updatedAt: data.stage.updatedAt,
        });
        transaction.objectStore('overtimeExtensions').put(data.overtimeExtension);
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
      request.onerror = () => reject(request.error);
    });
  }, scenario);
}

async function seedRevisitDatabase(page: Page, scenario: ReturnType<typeof createScenario>) {
  await page.evaluate((data) => {
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('SpiralMAIC-Revisit');
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(
          [
            'lessonProgress',
            'lessonConcepts',
            'examBlueprints',
            'revisitAttempts',
            'studyArtifacts',
          ],
          'readwrite',
        );
        transaction.objectStore('lessonProgress').put({
          stageId: data.stage.id,
          completedAt: data.stage.updatedAt,
          updatedAt: data.stage.updatedAt,
        });
        transaction.objectStore('lessonConcepts').put({
          stageId: data.stage.id,
          conceptId: 'photosynthesis',
          label: 'Photosynthesis',
          summary: 'Plants convert light energy into stored chemical energy.',
          origin: 'lesson',
          sourceSceneIds: [data.sourceScene.id],
          introducedAt: data.stage.updatedAt,
          learnedAt: data.stage.updatedAt,
          createdAt: data.stage.updatedAt,
          updatedAt: data.stage.updatedAt,
        });
        transaction.objectStore('examBlueprints').put(data.blueprint);
        transaction.objectStore('revisitAttempts').put(data.attempt);
        transaction.objectStore('studyArtifacts').put(data.artifact);
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
      request.onerror = () => reject(request.error);
    });
  }, scenario);
}

/** Seed records shaped like the v0.3.2 browser stores, then let v0.4 reopen them. */
export async function seedV032SpiralScenario(page: Page) {
  await page.addInitScript((settings) => {
    localStorage.setItem('maic:account:settings-storage', settings);
    localStorage.setItem('locale', 'en-US');
  }, SETTINGS_STORAGE);

  const scenario = createScenario(Date.now());
  // Wait for the app's Dexie migrations before opening the databases directly.
  await openHomeAndWaitForDatabase(page, 'MAIC-Database', [
    'stages',
    'scenes',
    'stageOutlines',
    'overtimeExtensions',
  ]);
  await seedCourseDatabase(page, scenario);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: scenario.stage.name }).waitFor();
  await seedRevisitDatabase(page, scenario);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: scenario.stage.name }).waitFor();
}
