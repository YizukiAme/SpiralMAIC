import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { ensureGenerationRunSchema } from '@/lib/persistence/generation-runs';
import { ensureRevisitSchema } from '@/lib/revisit/server-store';
import type { LessonConcept } from '@/lib/revisit/types';
import { createServerOvertimeStore, OvertimeConflictError } from '@/lib/overtime/server-store';
import type { OvertimeExtension } from '@/lib/overtime/types';
import type { Scene, SlideContent, Stage } from '@/lib/types/stage';

const url = process.env.PG_CONTRACT_URL;
const schema = 'spiral_overtime_server_test';
const ownerA = 'anon:11111111-1111-4111-8111-111111111111';
const ownerB = 'anon:22222222-2222-4222-8222-222222222222';
const decision = {
  disposition: 'append_page' as const,
  topic: 'Approach',
  teachingMove: 'extend' as const,
};
const outline = {
  id: 'overtime-task-1',
  order: 3,
  type: 'slide' as const,
  title: 'Approach',
  description: 'Move closer.',
  keyPoints: ['meaning'],
};
const scene = {
  id: outline.id,
  stageId: 'stage-1',
  order: 3,
  type: 'slide' as const,
  title: outline.title,
  createdAt: 20,
  updatedAt: 20,
  content: {
    type: 'slide' as const,
    canvas: {
      id: 'canvas-1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#111', fontName: 'Inter' },
      elements: [],
    },
  },
  overtime: {
    extensionId: 'task-1',
    sequence: 1,
    teachingMove: 'extend' as const,
    conceptIds: ['approach'],
    sourceSceneIds: ['scene-1'],
  },
} as Scene;

const SAFE_HTML = '<p><strong>Motion</strong></p>';
const EXECUTABLE_HTML = SAFE_HTML + '<img src=x onerror="alert(1)"><script>alert(1)</script>';

function htmlScene(): Scene {
  const content = scene.content as SlideContent;
  return {
    ...scene,
    type: 'slide',
    content: {
      ...content,
      canvas: {
        ...content.canvas,
        elements: [
          {
            id: 'overtime-text',
            type: 'text',
            left: 0,
            top: 0,
            width: 800,
            height: 200,
            rotate: 0,
            defaultFontName: 'Inter',
            defaultColor: '#111111',
            content: EXECUTABLE_HTML,
          },
        ],
      },
    },
  };
}

function expectSafeHtml(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).toContain(SAFE_HTML);
  expect(serialized).not.toMatch(/onerror|<img|<script/i);
}

