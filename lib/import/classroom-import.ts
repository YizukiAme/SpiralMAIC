'use client';

import { nanoid } from 'nanoid';

import {
  agentConfigFromManifest,
  type ClassroomManifest,
  type ManifestScene,
} from '@/lib/export/classroom-zip-types';
import { rewriteAudioRefsToIds } from '@/lib/export/classroom-zip-utils';
import { canonicalizeLegacyScene, mutateDocument, type AppDocument } from '@/lib/document-store';
import type { MediaFileRecord } from '@/lib/utils/database';
import { db, mediaFileKey } from '@/lib/utils/database';
import type { PersistedAgentConfig } from '@/lib/types/stage';
import { isValidSpiralAgentRoster } from '@/lib/revisit/spiral-agents';

export type ImportPhase =
  | 'idle'
  | 'parsing'
  | 'validating'
  | 'writingMedia'
  | 'writingCourse'
  | 'done';

export type ClassroomImportErrorCode = 'invalid-manifest' | 'missing-data';

export class ClassroomImportError extends Error {
  constructor(public readonly code: ClassroomImportErrorCode) {
    super(code);
    this.name = 'ClassroomImportError';
  }
}

export interface ClassroomImportOptions {
  onPhase?: (phase: ImportPhase) => void;
}

/** Classroom ZIPs are complete snapshots; the format carries no resumable generation plan. */
export function completedClassroomImportOutline(now: number): NonNullable<AppDocument['outline']> {
  return {
    outlines: [],
    generationComplete: true,
    createdAt: now,
    updatedAt: now,
  };
}

async function bestEffortRollback(created: {
  stageId: string;
  audioIds: string[];
  mediaIds: string[];
}) {
  await Promise.allSettled([
    mutateDocument(created.stageId, async (_document, store) =>
      store.deleteDocument(created.stageId),
    ),
    db.audioFiles.bulkDelete(created.audioIds),
    db.mediaFiles.bulkDelete(created.mediaIds),
  ]);
}

