import { buildSceneDigest } from '@/lib/revisit/source';
import type { Scene } from '@/lib/types/stage';

export const OVERTIME_COURSE_CONTEXT_MAX_CHARS = 12_000;

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(1, maxChars - 1))}…`;
}

function sceneDetail(scene: Scene): string {
  return buildSceneDigest([scene])
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Build a bounded, id-free summary for post-class conversation. The compact
 * page index is emitted first so every title survives even when detail text is
 * heavily truncated on a long course.
 */
export function buildOvertimeCourseDigest(
  scenes: Scene[],
  maxChars = OVERTIME_COURSE_CONTEXT_MAX_CHARS,
): string {
  if (scenes.length === 0 || maxChars <= 0) return '';

  const ordered = [...scenes].sort((left, right) => left.order - right.order);
  const indexHeading = 'Completed course page index:\n';
  const titleBudget = Math.max(
    16,
    Math.min(
      180,
      Math.floor((maxChars - indexHeading.length - ordered.length * 22) / ordered.length),
    ),
  );
  const indexLines = ordered.map(
    (scene, index) =>
      `Page ${index + 1} | ${scene.type} | ${truncate(oneLine(scene.title), titleBudget)}`,
  );
  const pageIndex = `${indexHeading}${indexLines.join('\n')}`;
  const detailsHeading = '\n\nCompleted course teaching summary:\n';
  let remaining = maxChars - pageIndex.length - detailsHeading.length;
  if (remaining <= 0) return pageIndex.slice(0, maxChars);

  const details: string[] = [];
  for (let index = 0; index < ordered.length && remaining > 0; index += 1) {
    const pagesLeft = ordered.length - index;
    const separatorLength = details.length > 0 ? 2 : 0;
    const fairShare = Math.max(0, Math.floor((remaining - separatorLength) / pagesLeft));
    if (fairShare <= 0) break;

    const prefix = `Page ${index + 1} details:\n`;
    const detail = sceneDetail(ordered[index]);
    const chunk = truncate(
      `${prefix}${detail || 'No additional page detail is available.'}`,
      fairShare,
    );
    details.push(chunk);
    remaining -= chunk.length + separatorLength;
  }

  return `${pageIndex}${detailsHeading}${details.join('\n\n')}`.slice(0, maxChars);
}
