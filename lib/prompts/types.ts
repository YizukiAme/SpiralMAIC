/**
 * Simplified prompt system type definitions
 */

/**
 * Prompt template identifier
 */
export type PromptId =
  | 'interactive-outlines'
  | 'task-engine-outlines'
  | 'web-search-query-rewrite'
  | 'revisit-exam-blueprint'
  | 'revisit-judge'
  | 'revisit-study-artifact-briefing'
  | 'revisit-study-artifact-mind-map'
  | 'revisit-study-artifact-study-guide'
  | 'revisit-study-artifact-faq'
  | 'revisit-study-artifact-flashcards'
  | 'revisit-study-artifact-quiz'
  | 'overtime-extension-outline';

/**
 * Snippet identifier
 */
export type SnippetId =
  | 'json-output-rules'
  | 'element-types'
  | 'action-types'
  | 'image-instructions'
  | 'video-instructions'
  | 'media-safety-guidelines'
  | 'slide-image-instructions'
  | 'slide-generated-image-instructions'
  | 'slide-video-instructions'
  | 'revisit-probe-context';

/**
 * Loaded prompt template
 */
export interface LoadedPrompt {
  id: PromptId;
  systemPrompt: string;
  userPromptTemplate: string;
}

export type PromptVariableDefaults = Partial<Record<PromptId, Readonly<Record<string, unknown>>>>;
