import { CURRENT_SLIDE_CONTENT_SCHEMA_VERSION } from '@/lib/edit/slide-schema';
import { fetchSceneContent } from '@/lib/hooks/use-scene-generator';
import type { RevisitExamBlueprint, RevisitSkeletonPage } from '@/lib/revisit/types';
import type { GeneratedSlideContent, SceneOutline } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';

type SlideSceneContent = Extract<Scene['content'], { type: 'slide' }>;
type SlideTheme = SlideSceneContent['canvas']['theme'];
type SlideBackground = SlideSceneContent['canvas']['background'];

interface RevisitSlideModelConfig {
  modelString: string;
  apiKey: string;
  baseUrl?: string;
  providerType?: string;
  requiresApiKey?: boolean;
  isServerConfigured?: boolean;
  thinkingConfig?: unknown;
}

const DEFAULT_REVISIT_SKELETON_PAGE_TIMEOUT_MS = 120_000;

export async function generateRevisitSkeletonScenes(args: {
  stage: Stage;
  blueprint: RevisitExamBlueprint;
  sourceScenes: Scene[];
  modelConfig: RevisitSlideModelConfig;
  onScene?: (scene: Scene, index: number) => void;
  now?: number;
  pageTimeoutMs?: number;
}): Promise<Scene[]> {
  const canCallModel =
    !args.modelConfig.requiresApiKey ||
    args.modelConfig.isServerConfigured ||
    args.modelConfig.apiKey;
  if (!canCallModel) {
    throw new Error('Revisit skeleton generation model is unavailable');
  }

  const outlines = buildRevisitSkeletonOutlines(args.blueprint);
  const sourceStyle = findSourceSlideStyle(args.sourceScenes);
  const scenes: Scene[] = [];

  for (const [index, outline] of outlines.entries()) {
    const content = await requestSkeletonSlideContent({
      stage: args.stage,
      outline,
      allOutlines: outlines,
      timeoutMs: args.pageTimeoutMs ?? DEFAULT_REVISIT_SKELETON_PAGE_TIMEOUT_MS,
    });
    const page = args.blueprint.skeleton.pages[index];
    if (!page) continue;
    const scene = createGeneratedRevisitSkeletonScene({
      stage: args.stage,
      page,
      order: index,
      content,
      sourceTheme: sourceStyle?.theme,
      sourceBackground: sourceStyle?.background,
      now: args.now,
    });
    scenes[index] = scene;
    args.onScene?.(scene, index);
  }

  return scenes;
}

export function buildRevisitSkeletonOutlines(blueprint: RevisitExamBlueprint): SceneOutline[] {
  return blueprint.skeleton.pages.map((page, index) => ({
    id: `revisit-${page.id}`,
    type: 'slide',
    title: toPlainText(page.title),
    description:
      'Create a sparse reverse-teaching outline slide. The learner is the teacher and should fill in the explanation orally. Do not include full explanations, definitions, examples, answers, probe solutions, or detailed notes.',
    keyPoints: [page.summary, ...page.cues].map(toPlainText).filter(Boolean).slice(0, 5),
    teachingObjective:
      'Provide only high-level cues that help the human teacher reconstruct the lesson.',
    estimatedDuration: 90,
    order: index,
    languageNote: blueprint.language,
  }));
}

export function createGeneratedRevisitSkeletonScene(args: {
  stage: Stage;
  page: RevisitSkeletonPage;
  order: number;
  content: GeneratedSlideContent;
  sourceTheme?: SlideTheme;
  sourceBackground?: SlideBackground;
  now?: number;
}): Scene {
  const now = args.now ?? Date.now();
  const sceneId = `${args.stage.id}:revisit:${args.page.id}`;
  return {
    id: sceneId,
    stageId: args.stage.id,
    type: 'slide',
    title: toPlainText(args.page.title),
    order: args.order,
    createdAt: now,
    updatedAt: now,
    content: {
      type: 'slide',
      canvas: {
        id: `${sceneId}:canvas`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme:
          args.sourceTheme ??
          ({
            backgroundColor: '#ffffff',
            themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
            fontColor: '#333333',
            fontName: 'Microsoft YaHei',
          } satisfies SlideTheme),
        background:
          args.sourceBackground ??
          (args.sourceTheme
            ? { type: 'solid', color: args.sourceTheme.backgroundColor }
            : args.content.background),
        elements: args.content.elements,
      },
      schemaVersion: CURRENT_SLIDE_CONTENT_SCHEMA_VERSION,
    },
  };
}

function findSourceSlideStyle(
  scenes: Scene[],
): { theme: SlideTheme; background?: SlideBackground } | undefined {
  for (const scene of scenes) {
    if (scene.content.type === 'slide') {
      return {
        theme: scene.content.canvas.theme,
        background: scene.content.canvas.background,
      };
    }
  }
  return undefined;
}

async function requestSkeletonSlideContent(args: {
  stage: Stage;
  outline: SceneOutline;
  allOutlines: SceneOutline[];
  timeoutMs: number;
}): Promise<GeneratedSlideContent> {
  // Delegate to the normal classroom generation client (fetchSceneContent):
  // same headers, retry/backoff, and error taxonomy as forward generation.
  // Revisit only adds a whole-page time budget and forces thinking off —
  // sparse outline pages gain nothing from provider reasoning, which pushed
  // per-page latency past any sane budget.
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          `Skeleton page "${args.outline.title}" generation timed out after ${Math.round(args.timeoutMs / 1000)}s`,
          'TimeoutError',
        ),
      ),
    args.timeoutMs,
  );
  try {
    const result = await fetchSceneContent(
      {
        outline: args.outline,
        allOutlines: args.allOutlines,
        stageId: args.stage.id,
        stageInfo: {
          name: args.stage.name,
          style: 'Reverse teaching review skeleton',
        },
        languageDirective: args.stage.languageDirective,
        requirements: {
          requirement:
            'Reverse challenge skeleton: Only title and bullet-like cue text elements are allowed. No charts, images, icons, decorative shapes, dense layouts, animations, full definitions, examples, answers, probe solutions, or speaker notes. Keep the slide sparse so the human teacher must explain the details aloud.',
        },
        thinkingConfig: { mode: 'disabled', enabled: false },
      },
      controller.signal,
    );
    if (!result.success || !result.content) {
      throw new Error(result.error || 'Revisit skeleton response missing slide content');
    }
    return result.content as GeneratedSlideContent;
  } catch (error) {
    // Surface the timeout as its own named error, not a generic abort.
    if (controller.signal.aborted && controller.signal.reason) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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
