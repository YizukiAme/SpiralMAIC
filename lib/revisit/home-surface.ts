export interface HomeSurfaceState {
  showPromptComposer: boolean;
  showSpiralLogo: boolean;
}

export type RevisitPanelSection = 'challenge' | 'materials' | 'demo';

export interface RevisitPanelReturnState {
  stageId: string;
  section: RevisitPanelSection;
}

const REVISIT_PANEL_STAGE_PARAM = 'spiralStage';
const REVISIT_PANEL_SECTION_PARAM = 'spiralSection';

export function resolveHomeSurfaceState(args: {
  reverseChallengeEnabled: boolean;
}): HomeSurfaceState {
  return {
    showPromptComposer: !args.reverseChallengeEnabled,
    showSpiralLogo: args.reverseChallengeEnabled,
  };
}

export function shouldLoadRevisitHomeData(args: {
  reverseChallengeEnabled: boolean;
  stageCount: number;
}): boolean {
  return args.reverseChallengeEnabled && args.stageCount > 0;
}

export function isCurrentRevisitPanelRequest(requestId: number, currentRequestId: number): boolean {
  return requestId === currentRequestId;
}

export function parseRevisitPanelSection(value: string | null): RevisitPanelSection | null {
  return value === 'challenge' || value === 'materials' || value === 'demo' ? value : null;
}

export function buildRevisitPanelReturnUrl({ stageId, section }: RevisitPanelReturnState): string {
  const searchParams = new URLSearchParams({
    [REVISIT_PANEL_STAGE_PARAM]: stageId,
    [REVISIT_PANEL_SECTION_PARAM]: section,
  });
  return `/?${searchParams.toString()}`;
}

export function parseRevisitPanelReturn(
  searchParams: Pick<URLSearchParams, 'get'>,
): RevisitPanelReturnState | null {
  const stageId = searchParams.get(REVISIT_PANEL_STAGE_PARAM)?.trim();
  const section = parseRevisitPanelSection(searchParams.get(REVISIT_PANEL_SECTION_PARAM));
  return stageId && section ? { stageId, section } : null;
}

export function clearRevisitPanelReturnParams(url: URL): string {
  url.searchParams.delete(REVISIT_PANEL_STAGE_PARAM);
  url.searchParams.delete(REVISIT_PANEL_SECTION_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}
