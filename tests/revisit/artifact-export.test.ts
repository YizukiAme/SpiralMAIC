import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createStudyArtifactExportFilename,
  exportStudyArtifactElement,
  getStudyArtifactVisualExportFormats,
} from '@/lib/revisit/artifact-export';

const imageMocks = vi.hoisted(() => ({
  toPng: vi.fn(async (_element: HTMLElement, _options: unknown) =>
    Promise.resolve('data:image/png;base64,non-empty'),
  ),
  toSvg: vi.fn(async (_element: HTMLElement, _options: unknown) =>
    Promise.resolve('data:image/svg+xml;base64,non-empty'),
  ),
}));

vi.mock('html-to-image', () => imageMocks);

class FakeClassList {
  private readonly values = new Set<string>();

  add(value: string) {
    this.values.add(value);
  }

  remove(value: string) {
    this.values.delete(value);
  }

  contains(value: string) {
    return this.values.has(value);
  }
}

class FakeElement {
  id = '';
  className = '';
  style: Record<string, string> = {};
  scrollWidth = 0;
  clientWidth = 0;
  scrollHeight = 0;
  clientHeight = 0;
  parent: FakeElement | null = null;
  children: FakeElement[] = [];
  clickCount = 0;
  download = '';
  href = '';

  constructor(readonly tagName = 'div') {}

  get isConnected() {
    return this.parent !== null;
  }

  cloneNode() {
    const clone = new FakeElement(this.tagName);
    Object.assign(clone, {
      id: this.id,
      className: this.className,
      scrollWidth: this.scrollWidth,
      clientWidth: this.clientWidth,
      scrollHeight: this.scrollHeight,
      clientHeight: this.clientHeight,
    });
    return clone;
  }

  removeAttribute(name: string) {
    if (name === 'id') this.id = '';
  }

  appendChild(child: FakeElement) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }

  click() {
    this.clickCount += 1;
  }
}

function createFakeDocument() {
  const body = new FakeElement('body');
  const documentElement = new FakeElement('html') as FakeElement & { classList: FakeClassList };
  documentElement.classList = new FakeClassList();
  let lastAnchor: FakeElement | undefined;
  return {
    body,
    documentElement,
    fonts: { ready: Promise.resolve() },
    createElement(tagName: string) {
      const element = new FakeElement(tagName);
      if (tagName === 'a') lastAnchor = element;
      return element;
    },
    getLastAnchor: () => lastAnchor,
  };
}

let fakeDocument: ReturnType<typeof createFakeDocument>;

beforeEach(() => {
  vi.clearAllMocks();
  fakeDocument = createFakeDocument();
  vi.stubGlobal('document', fakeDocument as unknown as Document);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('study artifact visual exports', () => {
  it('offers visual formats only for fixed visual artifacts', () => {
    expect(getStudyArtifactVisualExportFormats('briefing')).toEqual(['png']);
    expect(getStudyArtifactVisualExportFormats('mindMap')).toEqual(['png', 'svg']);
    expect(getStudyArtifactVisualExportFormats('studyGuide')).toEqual([]);
    expect(getStudyArtifactVisualExportFormats('faq')).toEqual([]);
  });

  it('creates filesystem-safe versioned filenames', () => {
    expect(createStudyArtifactExportFilename('Grammar: A/B', 2, 'png')).toBe('Grammar-A-B-v2.png');
  });

  it('captures a positioned clone, restores the theme, and triggers a non-empty download', async () => {
    const element = new FakeElement();
    Object.assign(element, {
      id: 'artifact-visual-export',
      className: 'fixed -left-[20000px]',
      scrollWidth: 800,
      clientWidth: 800,
      scrollHeight: 600,
      clientHeight: 600,
    });
    fakeDocument.body.appendChild(element);
    fakeDocument.documentElement.classList.add('dark');

    await exportStudyArtifactElement({
      element: element as unknown as HTMLElement,
      title: 'Grammar map',
      version: 2,
      format: 'png',
    });

    const capture = imageMocks.toPng.mock.calls[0]?.[0] as unknown as FakeElement;
    expect(capture).not.toBe(element);
    expect(capture.id).toBe('');
    expect(capture.style.left).toBe('0');
    expect(capture.isConnected).toBe(false);
    expect(imageMocks.toPng).toHaveBeenCalledWith(
      capture,
      expect.objectContaining({ width: 800, height: 600, pixelRatio: 2 }),
    );
    expect(fakeDocument.documentElement.classList.contains('dark')).toBe(true);
    expect(fakeDocument.getLastAnchor()).toMatchObject({
      clickCount: 1,
      download: 'Grammar-map-v2.png',
      href: 'data:image/png;base64,non-empty',
    });
  });
});
