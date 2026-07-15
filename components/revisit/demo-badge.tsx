'use client';

import { useEffect, useState } from 'react';
import { FlaskConical } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { listRevisitDemoSessions } from '@/lib/revisit/db';
import type { RevisitDataScope } from '@/lib/revisit/scope';

export function RevisitDemoBadge({
  scope,
  offsetHours,
  className,
}: {
  scope: RevisitDataScope;
  offsetHours?: number;
  className?: string;
}) {
  const [resolvedOffset, setResolvedOffset] = useState(offsetHours ?? 0);

  useEffect(() => {
    if (scope.kind !== 'demo' || offsetHours !== undefined) return;
    let cancelled = false;
    void listRevisitDemoSessions().then((sessions) => {
      const session = sessions.find((item) => item.id === scope.sessionId);
      if (!cancelled && session) setResolvedOffset(session.offsetHours);
    });
    return () => {
      cancelled = true;
    };
  }, [offsetHours, scope]);

  if (scope.kind !== 'demo') return null;
  return (
    <Badge
      variant="outline"
      className={
        className ??
        'max-sm:w-8 max-sm:justify-start max-sm:overflow-hidden max-sm:px-1.5 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
      }
      title={`Demo · +${offsetHours ?? resolvedOffset}h`}
    >
      <FlaskConical />
      Demo · +{offsetHours ?? resolvedOffset}h
    </Badge>
  );
}
