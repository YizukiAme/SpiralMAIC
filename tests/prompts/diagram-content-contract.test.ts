import { describe, expect, test } from 'vitest';

import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';

const UNRESOLVED_PLACEHOLDER = /\{\{[^}]+\}\}/;

function combined(prompt: { system: string; user: string } | null) {
  expect(prompt).not.toBeNull();
  return `${prompt!.system}\n${prompt!.user}`;
}

describe('diagram content prompt contract', () => {
  test('requires stable SVG DOM targets, visible graph layout, and valid widget JSON', () => {
    const text = combined(
      buildPrompt(PROMPT_IDS.DIAGRAM_CONTENT, {
        title: 'Safety system overview',
        diagramType: 'system',
        description: 'Show a connected system diagram.',
        keyPoints: '1. Power source\n2. Controller\n3. Safety interlock',
        languageDirective: 'Teach in English.',
      }),
    );

    expect(text).toContain('SVG DOM');
    expect(text).toMatch(/id="n1"|#n1/);
    expect(text).toMatch(/id="n2"|#n2/);
    expect(text).toContain('edge-n1-n2');
    expect(text).toContain('#edge-n1-n2');
    expect(text).toContain('querySelector');
    expect(text).toMatch(/visible/i);
    expect(text).toMatch(/first node visible/i);
    expect(text).toMatch(/expand all|reveal all|全部展开/i);
    expect(text).toMatch(/all nodes and all edges|every node and every edge/i);
    expect(text).toContain('viewBox');
    expect(text).toMatch(/non-zero bounding box|visible viewport/i);
    expect(text).toMatch(/legend-only|main diagram is blank|main graph canvas must not be blank/i);
    expect(text).toContain('widget-config');
    expect(text).toContain('JSON.parse');
    expect(text).toMatch(/valid JSON|JSON.parse-able/i);
    expect(text).toMatch(/malformed JSON|SyntaxError/i);
    expect(text).toMatch(/unescaped quotes|unescaped double quotes/i);
    expect(text).toMatch(/raw HTML fragments|raw HTML strings/i);
    expect(text).not.toMatch(UNRESOLVED_PLACEHOLDER);
  });

  test('widget-teacher-actions prompt aligns diagram targets with generated HTML selectors', () => {
    const text = combined(
      buildPrompt(PROMPT_IDS.WIDGET_TEACHER_ACTIONS, {
        widgetType: 'diagram',
        description: 'A connected system diagram.',
        keyPoints: '1. Follow node flow\n2. Inspect edge relationships',
        widgetConfig: JSON.stringify({
          type: 'diagram',
          nodes: [{ id: 'n1' }, { id: 'n2' }],
          edges: [{ from: 'n1', to: 'n2' }],
        }),
        languageDirective: 'Teach in English.',
      }),
    );

    expect(text).toContain('#n1');
    expect(text).toContain('#n2');
    expect(text).toContain('#edge-n1-n2');
    expect(text).toContain('querySelector-addressable');
    expect(text).toMatch(/guaranteed by the generated HTML|present in the widget config/i);
    expect(text).not.toMatch(UNRESOLVED_PLACEHOLDER);
  });
});
