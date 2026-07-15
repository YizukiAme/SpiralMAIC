import type { StudyArtifactKind } from '@/lib/revisit/types';

export type StudyArtifactVisualExportFormat = 'png' | 'svg';

export function getStudyArtifactVisualExportFormats(
  kind: StudyArtifactKind,
): StudyArtifactVisualExportFormat[] {
  if (kind === 'briefing') return ['png'];
  if (kind === 'mindMap') return ['png', 'svg'];
  return [];
}

export function createStudyArtifactExportFilename(
  title: string,
  version: number,
  format: StudyArtifactVisualExportFormat,
): string {
  const safeTitle =
    title
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 90) || 'study-artifact';
  return `${safeTitle}-v${version}.${format}`;
}

export async function exportStudyArtifactElement(args: {
  element: HTMLElement;
  title: string;
  version: number;
  format: StudyArtifactVisualExportFormat;
}): Promise<void> {
  await document.fonts?.ready;
  const captureElement = createCaptureClone(args.element);
  const hadDarkTheme = document.documentElement.classList.contains('dark');
  if (hadDarkTheme) document.documentElement.classList.remove('dark');
  document.body.appendChild(captureElement);

  try {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const { toPng, toSvg } = await import('html-to-image');
    const width = Math.max(captureElement.scrollWidth, captureElement.clientWidth);
    const height = Math.max(captureElement.scrollHeight, captureElement.clientHeight);
    const options = {
      cacheBust: true,
      backgroundColor: '#ffffff',
      width,
      height,
      pixelRatio: args.format === 'png' ? 2 : 1,
    };
    const dataUrl =
      args.format === 'png'
        ? await toPng(captureElement, options)
        : await toSvg(captureElement, options);
    if (!dataUrl || dataUrl === 'data:,') {
      throw new Error('Visual export produced no content.');
    }

    const link = document.createElement('a');
    link.download = createStudyArtifactExportFilename(args.title, args.version, args.format);
    link.href = dataUrl;
    link.click();
  } finally {
    captureElement.remove();
    if (hadDarkTheme) document.documentElement.classList.add('dark');
  }
}

function createCaptureClone(element: HTMLElement): HTMLElement {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.removeAttribute('id');
  Object.assign(clone.style, {
    position: 'fixed',
    inset: '0 auto auto 0',
    left: '0',
    top: '0',
    zIndex: '-1',
    pointerEvents: 'none',
  });
  return clone;
}
