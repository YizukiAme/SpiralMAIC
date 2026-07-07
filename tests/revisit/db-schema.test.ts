import { describe, expect, it } from 'vitest';

import { REVISIT_DATABASE_NAME, revisitDb } from '@/lib/revisit/db';

describe('SpiralMAIC revisit Dexie schema', () => {
  it('uses an independent database with the required PRD tables', () => {
    expect(REVISIT_DATABASE_NAME).toBe('SpiralMAIC-Revisit');
    expect(revisitDb.tables.map((table) => table.name).sort()).toEqual([
      'conceptEvidence',
      'examBlueprints',
      'revisitReports',
      'userConceptState',
    ]);
  });
});
