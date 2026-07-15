import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');
const darkBlock = css.match(/\.dark\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';

function token(name: string): string | undefined {
  return darkBlock.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();
}

describe('global dark semantic palette', () => {
  it('uses the main-page slate hue for shared application surfaces', () => {
    expect({
      background: token('background'),
      card: token('card'),
      popover: token('popover'),
      secondary: token('secondary'),
      muted: token('muted'),
      accent: token('accent'),
      border: token('border'),
      input: token('input'),
      ring: token('ring'),
      sidebar: token('sidebar'),
      sidebarAccent: token('sidebar-accent'),
      sidebarBorder: token('sidebar-border'),
      sidebarRing: token('sidebar-ring'),
    }).toEqual({
      background: 'oklch(0.145 0.03 265)',
      card: 'oklch(0.205 0.035 265)',
      popover: 'oklch(0.205 0.035 265)',
      secondary: 'oklch(0.269 0.03 265)',
      muted: 'oklch(0.269 0.025 265)',
      accent: 'oklch(0.371 0.035 265)',
      border: 'oklch(1 0.03 265 / 10%)',
      input: 'oklch(1 0.03 265 / 15%)',
      ring: 'oklch(0.556 0.035 265)',
      sidebar: 'oklch(0.205 0.035 265)',
      sidebarAccent: 'oklch(0.269 0.03 265)',
      sidebarBorder: 'oklch(1 0.03 265 / 10%)',
      sidebarRing: 'oklch(0.556 0.035 265)',
    });
  });

  it('keeps the product accent and chart palette independent from surface tinting', () => {
    expect(token('primary')).toBe('#8b47ea');
    expect(token('chart-1')).toBe('oklch(0.809 0.105 251.813)');
    expect(token('chart-5')).toBe('oklch(0.424 0.199 265.638)');
  });
});
