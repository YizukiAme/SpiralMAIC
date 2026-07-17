# Legacy Spiral Challenge Agent Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let completed Spiral challenges created before roster snapshots open with the same built-in assistant and students they originally used.

**Architecture:** Add a pure compatibility-roster builder beside the existing Spiral roster validator. It clones the four historical built-in agents under synthetic `legacy-revisit-*` IDs, and the completed-attempt resolver uses it only after both persisted roster sources fail. Existing runtime hydration and strict ID resolution then work unchanged.

**Tech Stack:** TypeScript, React/Zustand agent registry, Dexie, Vitest.

## Global Constraints

- Compatibility applies only to completed attempts with no valid persisted roster.
- Never persist the compatibility roster to the course, attempt, or generated-agent database.
- Keep raw `default-*` IDs rejected by `resolveRevisitAgentIds()`.
- Keep unfinished-attempt behavior unchanged: missing rosters return to Generation Preview.
- Do not modify the user's unrelated dirty files in the main worktree.

---

### Task 1: Build and resolve the historical compatibility roster

**Files:**
- Modify: `tests/revisit/spiral-agents.test.ts`
- Modify: `lib/revisit/spiral-agents.ts`

**Interfaces:**
- Consumes: `AgentConfig` from `lib/orchestration/registry/types.ts` and the built-in definitions returned by `useAgentRegistry.getState().listAgents()`.
- Produces: `buildLegacyRevisitAgentRoster(candidates: readonly AgentConfig[]): PersistedAgentConfig[] | null`.
- Produces: updated `resolveAttemptSpiralAgentRoster(stage, status)` resolution order: Spiral snapshot, completed legacy generated roster, completed compatibility roster, or `null`.

- [ ] **Step 1: Write failing compatibility and precedence tests**

Extend `tests/revisit/spiral-agents.test.ts` with assertions equivalent to:

```ts
import { resolveRevisitAgentIds } from '@/lib/revisit/session';
import {
  buildLegacyRevisitAgentRoster,
  // existing imports
} from '@/lib/revisit/spiral-agents';

it('reconstructs the historical default roster only for completed attempts', () => {
  const roster = resolveAttemptSpiralAgentRoster(stage, 'completed');

  expect(roster?.map(({ id, name, role }) => ({ id, name, role }))).toEqual([
    { id: 'legacy-revisit-default-2', name: 'AI助教', role: 'assistant' },
    { id: 'legacy-revisit-default-4', name: '好奇宝宝', role: 'student' },
    { id: 'legacy-revisit-default-3', name: '显眼包', role: 'student' },
    { id: 'legacy-revisit-default-5', name: '笔记员', role: 'student' },
  ]);
  expect(resolveRevisitAgentIds(roster ?? [])).toEqual({
    assistantAgentId: 'legacy-revisit-default-2',
    studentAgentId: 'legacy-revisit-default-4',
    studentAgentIds: [
      'legacy-revisit-default-4',
      'legacy-revisit-default-3',
      'legacy-revisit-default-5',
    ],
  });
  expect(resolveAttemptSpiralAgentRoster(stage, 'ready')).toBeNull();
});

it('copies complete runtime metadata and rejects an incomplete built-in set', () => {
  const defaults = useAgentRegistry.getState().listAgents();
  const roster = buildLegacyRevisitAgentRoster(defaults);
  const original = defaults.find((agent) => agent.id === 'default-2');

  expect(roster?.[0]).toMatchObject({
    name: original?.name,
    role: original?.role,
    persona: original?.persona,
    avatar: original?.avatar,
    color: original?.color,
    priority: original?.priority,
    voiceConfig: original?.voiceConfig,
    voiceDesign: original?.voiceDesign,
  });
  expect(buildLegacyRevisitAgentRoster(defaults.filter((agent) => agent.id !== 'default-5'))).toBeNull();
});
```

Retain the existing test that proves an explicit Spiral roster and a valid
`generatedAgentConfigs` roster take precedence.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
./node_modules/.bin/vitest run tests/revisit/spiral-agents.test.ts
```

Expected: FAIL because `buildLegacyRevisitAgentRoster` is not exported and a completed empty stage
still resolves to `null`.

- [ ] **Step 3: Implement the minimal compatibility builder and fallback**

In `lib/revisit/spiral-agents.ts`, add:

```ts
import type { AgentConfig } from '@/lib/orchestration/registry/types';