export async function importClassroomBlob(
  source: Blob,
  options: ClassroomImportOptions = {},
): Promise<string> {
  const onPhase = options.onPhase ?? (() => undefined);
  const newStageId = nanoid();
  const created = {
    stageId: newStageId,
    audioIds: [] as string[],
    mediaIds: [] as string[],
  };

  try {
    onPhase('parsing');
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await source.arrayBuffer());
    const manifestFile = zip.file('manifest.json');
    if (!manifestFile) throw new ClassroomImportError('invalid-manifest');

    onPhase('validating');
    let manifest: ClassroomManifest;
    try {
      manifest = JSON.parse(await manifestFile.async('text')) as ClassroomManifest;
    } catch {
      throw new ClassroomImportError('invalid-manifest');
    }
    if (!manifest.stage || !manifest.scenes || !Array.isArray(manifest.scenes)) {
      throw new ClassroomImportError('missing-data');
    }

    const now = Date.now();
    const newAgentIds = (manifest.agents ?? []).map(() => nanoid());
    const generatedAgentConfigs = (manifest.agents ?? []).map((agent, index) =>
      agentConfigFromManifest(agent, newAgentIds[index]),
    );
    const newSpiralAgentIds = (manifest.spiralAgents ?? []).map(() => `spiral-${nanoid(8)}`);
    const spiralAgentConfigs: PersistedAgentConfig[] = (manifest.spiralAgents ?? []).map(
      (agent, index) => ({
        ...agentConfigFromManifest(agent, newSpiralAgentIds[index]),
      }),
    );
    const studentAgentIndex = manifest.agents?.findIndex((agent) => agent.role === 'student') ?? -1;
    const nonTeacherAgentIndex =
      manifest.agents?.findIndex((agent) => agent.role !== 'teacher') ?? -1;
    const fallbackDiscussionAgentIndex =
      studentAgentIndex >= 0
        ? studentAgentIndex
        : nonTeacherAgentIndex >= 0
          ? nonTeacherAgentIndex
          : undefined;

    const audioRefToNewId: Record<string, string> = {};
    const mediaRefToNewId: Record<string, string> = {};
    for (const [zipPath, entry] of Object.entries(manifest.mediaIndex ?? {})) {
      if (entry.type === 'audio' && !entry.missing) {
        const id = nanoid();
        audioRefToNewId[zipPath] = id;
        created.audioIds.push(id);
      }
      if ((entry.type === 'generated' || entry.type === 'image') && !entry.missing) {
        const filename = zipPath.split('/').pop() ?? '';
        const elementId = filename.replace(/\.\w+$/, '');
        const id = mediaFileKey(newStageId, elementId);
        mediaRefToNewId[zipPath] = id;
        created.mediaIds.push(id);
      }
    }

    onPhase('writingMedia');
    for (const [zipPath, newId] of Object.entries(audioRefToNewId)) {
      const zipEntry = zip.file(zipPath);
      if (!zipEntry) continue;
      const blob = await zipEntry.async('blob');
      const meta = manifest.mediaIndex[zipPath];
      await db.audioFiles.put({
        id: newId,
        blob,
        format: meta.format || 'mp3',
        duration: meta.duration,
        voice: meta.voice,
        createdAt: now,
      });
    }

    for (const [zipPath, newId] of Object.entries(mediaRefToNewId)) {
      const zipEntry = zip.file(zipPath);
      if (!zipEntry) continue;
      const blob = await zipEntry.async('blob');
      const meta = manifest.mediaIndex[zipPath];
      const record: MediaFileRecord = {
        id: newId,
        stageId: newStageId,
        type: meta.mimeType?.startsWith('video/') ? 'video' : 'image',
        blob,
        mimeType: meta.mimeType || 'image/jpeg',
        size: meta.size || blob.size,
        prompt: meta.prompt || '',
        params: '',
        createdAt: now,
      };
      const posterEntry = zip.file(zipPath.replace(/\.\w+$/, '.poster.jpg'));
      if (posterEntry) record.poster = await posterEntry.async('blob');
      await db.mediaFiles.put(record);
    }

    onPhase('writingCourse');
    const document: AppDocument = {
      stage: {
        id: newStageId,
        name: manifest.stage.name || 'Imported Classroom',
        description: manifest.stage.description,
        languageDirective: manifest.stage.language,
        style: manifest.stage.style,
        createdAt: manifest.stage.createdAt || now,
        updatedAt: now,
        agentIds: newAgentIds.length > 0 ? newAgentIds : undefined,
        ...(generatedAgentConfigs.length > 0 ? { generatedAgentConfigs } : {}),
        ...(isValidSpiralAgentRoster(spiralAgentConfigs) ? { spiralAgentConfigs } : {}),
      },
      // A classroom archive is a self-contained snapshot: the ZIP format has
      // no pending-outline state that the browser could resume after import.
      // Mark it complete so playback can reach the course-end page and Spiral
      // can record completion once every imported scene has actually played.
      outline: completedClassroomImportOutline(now),
      scenes: manifest.scenes.map((manifestScene: ManifestScene, index: number) => {
        const newSceneId = nanoid();
        const actions = manifestScene.actions
          ? rewriteAudioRefsToIds(manifestScene.actions, audioRefToNewId, {
              agentIds: newAgentIds,
              fallbackDiscussionAgentIndex,
            })
          : undefined;
        const multiAgent = manifestScene.multiAgent?.enabled
          ? {
              enabled: true,
              agentIds: (manifestScene.multiAgent.agentIndices ?? [])
                .map((agentIndex) => newAgentIds[agentIndex])
                .filter(Boolean),
              directorPrompt: manifestScene.multiAgent.directorPrompt,
            }
          : undefined;

        return canonicalizeLegacyScene({
          id: newSceneId,
          stageId: newStageId,
          title: manifestScene.title,
          order: manifestScene.order ?? index,
          content: manifestScene.content,
          actions,
          whiteboards: manifestScene.whiteboards,
          multiAgent,
          createdAt: now,
          updatedAt: now,
        });
      }),
    };

    await mutateDocument(newStageId, async (_existing, store) => store.saveDocument(document));

    onPhase('done');
    return newStageId;
  } catch (error) {
    await bestEffortRollback(created);
    throw error;
  }
}
