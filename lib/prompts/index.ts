/**
 * Prompt System - Simplified prompt management
 *
 * Features:
 * - File-based prompt storage in templates/
 * - Snippet composition via {{snippet:name}} syntax
 * - Conditional blocks via {{#if flag}}...{{/if}} syntax
 * - Variable interpolation via {{variable}} syntax
 */

// Types
import type { PromptId } from './types';
export type { PromptId, SnippetId, LoadedPrompt } from './types';

// Loader functions
export {
  loadPrompt,
  loadSnippet,
  buildPrompt,
  interpolateVariables,
  processSnippets,
  processConditionalBlocks,
} from './loader';

// Prompt IDs constant
export const PROMPT_IDS = {
  REQUIREMENTS_TO_OUTLINES: 'requirements-to-outlines',
  INTERACTIVE_OUTLINES: 'interactive-outlines',
  TASK_ENGINE_OUTLINES: 'task-engine-outlines',
  WEB_SEARCH_QUERY_REWRITE: 'web-search-query-rewrite',
  SLIDE_CONTENT: 'slide-content',
  QUIZ_CONTENT: 'quiz-content',
  SLIDE_ACTIONS: 'slide-actions',
  QUIZ_ACTIONS: 'quiz-actions',
  INTERACTIVE_ACTIONS: 'interactive-actions',
  SIMULATION_CONTENT: 'simulation-content',
  DIAGRAM_CONTENT: 'diagram-content',
  CODE_CONTENT: 'code-content',
  GAME_CONTENT: 'game-content',
  VISUALIZATION3D_CONTENT: 'visualization3d-content',
  PROCEDURAL_SKILL_CONTENT: 'procedural-skill-content',
  PBL_ACTIONS: 'pbl-actions',
  AGENT_SYSTEM: 'agent-system',
  AGENT_SYSTEM_WB_TEACHER: 'agent-system-wb-teacher',
  AGENT_SYSTEM_WB_ASSISTANT: 'agent-system-wb-assistant',
  AGENT_SYSTEM_WB_STUDENT: 'agent-system-wb-student',
  DIRECTOR: 'director',
  REVISIT_EXAM_BLUEPRINT: 'revisit-exam-blueprint',
  REVISIT_JUDGE: 'revisit-judge',
  REVISIT_STUDY_ARTIFACT_BRIEFING: 'revisit-study-artifact-briefing',
  REVISIT_STUDY_ARTIFACT_MIND_MAP: 'revisit-study-artifact-mind-map',
  REVISIT_STUDY_ARTIFACT_STUDY_GUIDE: 'revisit-study-artifact-study-guide',
  REVISIT_STUDY_ARTIFACT_FAQ: 'revisit-study-artifact-faq',
  REVISIT_STUDY_ARTIFACT_FLASHCARDS: 'revisit-study-artifact-flashcards',
  REVISIT_STUDY_ARTIFACT_QUIZ: 'revisit-study-artifact-quiz',
  OVERTIME_EXTENSION_OUTLINE: 'overtime-extension-outline',
  PBL_DESIGN: 'pbl-design',
} as const satisfies Record<string, PromptId>;
