import type { Page } from '@playwright/test';
import { mockOutlines } from './test-data/scene-outlines';
import { mockSceneContentResponse } from './test-data/scene-content';
import { createMockSceneActionsResponse } from './test-data/scene-actions';

/**
 * Wraps Playwright's page.route() to mock OpenMAIC API endpoints.
 * Supports both JSON and SSE (text/event-stream) responses.
 */
export class MockApi {
  constructor(private page: Page) {}

  /** Mock the SSE outline streaming endpoint */
  async mockSceneOutlinesStream(outlines = mockOutlines) {
    await this.page.route('**/api/generate/scene-outlines-stream', (route) => {
      const events = outlines
        .map(
          (outline, i) =>
            `data: ${JSON.stringify({ type: 'outline', data: outline, index: i })}\n\n`,
        )
        .join('');
      const done = `data: ${JSON.stringify({ type: 'done', outlines, courseTitle: 'Mock Course' })}\n\n`;

      route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
        body: events + done,
      });
    });
  }

  /** Mock the scene content generation endpoint */
  async mockSceneContent(response = mockSceneContentResponse) {
    await this.page.route('**/api/generate/scene-content', (route) => {
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(response),
      });
    });
  }

  /** Mock the scene actions generation endpoint.
   *  When no stageId is provided, it is extracted from the request body
   *  so the mock response matches the dynamically-generated stage id. */
  async mockSceneActions(stageId?: string) {
    await this.page.route('**/api/generate/scene-actions', async (route) => {
      let id = stageId ?? 'test-stage';
      if (!stageId) {
        try {
          const body = route.request().postDataJSON();
          if (body?.stageId) id = body.stageId;
        } catch {
          // fallback to default
        }
      }
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createMockSceneActionsResponse(id)),
      });
    });
  }

  /** Mock the server providers endpoint (returns empty — client-side config only) */
  async mockServerProviders() {
    await this.page.route('**/api/server-providers', (route) => {
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: {} }),
      });
    });
  }

  /** Set up API mocks for the generation flow. Note: server-providers is already mocked by the base fixture. */
  async setupGenerationMocks(stageId?: string) {
    await this.mockSceneOutlinesStream();
    await this.mockSceneContent();
    await this.mockSceneActions(stageId);
  }

  /** Two deterministic Reverse Challenge turns: follow-up first, then a passing gate. */
  async mockRevisitChat() {
    let turn = 0;
    await this.page.route('**/api/chat', (route) => {
      turn += 1;
      const isFollowUp = turn === 1;
      const messageId = `revisit-student-message-${turn}`;
      const events = [
        {
          type: 'agent_start',
          data: {
            messageId,
            agentId: 'spiral-student-1',
            agentName: 'Bo',
          },
        },
        {
          type: 'text_delta',
          data: {
            messageId,
            content: isFollowUp
              ? 'Could you give one real-world example?'
              : 'The houseplant example makes the energy conversion clear.',
          },
        },
        {
          type: 'agent_end',
          data: { messageId, agentId: 'spiral-student-1' },
        },
        {
          type: 'revisit_gate',
          data: {
            status: isFollowUp ? 'probe' : 'pass',
            pageIndex: 0,
            reason: isFollowUp
              ? 'The student requested a transfer example.'
              : 'The explanation and example covered the concept.',
            confidence: 0.95,
            studentStates: {
              'spiral-student-1': isFollowUp ? 'questioning' : 'satisfied',
              'spiral-student-2': 'satisfied',
            },
            ...(isFollowUp ? { nextProbeId: 'probe-1' } : {}),
          },
        },
        {
          type: 'done',
          data: {
            totalActions: 0,
            totalAgents: 1,
            agentHadContent: true,
            cueUserReceived: true,
            directorState: { turnCount: turn, agentResponses: [], whiteboardLedger: [] },
          },
        },
      ];
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      });
    });
  }

  /** A deterministic report response; persistence still runs through the production client path. */
  async mockRevisitJudge() {
    await this.page.route('**/api/revisit/judge', async (route) => {
      const request = route.request().postDataJSON();
      const completedAt = request.completedAt ?? Date.now();
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          report: {
            attemptId: request.attemptId,
            stageId: request.stageId,
            completedAt,
            summary: 'You clearly connected light energy to stored chemical energy.',
            dimensions: {
              clarity: 0.9,
              doubtResolution: 0.85,
              transfer: 0.88,
              errorCorrection: 0.92,
            },
            qRaw: 0.89,
            q: 0.89,
            errors: [],
            evidence: [
              {
                id: 'evidence-v04-1',
                attemptId: request.attemptId,
                stageId: request.stageId,
                conceptId: 'photosynthesis',
                source: 'teach_back',
                scores: {
                  clarity: 0.9,
                  doubtResolution: 0.85,
                  transfer: 0.88,
                  errorCorrection: 0.92,
                },
                qRaw: 0.89,
                q: 0.89,
                polarity: 'positive',
                timestamp: completedAt,
                pageIndex: 0,
                errors: [],
              },
            ],
            pageReports: request.pageReports,
          },
        }),
      });
    });
  }
}
