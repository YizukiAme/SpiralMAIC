import {
  BookOpenCheck,
  CircleHelp,
  GitFork,
  Layers3,
  LayoutTemplate,
  ListChecks,
  type LucideIcon,
} from 'lucide-react';

import type { StudyArtifactKind } from '@/lib/revisit/types';

export interface StudyArtifactDefinition {
  kind: StudyArtifactKind;
  icon: LucideIcon;
  labelKey: string;
  descriptionKey: string;
  iconClassName: string;
  iconBackgroundClassName: string;
}

export const STUDY_ARTIFACT_DEFINITIONS: StudyArtifactDefinition[] = [
  {
    kind: 'briefing',
    icon: LayoutTemplate,
    labelKey: 'revisit.studio.kinds.briefing.title',
    descriptionKey: 'revisit.studio.kinds.briefing.description',
    iconClassName: 'text-cyan-700 dark:text-cyan-300',
    iconBackgroundClassName: 'bg-cyan-100 dark:bg-cyan-950/70',
  },
  {
    kind: 'mindMap',
    icon: GitFork,
    labelKey: 'revisit.studio.kinds.mindMap.title',
    descriptionKey: 'revisit.studio.kinds.mindMap.description',
    iconClassName: 'text-emerald-700 dark:text-emerald-300',
    iconBackgroundClassName: 'bg-emerald-100 dark:bg-emerald-950/70',
  },
  {
    kind: 'studyGuide',
    icon: BookOpenCheck,
    labelKey: 'revisit.studio.kinds.studyGuide.title',
    descriptionKey: 'revisit.studio.kinds.studyGuide.description',
    iconClassName: 'text-amber-700 dark:text-amber-300',
    iconBackgroundClassName: 'bg-amber-100 dark:bg-amber-950/70',
  },
  {
    kind: 'faq',
    icon: CircleHelp,
    labelKey: 'revisit.studio.kinds.faq.title',
    descriptionKey: 'revisit.studio.kinds.faq.description',
    iconClassName: 'text-rose-700 dark:text-rose-300',
    iconBackgroundClassName: 'bg-rose-100 dark:bg-rose-950/70',
  },
  {
    kind: 'flashcards',
    icon: Layers3,
    labelKey: 'revisit.studio.kinds.flashcards.title',
    descriptionKey: 'revisit.studio.kinds.flashcards.description',
    iconClassName: 'text-violet-700 dark:text-violet-300',
    iconBackgroundClassName: 'bg-violet-100 dark:bg-violet-950/70',
  },
  {
    kind: 'quiz',
    icon: ListChecks,
    labelKey: 'revisit.studio.kinds.quiz.title',
    descriptionKey: 'revisit.studio.kinds.quiz.description',
    iconClassName: 'text-blue-700 dark:text-blue-300',
    iconBackgroundClassName: 'bg-blue-100 dark:bg-blue-950/70',
  },
];

export const STUDY_ARTIFACT_DEFINITION_BY_KIND = Object.fromEntries(
  STUDY_ARTIFACT_DEFINITIONS.map((definition) => [definition.kind, definition]),
) as Record<StudyArtifactKind, StudyArtifactDefinition>;
