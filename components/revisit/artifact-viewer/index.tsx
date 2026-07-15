import type { ReactNode } from 'react';

import { BriefingViewer } from '@/components/revisit/artifact-viewer/briefing-viewer';
import { FaqViewer } from '@/components/revisit/artifact-viewer/faq-viewer';
import { FlashcardsViewer } from '@/components/revisit/artifact-viewer/flashcards-viewer';
import { MindMapViewer } from '@/components/revisit/artifact-viewer/mind-map-viewer';
import { QuizViewer } from '@/components/revisit/artifact-viewer/quiz-viewer';
import { StudyGuideViewer } from '@/components/revisit/artifact-viewer/study-guide-viewer';
import type { StudyArtifact } from '@/lib/revisit/types';
import { getStudyArtifactViewerLayout } from '@/lib/revisit/artifact-view';
import { FORMAL_REVISIT_SCOPE, type RevisitDataScope } from '@/lib/revisit/scope';
import type { Scene } from '@/lib/types/stage';
import { cn } from '@/lib/utils';

export function ArtifactViewer({
  artifact,
  dataScope,
  sourceScenes,
}: {
  artifact: StudyArtifact;
  dataScope?: RevisitDataScope;
  sourceScenes: Scene[];
}) {
  const scope = dataScope ?? FORMAL_REVISIT_SCOPE;
  const layout = getStudyArtifactViewerLayout(artifact.kind);
  let content: ReactNode;

  switch (artifact.kind) {
    case 'briefing':
      content = <BriefingViewer artifact={artifact} />;
      break;
    case 'mindMap':
      content = <MindMapViewer artifact={artifact} dataScope={scope} sourceScenes={sourceScenes} />;
      break;
    case 'studyGuide':
      content = <StudyGuideViewer artifact={artifact} />;
      break;
    case 'faq':
      content = <FaqViewer artifact={artifact} sourceScenes={sourceScenes} />;
      break;
    case 'flashcards':
      content = <FlashcardsViewer artifact={artifact} dataScope={scope} />;
      break;
    case 'quiz':
      content = <QuizViewer artifact={artifact} dataScope={scope} />;
      break;
  }

  return (
    <section
      data-study-artifact-layout={layout}
      className={cn(
        'study-artifact-layout min-h-[calc(100dvh-4rem)] print:min-h-0',
        layout === 'paper' && 'w-full',
        layout === 'canvas' &&
          'h-[calc(100dvh-4rem)] min-h-[560px] p-0 sm:p-3 lg:p-4 print:h-auto print:p-0',
        layout === 'document' &&
          'mx-auto w-full max-w-[1280px] px-0 py-0 sm:px-4 sm:py-5 lg:px-6 lg:py-7 print:max-w-none print:p-0',
        layout === 'practice' &&
          'mx-auto w-full max-w-[1180px] px-0 py-0 sm:px-4 sm:py-5 lg:px-6 lg:py-7 print:max-w-none print:p-0',
      )}
    >
      <div
        className={cn(
          (layout === 'canvas' || layout === 'document' || layout === 'practice') &&
            'border-border/60 bg-white/80 shadow-xl shadow-slate-950/5 backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/80 dark:shadow-black/25 print:border-0 print:bg-white print:shadow-none print:backdrop-blur-none',
          layout === 'canvas' &&
            'h-full overflow-hidden border-y sm:rounded-lg sm:border print:h-auto print:overflow-visible',
          (layout === 'document' || layout === 'practice') &&
            'min-h-full overflow-hidden border-y sm:rounded-lg sm:border print:overflow-visible',
        )}
      >
        {content}
      </div>
    </section>
  );
}
