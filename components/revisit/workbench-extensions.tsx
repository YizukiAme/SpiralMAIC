'use client';

import { useMemo, type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useSettingsStore } from '@/lib/store/settings';
import { WorkbenchShellExtensionsProvider } from '@/lib/workbench/shell-extensions';

/** Keep the Spiral library reachable through the workbench's host navigation slot. */
export function SpiralWorkbenchExtensions({ children }: { readonly children?: ReactNode }) {
  const router = useRouter();
  const setReverseChallengeEnabled = useSettingsStore((s) => s.setReverseChallengeEnabled);
  const value = useMemo(
    () => ({
      navItems: [
        {
          id: 'spiral',
          label: 'SpiralMAIC',
          icon: RotateCcw,
          onSelect: () => {
            setReverseChallengeEnabled(true);
            router.push('/spiral');
          },
        },
      ],
    }),
    [router, setReverseChallengeEnabled],
  );
  return (
    <WorkbenchShellExtensionsProvider value={value}>{children}</WorkbenchShellExtensionsProvider>
  );
}
