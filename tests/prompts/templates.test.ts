/**
 * Structural assertion tests for the prompt templates.
 *
 * These replace the byte-equal snapshot suite that was initially added — the
 * goal here is catching real regressions (missing variables, broken
 * placeholder naming) without forcing a snapshot update for every intentional
 * prompt-content tweak.
 */

import { describe, test, expect } from 'vitest';
import { loadPrompt } from '@openmaic/generation';
import { buildBlueprintPrompt } from '@/lib/revisit/prompt-builders';
import type { StatelessChatRequest } from '@/lib/types/chat';

describe('PBL action workflow', () => {
  test('previews the v2 instructor-guided milestone workspace', () => {
    const prompt = loadPrompt('pbl-actions');

    expect(prompt?.systemPrompt).toContain(
      'complete project configuration with milestones and a guided project workspace led by an instructor',
    );
    expect(prompt?.systemPrompt).toContain(
      'Briefly previews what the project involves, including its driving goal and key milestones',
    );
    expect(prompt?.systemPrompt).toContain(
      'Encourages students to enter the project workspace and start the first task',
    );
    expect(prompt?.systemPrompt).toContain('## Project Plan');
    expect(prompt?.systemPrompt).toContain('{{projectSummary}}');
    expect(prompt?.systemPrompt).toContain('do not invent or rename them');
    expect(prompt?.systemPrompt).not.toContain('available roles');
    expect(prompt?.systemPrompt).not.toContain('select a role');
  });
});

describe('placeholder naming convention lint', () => {
  // The `interpolateVariables` regex is /\{\{(\w+)\}\}/, which is
  // strictly [A-Za-z0-9_]. Kebab-case placeholders would silently pass
  // through. Convention (per README) is camelCase. This test scans every
  // template for non-conforming placeholders.
  //
  // slide-content/{system,user}.md predates the convention and still uses
  // snake_case ({{canvas_width}}, {{canvas_height}}). Grandfather it here;
  // new templates must be camelCase.
  test('templates (excluding grandfathered) use camelCase placeholders', async () => {
    const { readdirSync, readFileSync, statSync } = await import('fs');
    const { join } = await import('path');

    const templatesDir = join(process.cwd(), 'lib', 'prompts', 'templates');
    const GRANDFATHERED = new Set(['slide-content']);

    const offenders: string[] = [];
    for (const promptId of readdirSync(templatesDir)) {
      if (GRANDFATHERED.has(promptId)) continue;
      const promptDir = join(templatesDir, promptId);
      if (!statSync(promptDir).isDirectory()) continue;

      for (const file of ['system.md', 'user.md']) {
        const p = join(promptDir, file);
        try {
          const content = readFileSync(p, 'utf-8');
          // Match {{placeholder}} but NOT {{snippet:name}}, {{#if}}, or {{/if}}
          const matches = content.match(/\{\{(?!snippet:|#if |\/if)([^}]+)\}\}/g) || [];
          for (const m of matches) {
            const name = m.slice(2, -2);
            // camelCase: starts with lowercase, rest alphanumeric; reject _ and -
            if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) {
              offenders.push(`${promptId}/${file}: ${m}`);
            }
          }
        } catch {
          // user.md is optional
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

const slideState: StatelessChatRequest['storeState'] = {
  stage: {
    id: 's1',
    name: 'Test',
    createdAt: 0,
    updatedAt: 0,
    languageDirective: 'zh-CN',
  },
  scenes: [
    {
      id: 'sc1',
      stageId: 's1',
      type: 'slide',
      title: 'T',
      order: 0,
      content: {
        type: 'slide',
        canvas: {
          id: 'c1',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          theme: {
            backgroundColor: '#fff',
            themeColors: [],
            fontColor: '#333',
            fontName: 'YaHei',
          },
          elements: [],
        },
      },
    },
  ],
  currentSceneId: 'sc1',
  mode: 'autonomous',
  whiteboardOpen: false,
};

describe('revisit blueprint prompt', () => {
  test('fades scaffolding across challenge attempts, not across pages', () => {
    const prompt = buildBlueprintPrompt({
      stage: {
        id: 'stage-1',
        name: 'English Grammar',
        createdAt: 0,
        updatedAt: 0,
        languageDirective: 'zh-CN',
      },
      scenes: [slideState.scenes[0]],
      adaptiveContext: {
        completedChallengeCount: 2,
        memorySummary: {
          status: 'review',
          recall: 0.4,
          meanRecall: 0.5,
          minRecall: 0.25,
          color: 'hsl(10 72% 40%)',
        },
        conceptStates: [],
      },
    });

    expect(prompt.system).toContain('across completed Reverse Challenge attempts');
    expect(prompt.system).toContain('same scaffolding density to every page');
    expect(prompt.system).not.toMatch(/earlier skeleton pages/i);
    expect(prompt.system).not.toMatch(/later skeleton pages/i);
    expect(prompt.system).toContain('transfer');
    expect(prompt.system).toContain('errorCorrection');
    expect(prompt.user).toContain('Current challenge number: 3');
    expect(prompt.user).toContain('Maximum cues per page: 2');
    expect(prompt.user).toContain('"completedChallengeCount": 2');
  });

  test('reduces the cue budget from the first challenge to later challenges', () => {
    const baseArgs = {
      stage: {
        id: 'stage-1',
        name: 'English Grammar',
        createdAt: 0,
        updatedAt: 0,
        languageDirective: 'zh-CN',
      },
      scenes: [slideState.scenes[0]],
    };
    const memorySummary = {
      status: 'review' as const,
      recall: 0.4,
      meanRecall: 0.5,
      minRecall: 0.25,
      color: 'hsl(10 72% 40%)',
    };

    const first = buildBlueprintPrompt({
      ...baseArgs,
      adaptiveContext: {
        completedChallengeCount: 0,
        memorySummary,
        conceptStates: [],
      },
    });
    const fourth = buildBlueprintPrompt({
      ...baseArgs,
      adaptiveContext: {
        completedChallengeCount: 3,
        memorySummary,
        conceptStates: [],
      },
    });

    expect(first.user).toContain('Current challenge number: 1');
    expect(first.user).toContain('Maximum cues per page: 4');
    expect(fourth.user).toContain('Current challenge number: 4');
    expect(fourth.user).toContain('Maximum cues per page: 1');
  });
});
