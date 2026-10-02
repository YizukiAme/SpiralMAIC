import type { AppDocument } from '@/lib/document-store';

/** Classroom ZIPs are complete snapshots; they carry no resumable generation plan. */
export function completedClassroomImportOutline(now: number): NonNullable<AppDocument['outline']> {
  return {
    outlines: [],
    generationComplete: true,
    createdAt: now,
    updatedAt: now,
  };
}
