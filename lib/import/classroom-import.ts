'use client';

import { nanoid } from 'nanoid';

import type { ClassroomManifest, ManifestScene } from '@/lib/export/classroom-zip-types';
import { rewriteAudioRefsToIds } from '@/lib/export/classroom-zip-utils';
import type { GeneratedAgentRecord, MediaFileRecord, StageRecord } from '@/lib/utils/database';
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

async function bestEffortRollback(created: {
  stageId: string;
  sceneIds: string[];
  agentIds: string[];
  audioIds: string[];
  mediaIds: string[];
}) {
  await Promise.allSettled([
    db.scenes.bulkDelete(created.sceneIds),
    db.generatedAgents.bulkDelete(created.agentIds),
    db.audioFiles.bulkDelete(created.audioIds),
    db.mediaFiles.bulkDelete(created.mediaIds),
    db.stages.delete(created.stageId),
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
    sceneIds: [] as string[],
    agentIds: [] as string[],
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
    const newSpiralAgentIds = (manifest.spiralAgents ?? []).map(() => `spiral-${nanoid(8)}`);
    created.agentIds.push(...newAgentIds);
    const spiralAgentConfigs: PersistedAgentConfig[] = (manifest.spiralAgents ?? []).map(
      (agent, index) => ({
        id: newSpiralAgentIds[index],
        name: agent.name,
        role: agent.role,
        persona: agent.persona,
        avatar: agent.avatar,
        color: agent.color,
        priority: agent.priority,
        ...(agent.voiceConfig
          ? { voiceConfig: agent.voiceConfig as PersistedAgentConfig['voiceConfig'] }
          : {}),
        ...(agent.voiceDesign ? { voiceDesign: agent.voiceDesign } : {}),
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
    const stage: StageRecord = {
      id: newStageId,
      name: manifest.stage.name || 'Imported Classroom',
      description: manifest.stage.description,
      languageDirective: manifest.stage.language,
      style: manifest.stage.style,
      createdAt: manifest.stage.createdAt || now,
      updatedAt: now,
      agentIds: newAgentIds.length > 0 ? newAgentIds : undefined,
      spiralAgentConfigs: isValidSpiralAgentRoster(spiralAgentConfigs)
        ? spiralAgentConfigs
        : undefined,
    };
    await db.stages.put(stage);

    if (manifest.agents?.length) {
      const agentRecords: GeneratedAgentRecord[] = manifest.agents.map((agent, index) => ({
        id: newAgentIds[index],
        stageId: newStageId,
        name: agent.name,
        role: agent.role,
        persona: agent.persona,
        avatar: agent.avatar,
        color: agent.color,
        priority: agent.priority,
        createdAt: now,
      }));
      await db.generatedAgents.bulkPut(agentRecords);
    }

    const sceneRecords = manifest.scenes.map((manifestScene: ManifestScene, index: number) => {
      const newSceneId = nanoid();
      created.sceneIds.push(newSceneId);
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
      return {
        id: newSceneId,
        stageId: newStageId,
        type: manifestScene.type,
        title: manifestScene.title,
        order: manifestScene.order ?? index,
        content: manifestScene.content,
        actions,
        whiteboard: manifestScene.whiteboards,
        multiAgent,
        createdAt: now,
        updatedAt: now,
      };
    });
    await db.scenes.bulkPut(sceneRecords);

    onPhase('done');
    return newStageId;
  } catch (error) {
    await bestEffortRollback(created);
    throw error;
  }
}
