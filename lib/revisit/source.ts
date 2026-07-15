import { simpleSourceHash } from '@/lib/revisit/blueprint';
import type { StudyArtifact } from '@/lib/revisit/types';
import type { Scene, Stage } from '@/lib/types/stage';

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractElementText(element: unknown): string {
  const value = element as {
    type?: string;
    content?: unknown;
    text?: { content?: unknown };
    data?: unknown;
    lines?: unknown;
    latex?: unknown;
  };
  if (value.type === 'text') {
    return typeof value.content === 'string' ? stripHtml(value.content) : '';
  }
  if (value.type === 'shape') {
    return typeof value.text?.content === 'string' ? stripHtml(value.text.content) : '';
  }
  if (value.type === 'table') {
    return (Array.isArray(value.data) ? value.data : [])
      .flatMap((row) => (Array.isArray(row) ? row : []))
      .map((cell) => {
        const text = (cell as { text?: unknown }).text;
        return typeof text === 'string' ? stripHtml(text) : '';
      })
      .filter(Boolean)
      .join(' | ');
  }
  if (value.type === 'code') {
    return (Array.isArray(value.lines) ? value.lines : [])
      .map((line) => {
        const content = (line as { content?: unknown }).content;
        return typeof content === 'string' ? content : '';
      })
      .join('\n')
      .trim();
  }
  return value.type === 'latex' && typeof value.latex === 'string' ? value.latex.trim() : '';
}

function extractLectureText(scene: Scene): string {
  return (scene.actions ?? [])
    .filter((action) => action.type === 'speech')
    .map((action) => action.text.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 900);
}

function extractSlideText(scene: Scene): string {
  if (scene.content.type !== 'slide') return '';
  return scene.content.canvas.elements
    .map(extractElementText)
    .filter(Boolean)
    .join(' ')
    .slice(0, 900);
}

function stringifyCompact(value: unknown, maxLength: number): string {
  try {
    return JSON.stringify(value).slice(0, maxLength);
  } catch {
    return '';
  }
}

function summarizeScene(scene: Scene): string {
  const lectureText = extractLectureText(scene);
  if (scene.content.type === 'slide') {
    const text = extractSlideText(scene);
    return `- Slide ${scene.order + 1}: ${scene.title}\n  Visual: ${text}\n  Lecture: ${lectureText}`;
  }
  if (scene.content.type === 'quiz') {
    const questions = scene.content.questions
      .map((question, index) => {
        const options = (question.options ?? []).map((option) => option.label).join(' / ');
        const answer = (question.answer ?? []).join(', ');
        return `${index + 1}. ${question.question} | Options: ${options} | Answer: ${answer}`;
      })
      .join(' | ');
    return `- Quiz ${scene.order + 1}: ${scene.title}\n  ${questions}\n  Lecture: ${lectureText}`;
  }
  if (scene.content.type === 'interactive') {
    const visibleText = scene.content.html ? stripHtml(scene.content.html).slice(0, 1200) : '';
    const widgetContext = stringifyCompact(scene.content.widgetConfig, 600);
    return `- Interactive ${scene.order + 1}: ${scene.title}\n  Content: ${visibleText}\n  Widget: ${widgetContext}\n  Lecture: ${lectureText}`;
  }
  if (scene.content.type === 'pbl') {
    const project = stringifyCompact(scene.content.projectV2 ?? scene.content.projectConfig, 1800);
    return `- PBL ${scene.order + 1}: ${scene.title}\n  Project: ${project}\n  Lecture: ${lectureText}`;
  }
  return `- ${scene.type} ${scene.order + 1}: ${scene.title}\n  Lecture: ${lectureText}`;
}

export function buildSceneDigest(scenes: Scene[]): string {
  return scenes.map(summarizeScene).join('\n');
}

export function buildSceneDigestWithStableIds(scenes: Scene[]): string {
  return scenes.map((scene) => summarizeScene(scene).replace(/^- /, `- [${scene.id}] `)).join('\n');
}

export function selectSourceScenes(scenes: Scene[], selectedSceneIds: string[] = []): Scene[] {
  if (selectedSceneIds.length === 0) return scenes;
  const byId = new Map(scenes.map((scene) => [scene.id, scene] as const));
  const selected = selectedSceneIds
    .map((sceneId) => byId.get(sceneId))
    .filter((scene): scene is Scene => Boolean(scene));
  return selected;
}

export function buildLessonSourceHash(
  stage: { id: string; updatedAt: number },
  scenes: Scene[],
): string {
  return simpleSourceHash(
    JSON.stringify({
      stageId: stage.id,
      stageUpdatedAt: stage.updatedAt,
      sceneDigest: buildSceneDigest(scenes),
    }),
  );
}

export function isStudyArtifactStale(args: {
  artifact: StudyArtifact;
  stage: Pick<Stage, 'id' | 'updatedAt'>;
  scenes: Scene[];
}): boolean {
  return args.artifact.lessonSourceHash !== buildLessonSourceHash(args.stage, args.scenes);
}