const LEGACY_REVISIT_DEFAULT_AGENT_IDS = [
  'default-2',
  'default-4',
  'default-3',
  'default-5',
] as const;

export function buildLegacyRevisitAgentRoster(
  candidates: readonly AgentConfig[],
): PersistedAgentConfig[] | null {
  const byId = new Map(candidates.map((agent) => [agent.id, agent]));
  const defaults = LEGACY_REVISIT_DEFAULT_AGENT_IDS.map((id) => byId.get(id));
  if (defaults.some((agent) => !agent)) return null;

  const roster = defaults.map((agent) => {
    const resolved = agent!;
    return {
      id: `legacy-revisit-${resolved.id}`,
      name: resolved.name,
      role: resolved.role,
      persona: resolved.persona,
      avatar: resolved.avatar,
      color: resolved.color,
      priority: resolved.priority,
      ...(resolved.voiceConfig ? { voiceConfig: structuredClone(resolved.voiceConfig) } : {}),
      ...(resolved.voiceDesign ? { voiceDesign: structuredClone(resolved.voiceDesign) } : {}),
    };
  });
  return isValidSpiralAgentRoster(roster) ? roster : null;
}
```

Update the completed-attempt tail of `resolveAttemptSpiralAgentRoster()`:

```ts
if (isValidSpiralAgentRoster(legacyCandidates)) return legacyCandidates;
return buildLegacyRevisitAgentRoster(useAgentRegistry.getState().listAgents());
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
./node_modules/.bin/vitest run tests/revisit/spiral-agents.test.ts tests/revisit/session.test.ts
```

Expected: both files PASS.

- [ ] **Step 5: Add the runtime-isolation regression test**

Extend the existing hydration test to hydrate the resolved compatibility roster and assert:

```ts
const defaultBefore = useAgentRegistry.getState().getAgent('default-2');
const roster = resolveAttemptSpiralAgentRoster(stage, 'completed');
expect(roster).not.toBeNull();

hydrateSpiralAgentRegistry(stage.id, roster!);

expect(useAgentRegistry.getState().getAgent('default-2')).toEqual(defaultBefore);
expect(
  useAgentRegistry.getState().listAgents().filter((agent) => agent.isGenerated).map((agent) => agent.id),
).toEqual(roster!.map((agent) => agent.id));
expect(await db.generatedAgents.toArray()).toEqual([]);
```

- [ ] **Step 6: Run the isolation test and verify GREEN**

Run:

```bash
./node_modules/.bin/vitest run tests/revisit/spiral-agents.test.ts
```

Expected: PASS with the built-in `default-2` unchanged and no generated-agent database writes.

- [ ] **Step 7: Commit the compatibility implementation**

```bash
git add lib/revisit/spiral-agents.ts tests/revisit/spiral-agents.test.ts
git commit -m "fix(spiral): restore legacy challenge rosters"
```

### Task 2: Verify the complete historical playback path

**Files:**
- Verify: `app/classroom/[id]/revisit/page.tsx`
- Verify: `lib/revisit/session.ts`
- Verify: all repository tests and build inputs

**Interfaces:**
- Consumes: the compatibility roster returned by Task 1.
- Produces: evidence that the existing page load, transient hydration, participant resolution, chat request, and TTS paths accept the synthetic roster without further production changes.

- [ ] **Step 1: Run all focused revisit tests**

Run:

```bash
./node_modules/.bin/vitest run tests/revisit
```

Expected: all revisit test files PASS.

- [ ] **Step 2: Run the complete Vitest suite**

Run:

```bash
./node_modules/.bin/vitest run
```

Expected: all non-skipped tests PASS.

- [ ] **Step 3: Run lint**

Run:

```bash
pnpm lint
```

Expected: exit 0; existing warnings may remain, but no new warnings or errors may originate from
the two changed source/test files.

- [ ] **Step 4: Run the production build**

Run:

```bash
pnpm build
```

Expected: exit 0 with successful TypeScript compilation and production bundle generation.

- [ ] **Step 5: Review the final diff and working tree**

Run:

```bash
git diff HEAD^ --check
git diff HEAD^ -- lib/revisit/spiral-agents.ts tests/revisit/spiral-agents.test.ts
git status --short --branch
```

Expected: only the approved design, plan, compatibility source, and tests are present on the
feature branch; no unrelated main-worktree files appear.
