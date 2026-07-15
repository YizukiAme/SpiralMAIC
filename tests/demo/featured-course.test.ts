import 'fake-indexeddb/auto';

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FEATURED_DEMO_COURSE,
  findFeaturedDemoStage,
  openFeaturedDemoCourse,
} from '@/lib/demo/featured-course';
import { db } from '@/lib/utils/database';

async function clearDemoTables() {
  await db.open();
  await Promise.all([
    db.stages.clear(),
    db.scenes.clear(),
    db.audioFiles.clear(),
    db.mediaFiles.clear(),
    db.generatedAgents.clear(),
  ]);
}

async function classroomBlob() {
  const zip = new JSZip();
  zip.file(
    'manifest.json',
    JSON.stringify({
      formatVersion: 1,
      exportedAt: new Date(0).toISOString(),
      appVersion: 'test',
      stage: { name: '厚壁菌门与肥胖', createdAt: 1, updatedAt: 1 },
      agents: [],
      scenes: [
        {
          type: 'slide',
          title: 'One',
          order: 1,
          content: {
            type: 'slide',
            canvas: {
              id: 'canvas-1',
              viewportSize: 1000,
              viewportRatio: 0.5625,
              theme: {
                backgroundColor: '#ffffff',
                themeColors: [],
                fontColor: '#111111',
                fontName: 'Inter',
              },
              elements: [],
            },
          },
        },
      ],
      mediaIndex: {},
    }),
  );
  return zip.generateAsync({ type: 'blob' });
}

beforeEach(clearDemoTables);
afterEach(clearDemoTables);

describe('featured demo course', () => {
  it('does not identify a normal classroom by title', async () => {
    await db.stages.put({
      id: 'normal',
      name: '厚壁菌门与肥胖',
      createdAt: 1,
      updatedAt: 1,
    });

    await expect(findFeaturedDemoStage()).resolves.toBeUndefined();
  });

  it('opens the tagged local copy without fetching', async () => {
    await db.stages.put({
      id: 'demo',
      name: '厚壁菌门与肥胖',
      createdAt: 1,
      updatedAt: 1,
      featuredDemoId: FEATURED_DEMO_COURSE.id,
      featuredDemoRevision: FEATURED_DEMO_COURSE.revision,
    });
    const fetcher = vi.fn<typeof fetch>();

    await expect(openFeaturedDemoCourse({ fetcher })).resolves.toBe('demo');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('downloads and imports the artifact only when no tagged copy exists', async () => {
    const blob = await classroomBlob();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(blob, { status: 200 }));
    const phases: string[] = [];

    const stageId = await openFeaturedDemoCourse({
      fetcher,
      onPhase: (phase) => phases.push(phase),
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(FEATURED_DEMO_COURSE.artifactUrl);
    await expect(db.stages.get(stageId)).resolves.toMatchObject({
      featuredDemoId: FEATURED_DEMO_COURSE.id,
      featuredDemoRevision: FEATURED_DEMO_COURSE.revision,
    });
    expect(phases).toContain('downloading');
    expect(phases).toContain('writingCourse');
  });
});
