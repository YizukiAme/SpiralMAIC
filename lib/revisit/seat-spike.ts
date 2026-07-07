import type { UIMessage } from 'ai';

import type { ChatMessageMetadata, StatelessChatRequest } from '@/lib/types/chat';
import type { StatelessEvent } from '@/lib/types/chat';

export const REVISIT_SPIKE_STUDENT_AGENT_ID = 'revisit-spike-wb-student';

interface CreateRevisitSeatSpikeRequestArgs {
  teacherUtterance: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  providerType?: string;
}

export function createRevisitSeatSpikeRequest({
  teacherUtterance,
  model,
  apiKey,
  baseUrl,
  providerType,
}: CreateRevisitSeatSpikeRequestArgs): StatelessChatRequest {
  const message: UIMessage<ChatMessageMetadata> = {
    id: `revisit-teacher-${Date.now()}`,
    role: 'user',
    parts: [{ type: 'text', text: teacherUtterance }],
    metadata: {
      originalRole: 'teacher',
      senderName: 'Teacher (User)',
      createdAt: Date.now(),
    },
  };

  return {
    messages: [message],
    storeState: {
      stage: null,
      scenes: [],
      currentSceneId: null,
      mode: 'playback',
      whiteboardOpen: false,
    },
    config: {
      agentIds: [REVISIT_SPIKE_STUDENT_AGENT_ID],
      agentConfigs: [
        {
          id: REVISIT_SPIKE_STUDENT_AGENT_ID,
          name: 'AI Student',
          role: 'student',
          persona:
            'You are a curious student in a reverse teaching challenge. Listen to the human teacher and respond with one short question or reaction.',
          avatar: 'S',
          color: '#22c55e',
          allowedActions: [],
          priority: 5,
          isGenerated: true,
        },
      ],
    },
    apiKey,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(providerType ? { providerType } : {}),
  };
}

export interface RevisitSeatSpikeSummary {
  dispatchedStudent: boolean;
  studentResponded: boolean;
  responseText: string;
  cueUserReceived: boolean;
  errorMessage: string | null;
}

export function summarizeRevisitSeatSpikeEvents(events: StatelessEvent[]): RevisitSeatSpikeSummary {
  let dispatchedStudent = false;
  let responseText = '';
  let cueUserReceived = false;
  let errorMessage: string | null = null;

  for (const event of events) {
    if (
      event.type === 'thinking' &&
      event.data.stage === 'agent_loading' &&
      event.data.agentId === REVISIT_SPIKE_STUDENT_AGENT_ID
    ) {
      dispatchedStudent = true;
    }

    if (event.type === 'agent_start' && event.data.agentId === REVISIT_SPIKE_STUDENT_AGENT_ID) {
      dispatchedStudent = true;
    }

    if (event.type === 'text_delta') {
      responseText += event.data.content;
    }

    if (event.type === 'cue_user') {
      cueUserReceived = true;
    }

    if (event.type === 'error') {
      errorMessage = event.data.message;
    }
  }

  return {
    dispatchedStudent,
    studentResponded: responseText.trim().length > 0,
    responseText,
    cueUserReceived,
    errorMessage,
  };
}

export function parseRevisitSeatSpikeSse(input: string): {
  events: StatelessEvent[];
  remaining: string;
} {
  const normalized = input.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const remaining = blocks.pop() ?? '';
  const events: StatelessEvent[] = [];

  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');

    if (!data) continue;

    try {
      events.push(JSON.parse(data) as StatelessEvent);
    } catch {
      // Ignore malformed complete blocks; incomplete blocks stay in `remaining`.
    }
  }

  return { events, remaining };
}
