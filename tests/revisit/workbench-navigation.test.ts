// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SpiralWorkbenchExtensions } from '@/components/revisit/workbench-extensions';
import { useWorkbenchShellExtensions } from '@/lib/workbench/shell-extensions';
import { useSettingsStore } from '@/lib/store/settings';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it('opens the Spiral library from the workbench even when review mode was disabled', async () => {
  function Navigation() {
    const item = useWorkbenchShellExtensions().navItems?.find((entry) => entry.id === 'spiral');
    return createElement('button', { onClick: item?.onSelect }, item?.label);
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  const initial = useSettingsStore.getState().reverseChallengeEnabled;
  try {
    useSettingsStore.getState().setReverseChallengeEnabled(false);
    await act(async () =>
      root.render(createElement(SpiralWorkbenchExtensions, null, createElement(Navigation))),
    );
    const button = container.querySelector('button');
    expect(button?.textContent).toBe('SpiralMAIC');
    await act(async () => button!.click());
    expect(useSettingsStore.getState().reverseChallengeEnabled).toBe(true);
    expect(push).toHaveBeenCalledWith('/spiral');
  } finally {
    await act(async () => root.unmount());
    useSettingsStore.getState().setReverseChallengeEnabled(initial);
  }
});
