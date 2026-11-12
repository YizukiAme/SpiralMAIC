/**
 * `/` — the home page.
 *
 * With the workbench entry on, the home page is the workspace itself: the same
 * shell `/workspace` renders, entered with the sidebar folded (see
 * `defaultNavCollapsed`). With it off — the default — the classic home stays
 * exactly as it was, every option on it included.
 *
 * The decision is the server-side gate `/workspace` already uses, so the two
 * routes cannot disagree: a disabled `/workspace` redirects here and lands on
 * the classic home rather than looping. The gate is read per request because
 * the root layout reads the request's cookies and headers, which already makes
 * every page dynamic. That is also what lets the shell go without a Suspense
 * boundary here; `/workspace` explains why an empty-fallback boundary around
 * the whole shell blanked the page.
 *
 * The workspace keeps its own URLs: once something is open the shell mirrors
 * it to `/workspace?…`, so existing deep links and their query keep working.
 */
import { isWorkbenchEntryEnabled } from '@/lib/workbench/entry-gate';
import { WorkspaceEntry } from '@/components/workbench/WorkspaceEntry';
import { ClassicHomePage } from './classic-home';
import { parseRevisitPanelReturn } from '@/lib/revisit/home-surface';

export default async function Page({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  if (!isWorkbenchEntryEnabled()) return <ClassicHomePage />;

  // Existing report/material/Demo links return to the Spiral panel, even when
  // the deployment opts into the workbench as its ordinary home.
  const query = await searchParams;
  const revisitReturn = parseRevisitPanelReturn({
    get: (name) => (typeof query?.[name] === 'string' ? query[name] : null),
  });
  if (revisitReturn) return <ClassicHomePage />;

  return <WorkspaceEntry />;
}