describe.skipIf(!url)('server overtime store on PostgreSQL', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await getServerPersistenceProvider(`${url}?application_name=spiral-overtime-test`, () => pool);
    await ensureRevisitSchema(pool);
    await ensureGenerationRunSchema(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE stage_meta, document_stages, generation_runs CASCADE');
    const store = createOwnerBoundDocumentStore<Scene, Stage>({
      pool,
      ownerId: ownerA,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
    await store.saveDocument({
      stage: { id: 'stage-1', name: 'Motion verbs', createdAt: 1, updatedAt: 2 },
      scenes: [
        {
          id: 'scene-1',
          stageId: 'stage-1',
          order: 2,
          type: 'slide',
          title: 'Go',
          createdAt: 1,
          updatedAt: 2,
          content: scene.content as SlideContent,
        },
      ],
      outline: { outlines: [], generationComplete: true, createdAt: 1, updatedAt: 2 },
    });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  async function activeRun() {
    await pool.query(
      `INSERT INTO generation_runs (id, owner_id, input, state, stage_id)
      VALUES ('run-course', $1, '{}'::jsonb, 'generating', 'stage-1')`,
      [ownerA],
    );
  }

  it('refuses creating a task during a producing run without inserting anything, then allows a completed run', async () => {
    const store = createServerOvertimeStore({ pool, ownerId: ownerA });
    await activeRun();
    const request = {
      id: 'task-1',
      stageId: 'stage-1',
      userPrompt: 'Teach approach',
      decision,
      now: 10,
    };
    await expect(store.createOrGet(request)).rejects.toMatchObject({ code: 'COURSE_GENERATING' });
    expect((await pool.query('SELECT id FROM overtime_extensions')).rows).toEqual([]);
    expect((await pool.query('SELECT id FROM document_scenes')).rows).toEqual([{ id: 'scene-1' }]);
    await pool.query("UPDATE generation_runs SET state = 'completed' WHERE id = 'run-course'");
    await expect(store.createOrGet(request)).resolves.toMatchObject({
      version: 1,
      extension: { status: 'planning' },
    });
  });

  it('refuses committing into a producing run atomically, then allows the same lease after completion', async () => {
    const store = createServerOvertimeStore({ pool, ownerId: ownerA });
    await store.createOrGet({
      id: 'task-1',
      stageId: 'stage-1',
      userPrompt: 'Teach approach',
      decision,
      now: 10,
    });
    const lease = await store.claim({ id: 'task-1', version: 1, now: 11 });
    await activeRun();
    const request = {
      id: 'task-1',
      version: lease.version,
      leaseToken: lease.leaseToken,
      outline,
      scene,
      now: 20,
    };
    await expect(store.commit(request)).rejects.toMatchObject({ code: 'COURSE_GENERATING' });
    expect((await pool.query('SELECT id FROM document_scenes')).rows).toEqual([{ id: 'scene-1' }]);
    expect(await store.get('task-1')).toEqual({
      version: lease.version,
      extension: lease.extension,
    });
    await pool.query("UPDATE generation_runs SET state = 'completed' WHERE id = 'run-course'");
    await expect(store.commit(request)).resolves.toMatchObject({ extension: { status: 'ready' } });
  });

  it('sanitizes pinned transaction reads and writes as the normal document boundary does', async () => {
    const documents = createOwnerBoundDocumentStore<Scene, Stage>({
      pool,
      ownerId: ownerA,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
    const poisoned = { ...htmlScene(), id: 'scene-1', order: 2 };
    await pool.query("UPDATE document_scenes SET data = $1::jsonb WHERE id = 'scene-1'", [
      JSON.stringify(poisoned),
    ]);
    await documents.withMutationTransaction('stage-1', async (_tx, document) => {
      const current = await document.loadDocument();
      expectSafeHtml(current?.scenes);
      await document.saveDocument({ ...current!, scenes: [poisoned] });
    });
    expectSafeHtml((await pool.query('SELECT data FROM document_scenes')).rows);
  });

  it('persists sanitized checkpoints so a resumed task cannot reintroduce executable slide HTML', async () => {
    const store = createServerOvertimeStore({ pool, ownerId: ownerA });
    await store.createOrGet({
      id: 'task-1',
      stageId: 'stage-1',
      userPrompt: 'Teach approach',
      decision,
      now: 10,
    });
    const lease = await store.claim({ id: 'task-1', version: 1, now: 11 });
    const poisoned = htmlScene();
    const checkpoint = await store.checkpoint({
      id: 'task-1',
      version: lease.version,
      leaseToken: lease.leaseToken,
      now: 12,
      patch: {
        status: 'generating',
        phase: 'tts',
        updatedAt: 12,
        scene: poisoned,
        content: (poisoned.content as SlideContent).canvas,
      },
    });
    expectSafeHtml(checkpoint.extension.scene);
    expectSafeHtml(checkpoint.extension.content);
    const rows = await pool.query<{ body: OvertimeExtension }>(
      'SELECT body FROM overtime_extensions',
    );
    expectSafeHtml(rows.rows[0]?.body.scene);
    expectSafeHtml(rows.rows[0]?.body.content);
    const released = await store.release({ id: 'task-1', leaseToken: lease.leaseToken, now: 13 });
    const resumed = await store.claim({ id: 'task-1', version: released.version, now: 14 });
    expectSafeHtml(resumed.extension.scene);
    expectSafeHtml(resumed.extension.content);
  });

  it('stores sanitized committed document rows and the durable ready-task snapshot', async () => {
    const store = createServerOvertimeStore({ pool, ownerId: ownerA });
    await store.createOrGet({
      id: 'task-1',
      stageId: 'stage-1',
      userPrompt: 'Teach approach',
      decision,
      now: 10,
    });
    const lease = await store.claim({ id: 'task-1', version: 1, now: 11 });
    const ready = await store.commit({
      id: 'task-1',
      version: lease.version,
      leaseToken: lease.leaseToken,
      outline,
      scene: htmlScene(),
      now: 20,
    });
    expectSafeHtml(
      (await pool.query("SELECT data FROM document_scenes WHERE id = 'overtime-task-1'")).rows,
    );
    expectSafeHtml(ready.extension.scene);
    expectSafeHtml((await pool.query('SELECT body FROM overtime_extensions')).rows);
  });

  it('sanitizes legacy imported scene and content snapshots while retaining their remapped stage', async () => {
    const store = createServerOvertimeStore({ pool, ownerId: ownerA });
    const poisoned = htmlScene();
    const original: OvertimeExtension = {
      id: 'imported-task',
      stageId: 'legacy-stage',
      sequence: 1,
      reservedOrder: 3,
      status: 'ready',
      phase: 'commit',
      userPrompt: 'Original',
      decision,
      createdAt: 1,
      updatedAt: 2,
      scene: { ...poisoned, stageId: 'legacy-stage' },
      content: (poisoned.content as SlideContent).canvas,
    };
    await store.import({ stageId: 'stage-1', extensions: [original] });
    const stored = await store.get('imported-task');
    expect(stored?.extension.scene?.stageId).toBe('stage-1');
    expectSafeHtml(stored?.extension.scene);
    expectSafeHtml(stored?.extension.content);
    expectSafeHtml((await pool.query('SELECT body FROM overtime_extensions')).rows);
  });

  it('allows one unfinished task per owned course and reserves the next order', async () => {
    const store = createServerOvertimeStore({ pool, ownerId: ownerA });
    const first = await store.createOrGet({
      id: 'task-1',
      stageId: 'stage-1',
      userPrompt: 'Teach approach',
      decision,
      now: 10,
    });
    const again = await store.createOrGet({
      id: 'task-2',
      stageId: 'stage-1',
      userPrompt: 'Teach arrive',
      decision,
      now: 11,
    });
    expect(first).toMatchObject({
      version: 1,
      extension: { id: 'task-1', sequence: 1, reservedOrder: 3 },
    });
    expect(again).toEqual(first);
    expect(await store.list('stage-1')).toHaveLength(1);
    expect(await createServerOvertimeStore({ pool, ownerId: ownerB }).get('task-1')).toBeNull();
  });

  it('rejects stale checkpoints without changing the durable task', async () => {
    const store = createServerOvertimeStore({ pool, ownerId: ownerA });
    await store.createOrGet({
      id: 'task-1',
      stageId: 'stage-1',
      userPrompt: 'Teach approach',
      decision,
      now: 10,
    });
    const lease = await store.claim({ id: 'task-1', version: 1, now: 11 });
    await store.checkpoint({
      id: 'task-1',
      version: lease.version,
      leaseToken: lease.leaseToken,
      now: 12,
      patch: { status: 'generating', phase: 'content', updatedAt: 12 },
    });
    await expect(
      store.checkpoint({
        id: 'task-1',
        version: lease.version,
        leaseToken: lease.leaseToken,
        now: 13,
        patch: { status: 'failed', phase: 'content', updatedAt: 13 },
      }),
    ).rejects.toBeInstanceOf(OvertimeConflictError);
    expect(await store.get('task-1')).toMatchObject({
      version: 3,
      extension: { status: 'generating', updatedAt: 12 },
    });
  });

  it('grants one active generation lease and lets a new tab resume after expiry', async () => {
    const store = createServerOvertimeStore({ pool, ownerId: ownerA });
    await store.createOrGet({
      id: 'task-1',
      stageId: 'stage-1',
      userPrompt: 'Teach approach',
      decision,
      now: 10,
    });
    const first = await store.claim({ id: 'task-1', version: 1, now: 100 });
    const heartbeat = await store.heartbeat({
      id: 'task-1',
      leaseToken: first.leaseToken,
      now: 200,
    });
    expect(heartbeat.leaseExpiresAt).toBe(30_200);
    await expect(
      store.claim({ id: 'task-1', version: first.version, now: 101 }),
    ).rejects.toBeInstanceOf(OvertimeConflictError);
    const next = await store.claim({
      id: 'task-1',
      version: first.version,
      now: heartbeat.leaseExpiresAt + 1,
    });
    expect(next.leaseToken).not.toBe(first.leaseToken);
    await expect(
      store.checkpoint({
        id: 'task-1',
        version: next.version,
        now: 102,
        leaseToken: first.leaseToken,
        patch: { status: 'generating', phase: 'content', updatedAt: 102 },
      }),
    ).rejects.toBeInstanceOf(OvertimeConflictError);
    const released = await store.release({
      id: 'task-1',
      leaseToken: next.leaseToken,
      now: heartbeat.leaseExpiresAt + 2,
    });
    expect(released.extension.status).toBe('interrupted');
    const resumed = await store.claim({
      id: 'task-1',
      version: released.version,
      now: heartbeat.leaseExpiresAt + 3,
    });
    expect(resumed.leaseToken).not.toBe(next.leaseToken);
  });

  it('commits scene, outline, and task together and repeats safely', async () => {
    const store = createServerOvertimeStore({ pool, ownerId: ownerA });
    await store.createOrGet({
      id: 'task-1',
      stageId: 'stage-1',
      userPrompt: 'Teach approach',
      decision,
      now: 10,
    });
    const lease = await store.claim({ id: 'task-1', version: 1, now: 11 });
    const concept: LessonConcept = {
      stageId: 'stage-1',
      conceptId: 'approach',
      label: 'approach',
      summary: 'Move closer',
      origin: 'overtime',
      sourceSceneIds: [scene.id],
      introducedAt: 20,
      createdAt: 20,
      updatedAt: 20,
    };
    const ready = await store.commit({
      id: 'task-1',
      version: lease.version,
      leaseToken: lease.leaseToken,
      outline,
      scene,
      concepts: [concept],
      now: 20,
    });
    expect(ready).toMatchObject({ version: 3, extension: { status: 'ready', completedAt: 20 } });
    expect(
      await store.commit({
        id: 'task-1',
        version: lease.version,
        leaseToken: lease.leaseToken,
        outline,
        scene,
        now: 30,
      }),
    ).toEqual(ready);
    const document = await createOwnerBoundDocumentStore<Scene, Stage>({
      pool,
      ownerId: ownerA,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    }).loadDocument('stage-1');
    expect(document?.scenes.filter((item) => item.id === scene.id)).toHaveLength(1);
    expect(document?.outline).toMatchObject({
      outlines: [expect.objectContaining({ id: outline.id })],
      generationComplete: true,
    });
    const concepts = await pool.query<{ body: LessonConcept }>(
      "SELECT body FROM revisit_records WHERE stage_id = 'stage-1' AND kind = 'lessonConcepts' AND record_id = 'approach'",
    );
    expect(concepts.rows[0]?.body).toMatchObject({
      sourceSceneIds: [scene.id],
      origin: 'overtime',
    });
  });

  it('imports remapped legacy tasks without overwriting an existing id', async () => {
    const store = createServerOvertimeStore({ pool, ownerId: ownerA });
    const original: OvertimeExtension = {
      id: 'old-task',
      stageId: 'old-stage',
      sequence: 1,
      reservedOrder: 3,
      status: 'ready',
      phase: 'commit',
      userPrompt: 'Original',
      decision,
      createdAt: 1,
      updatedAt: 2,
      completedAt: 2,
    };
    expect(await store.import({ stageId: 'stage-1', extensions: [original] })).toEqual({
      insertedIds: ['old-task'],
      conflictingIds: [],
    });
    expect(
      await store.import({
        stageId: 'stage-1',
        extensions: [{ ...original, userPrompt: 'Changed' }],
      }),
    ).toEqual({ insertedIds: [], conflictingIds: ['old-task'] });
    expect(await store.get('old-task')).toMatchObject({
      extension: { stageId: 'stage-1', userPrompt: 'Original' },
    });
    await pool.query("UPDATE stage_meta SET deleted_at = now() WHERE stage_id = 'stage-1'");
    await expect(
      store.import({ stageId: 'stage-1', extensions: [{ ...original, id: 'late-task' }] }),
    ).rejects.toMatchObject({ name: 'OvertimeNotFoundError' });
  });

  it('removes durable tasks when the owner retires the course', async () => {
    const store = createServerOvertimeStore({ pool, ownerId: ownerA });
    await store.createOrGet({
      id: 'task-1',
      stageId: 'stage-1',
      userPrompt: 'Teach approach',
      decision,
      now: 10,
    });
    await createOwnerBoundDocumentStore<Scene, Stage>({
      pool,
      ownerId: ownerA,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    }).deleteDocument('stage-1');
    const rows = await pool.query("SELECT id FROM overtime_extensions WHERE stage_id = 'stage-1'");
    expect(rows.rows).toEqual([]);
  });

  it('rolls the document back when its concept upsert fails', async () => {
    const store = createServerOvertimeStore({ pool, ownerId: ownerA });
    await store.createOrGet({
      id: 'task-1',
      stageId: 'stage-1',
      userPrompt: 'Teach approach',
      decision,
      now: 10,
    });
    const lease = await store.claim({ id: 'task-1', version: 1, now: 11 });
    const wrongStageConcept: LessonConcept = {
      stageId: 'another-stage',
      conceptId: 'approach',
      label: 'approach',
      summary: 'Move closer',
      origin: 'overtime',
      sourceSceneIds: [scene.id],
      introducedAt: 20,
      createdAt: 20,
      updatedAt: 20,
    };
    await expect(
      store.commit({
        id: 'task-1',
        version: lease.version,
        leaseToken: lease.leaseToken,
        outline,
        scene,
        concepts: [wrongStageConcept],
        now: 20,
      }),
    ).rejects.toMatchObject({ name: 'RevisitAccessError' });
    const document = await createOwnerBoundDocumentStore<Scene, Stage>({
      pool,
      ownerId: ownerA,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    }).loadDocument('stage-1');
    expect(document?.scenes.map((item) => item.id)).toEqual(['scene-1']);
    expect(document?.outline).toMatchObject({ outlines: [] });
    expect(await store.get('task-1')).toMatchObject({
      version: 2,
      extension: { status: 'planning' },
    });
  });
});
