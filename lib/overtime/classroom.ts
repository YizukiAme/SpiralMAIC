import type { GenerationSessionState } from '@/app/generation-preview/types';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';

export function mergeReadyOvertimePage(args: {
  scenes: Scene[];
  outlines: SceneOutline[];
  scene: Scene;
  outline: SceneOutline;
}): { scenes: Scene[]; outlines: SceneOutline[] } {
  const scenes = [...args.scenes.filter((item) => item.id !== args.scene.id), args.scene].sort(
    (a, b) => a.order - b.order,
  );
  const outlines = [
    ...args.outlines.filter((item) => item.id !== args.outline.id),
    args.outline,
  ].sort((a, b) => a.order - b.order);
  return { scenes, outlines };
}

export function buildOvertimeCourseGenerationSession(args: {
  sessionId: string;
  stage: Stage;
  scenes: Scene[];
  userPrompt: string;
  topic: string;
}): GenerationSessionState {
  const coveredPages = args.scenes
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((scene, index) => `${index + 1}. ${scene.title}`)
    .join('\n');
  const requirement = [
    `Create a new, self-contained course that grows out of the completed course "${args.stage.name}".`,
    args.stage.description ? `Original course summary: ${args.stage.description}` : '',
    coveredPages ? `Pages already covered in the original course:\n${coveredPages}` : '',
    `New course topic: ${args.topic}`,
    `Learner's original request: ${args.userPrompt || args.topic}`,
    'Teach the topic systematically across as many pages as needed. Do not assume this is merely one appended page.',
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    sessionId: args.sessionId,
    mode: 'course',
    requirements: { requirement },
    pdfText: '',
    pdfImages: [],
    imageStorageIds: [],
    sceneOutlines: null,
    currentStep: 'generating',
  };
}
