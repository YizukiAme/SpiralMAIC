import { CURRENT_SLIDE_CONTENT_SCHEMA_VERSION } from '@/lib/edit/slide-schema';
import type { RevisitExamBlueprint, RevisitSkeletonPage } from '@/lib/revisit/types';
import type { Scene, Stage } from '@/lib/types/stage';
import type { PPTTextElement } from '@openmaic/dsl';

export function buildRevisitSkeletonScenes(args: {
  stage: Stage;
  blueprint: RevisitExamBlueprint;
  now?: number;
}): Scene[] {
  const now = args.now ?? Date.now();
  return args.blueprint.skeleton.pages.map((page, index) =>
    createSkeletonSlideScene({
      stageId: args.stage.id,
      page,
      order: index,
      now,
    }),
  );
}

function createSkeletonSlideScene(args: {
  stageId: string;
  page: RevisitSkeletonPage;
  order: number;
  now: number;
}): Scene {
  const sceneId = `${args.stageId}:revisit:${args.page.id}`;
  const title = toPlainText(args.page.title);
  const summary = toPlainText(args.page.summary);
  const cues = args.page.cues.map(toPlainText).filter(Boolean).slice(0, 5);
  return {
    id: sceneId,
    stageId: args.stageId,
    type: 'slide',
    title,
    order: args.order,
    createdAt: args.now,
    updatedAt: args.now,
    content: {
      type: 'slide',
      canvas: {
        id: `${sceneId}:canvas`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#f8fafc',
          themeColors: ['#111827', '#2563eb', '#10b981'],
          fontColor: '#111827',
          fontName: 'Inter',
        },
        background: { type: 'solid', color: '#f8fafc' },
        elements: [
          textElement({
            id: `${sceneId}:title`,
            content: title,
            left: 82,
            top: 78,
            width: 836,
            height: 76,
            fontSize: 42,
            bold: true,
          }),
          textElement({
            id: `${sceneId}:summary`,
            content: summary,
            left: 86,
            top: 178,
            width: 828,
            height: 96,
            fontSize: 24,
            color: '#475569',
          }),
          ...cues.map((cue, index) =>
            textElement({
              id: `${sceneId}:cue-${index + 1}`,
              content: cue,
              left: 112,
              top: 318 + index * 54,
              width: 776,
              height: 42,
              fontSize: 24,
              color: '#0f172a',
            }),
          ),
        ],
      },
      schemaVersion: CURRENT_SLIDE_CONTENT_SCHEMA_VERSION,
    },
  };
}

function textElement(args: {
  id: string;
  content: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  bold?: boolean;
  color?: string;
}): PPTTextElement {
  return {
    id: args.id,
    type: 'text',
    left: args.left,
    top: args.top,
    width: args.width,
    height: args.height,
    rotate: 0,
    content: `<p style="font-size: ${args.fontSize}px; font-weight: ${args.bold ? 700 : 400}; color: ${args.color ?? '#111827'};">${escapeHtml(args.content)}</p>`,
    defaultFontName: 'Inter',
    defaultColor: args.color ?? '#111827',
    lineHeight: 1.25,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toPlainText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
