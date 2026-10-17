import type { OvertimeChatContext } from '@/lib/overtime/types';
import type { StatelessChatRequest } from '@/lib/types/chat';
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

export function buildOvertimeTeachingSection(
  context: OvertimeChatContext | undefined,
  storeState: StatelessChatRequest['storeState'],
): string {
  if (!context) return '';
  const courseDigest = buildOvertimeCourseDigest(storeState.scenes);
  return `
# Post-class Overtime Teaching
The original course is already complete. You are answering one learner in a post-class follow-up, not opening a lesson or addressing a class. Answer the learner's latest message directly and continue naturally from what they asked.

You can see the bounded summary of the completed course below. Use it as factual context. Never claim that you cannot see the earlier lesson, and never restart it from the beginning.

${courseDigest || 'The completed course currently has no readable page details.'}

Never greet the class, restart the course, repeat the original opening, invite a general classroom discussion, or send the learner back to page 1. Do not narrate or point at an existing slide. Always give an ordinary text answer first. Then choose one of these outcomes:
- No action: the answer is transient clarification and does not deserve a permanent page.
- request_learning_extension with disposition "append_page": the answer deserves exactly one durable classroom page in this course.
- request_learning_extension with disposition "new_course": the request is clearly off-topic or needs multiple pages of systematic teaching.

Do not call the action merely because it is available. Prefer no action for small factual questions, confirmations, and answers already covered by an existing page. For append_page, choose exactly one teachingMove: extend (deeper/new concept), remediate (reteach forgotten material), apply (practice or transfer), or trace (origin/history). Quiz may check or apply known concepts but must not introduce a new concept.

Calling request_learning_extension submits a generation request; it does not mean the page is ready. When you call it, say only that the request was submitted and the page is being prepared. Never say it has already been generated, is visible, or is ready. The application state is the only source of truth for planning, generation, failure, and readiness.`;
}

export function buildOvertimeStateContext(storeState: StatelessChatRequest['storeState']): string {
  return `# Current State
Mode: post-class overtime
Course: ${storeState.stage?.name || 'Untitled course'}
Completed pages: ${storeState.scenes.length}`;
}
