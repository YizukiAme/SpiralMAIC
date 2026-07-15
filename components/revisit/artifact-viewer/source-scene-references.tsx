'use client';

import { Badge } from '@/components/ui/badge';
import { useI18n } from '@/lib/hooks/use-i18n';
import { resolveStudyArtifactSourceScenes } from '@/lib/revisit/artifact-view';
import type { Scene } from '@/lib/types/stage';
import { cn } from '@/lib/utils';

export function SourceSceneReferences({
  sourceSceneIds,
  sourceScenes,
  className,
}: {
  sourceSceneIds: string[];
  sourceScenes: Scene[];
  className?: string;
}) {
  const { t } = useI18n();
  const references = resolveStudyArtifactSourceScenes(sourceSceneIds, sourceScenes);

  return (
    <span className={cn('flex flex-wrap gap-2', className)}>
      {references.map((reference) => (
        <Badge
          key={reference.id}
          variant="outline"
          data-source-scene-id={reference.id}
          title={reference.missing ? reference.id : undefined}
          className="max-w-full whitespace-normal text-start"
        >
          {reference.missing
            ? t('revisit.viewer.sourcePageRemoved')
            : t('revisit.viewer.sourcePageLabel', {
                page: reference.pageNumber,
                title: reference.title,
              })}
        </Badge>
      ))}
    </span>
  );
}
