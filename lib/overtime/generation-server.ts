import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

/** Course reads can be shared by id; generating another page requires its owner. */
export async function ownsGenerationCourse(ownerId: string, stageId: string): Promise<boolean> {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const result = await pool.query(
    'SELECT stage_id FROM stage_meta WHERE stage_id = $1 AND owner_id = $2 AND deleted_at IS NULL',
    [stageId, ownerId],
  );
  return result.rows.length > 0;
}
