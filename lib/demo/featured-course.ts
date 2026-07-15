'use client';

import { importClassroomBlob, type ImportPhase } from '@/lib/import/classroom-import';
import { db, type StageRecord } from '@/lib/utils/database';

export const FEATURED_DEMO_COURSE = {
  id: 'firmicutes-obesity',
  revision: '1',
  badge: '演示课程',
  title: '厚壁菌门与肥胖',
  artifactUrl: '/demo/firmicutes-obesity.maic.zip',
  coverUrl: '/demo/firmicutes-obesity-cover.png',
} as const;

export type FeaturedDemoPhase = ImportPhase | 'downloading';

export class FeaturedDemoCourseError extends Error {
  constructor(public readonly code: 'download-failed') {
    super(code);
    this.name = 'FeaturedDemoCourseError';
  }
}

export interface OpenFeaturedDemoCourseOptions {
  fetcher?: typeof fetch;
  onPhase?: (phase: FeaturedDemoPhase) => void;
}

let inFlightImport: Promise<string> | null = null;

export async function findFeaturedDemoStage(): Promise<StageRecord | undefined> {
  return db.stages
    .filter(
      (stage) =>
        stage.featuredDemoId === FEATURED_DEMO_COURSE.id &&
        stage.featuredDemoRevision === FEATURED_DEMO_COURSE.revision,
    )
    .first();
}

export async function openFeaturedDemoCourse(
  options: OpenFeaturedDemoCourseOptions = {},
): Promise<string> {
  const existing = await findFeaturedDemoStage();
  if (existing) return existing.id;
  if (inFlightImport) return inFlightImport;

  const fetcher = options.fetcher ?? fetch;
  inFlightImport = (async () => {
    options.onPhase?.('downloading');
    const response = await fetcher(FEATURED_DEMO_COURSE.artifactUrl);
    if (!response.ok) throw new FeaturedDemoCourseError('download-failed');

    return importClassroomBlob(await response.blob(), {
      provenance: {
        featuredDemoId: FEATURED_DEMO_COURSE.id,
        featuredDemoRevision: FEATURED_DEMO_COURSE.revision,
      },
      onPhase: options.onPhase,
    });
  })();

  try {
    return await inFlightImport;
  } finally {
    inFlightImport = null;
  }
}
