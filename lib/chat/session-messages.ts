import type { ChatMessageMetadata } from '@/lib/types/chat';
import type { UIMessage } from 'ai';

/**
 * Keep the request snapshot as the canonical timeline so a lagging React ref
 * cannot erase the user message that started the current turn. Live session
 * data may only refresh messages by id or append messages produced afterwards.
 */
export function mergeAgentLoopMessages(
  baseline: UIMessage<ChatMessageMetadata>[],
  live: UIMessage<ChatMessageMetadata>[] | undefined,
): UIMessage<ChatMessageMetadata>[] {
  if (!live || live.length === 0) return baseline;

  const latestLiveById = new Map(live.map((message) => [message.id, message] as const));
  const seen = new Set<string>();
  const merged = baseline.map((message) => {
    seen.add(message.id);
    return latestLiveById.get(message.id) ?? message;
  });

  for (const message of live) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(latestLiveById.get(message.id) ?? message);
  }

  return merged;
}
