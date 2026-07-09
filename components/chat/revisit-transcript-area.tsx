'use client';

import { useMemo, useState } from 'react';
import { MessageSquare, PanelRightClose } from 'lucide-react';

import { SessionList } from '@/components/chat/session-list';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import type { ChatSession } from '@/lib/types/chat';

interface RevisitTranscriptAreaProps {
  readonly session: ChatSession;
  readonly width: number;
  readonly collapsed: boolean;
  readonly isStreaming: boolean;
  readonly activeBubbleId?: string | null;
  readonly onCollapseChange: (collapsed: boolean) => void;
}

export function RevisitTranscriptArea({
  session,
  width,
  collapsed,
  isStreaming,
  activeBubbleId,
  onCollapseChange,
}: RevisitTranscriptAreaProps) {
  const { t } = useI18n();
  const [expandedSessionIds, setExpandedSessionIds] = useState(() => new Set([session.id]));
  const sessions = useMemo(() => [session], [session]);

  return (
    <div
      style={{
        width: collapsed ? 0 : width,
        transition: 'width 0.3s ease',
      }}
      className="bg-white/80 dark:bg-gray-900/80 backdrop-blur-xl border-l border-gray-100 dark:border-gray-800 shadow-[-2px_0_24px_rgba(0,0,0,0.02)] flex flex-col shrink-0 z-20 relative overflow-visible"
    >
      <div className={cn('flex flex-col w-full h-full overflow-hidden', collapsed && 'hidden')}>
        <div className="h-10 flex items-center gap-2 shrink-0 mt-3 mb-1 px-3">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-xs font-semibold text-gray-600 dark:text-gray-300">
            <MessageSquare className="size-3.5 shrink-0" />
            <span className="truncate">{t('chat.tabs.chat')}</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={() => onCollapseChange(true)}
            aria-label={t('common.close')}
          >
            <PanelRightClose className="size-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-2 scrollbar-hide">
          <SessionList
            sessions={sessions}
            expandedSessionIds={expandedSessionIds}
            isStreaming={isStreaming}
            activeBubbleId={activeBubbleId}
            onToggleExpand={(sessionId) =>
              setExpandedSessionIds((prev) => {
                const next = new Set(prev);
                if (next.has(sessionId)) {
                  next.delete(sessionId);
                } else {
                  next.add(sessionId);
                }
                return next;
              })
            }
          />
        </div>
      </div>
    </div>
  );
}
