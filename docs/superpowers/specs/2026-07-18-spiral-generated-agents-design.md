# Spiral Course-Owned Generated Agents

**Date:** 2026-07-18
**Status:** Approved design, pending implementation plan

## Goal

Give each course a customized Spiral roster generated from that course's content. The roster is
created once, during the first Spiral preparation flow, and reused for all later challenges and
replays. The generation mechanics and reveal experience should match normal course agent
generation, while the role mix reflects the reversed classroom: the user is the teacher, so the AI
roster contains one assistant and two or three students.

## Product Contract

- The first Spiral preparation for a course generates one course-owned Spiral roster.
- Later Spiral attempts reuse that roster without another model call.
- There is no manual regenerate action.
- The normal course roster and the Spiral roster are separate and must not overwrite one another.
- The first generation is visible in Generation Preview as an agent-generation step followed by
  the existing agent card reveal.
- Generation failures stop the preparation flow and offer retry. They never silently fall back to
  preset agents.
- Historical attempts use their own source-stage snapshot so the people shown in a replay remain
  stable.

## Non-Goals

- Letting users manually create, edit, reorder, or regenerate Spiral agents.
- Sharing one Spiral roster across multiple courses.
- Replacing the normal course's generated or preset agents.
- Adding new student or assistant prompt templates.
- Changing challenge grading, navigation gates, memory decay, or completion semantics.

## Data Ownership

### App-Level Stage Extension

Extend the app-facing `Stage` type from the universal DSL stage and add:

```ts
spiralAgentConfigs?: GeneratedAgentConfig[];
```

This is SpiralMAIC-specific product state and should not be added to the universal
`@openmaic/dsl` contract.

`stage.spiralAgentConfigs` is the canonical course-owned roster. The existing
`stage.generatedAgentConfigs`, `stage.agentIds`, and generated-agents database records retain their
current normal-course meaning.

### Attempt Snapshot

Every newly prepared `RevisitAttempt` copies the current stage into `sourceStage`, including
`spiralAgentConfigs`. Spiral runtime and replay resolve agents from this attempt snapshot, rather
than scanning every agent in the global registry.

For an unfinished legacy attempt whose snapshot lacks the field, preparation may load or generate
the course roster and then refresh that attempt's source-stage snapshot before continuing.

### Persistence Isolation

Do not save the Spiral roster with the current `saveGeneratedAgents(stageId, agents)` helper. That
helper deletes all generated-agent records for the stage before writing and would therefore erase
the normal course roster.

Add a Spiral-specific persistence boundary that:

1. writes `spiralAgentConfigs` into the stage record;
2. updates the active attempt snapshot when necessary;
3. hydrates those configs into the runtime registry for a Spiral session without replacing the
   persisted normal-course records; and
4. lets the existing classroom load path restore the normal course agents after leaving Spiral.

Spiral agent IDs must use a separate, collision-resistant namespace and remain stable after the
first successful save.

## Generation API

Reuse `/api/generate/agent-profiles` with an explicit mode discriminator:

```ts
mode?: "course" | "spiral";
```

Omitted mode retains today's course behavior for backward compatibility.

Both modes use the same provider resolution, language directive, model/thinking configuration,
avatar catalog, enabled voice catalog, voice-design normalization, color assignment, and response
shape.

Spiral mode changes the instructional brief and validates the result:

- exactly one `assistant`;
- two or three `student` agents;
- no `teacher`;
- personas are suited to being taught by the user;
- students exhibit meaningfully different knowledge gaps, reasoning habits, and questioning
  styles; and
- the assistant supports the user only when the challenge needs scaffolding or rescue.

The route must reject an invalid role composition instead of accepting a partial roster that would
later require preset fallbacks. Existing route retry facilities should include schema and role-count
validation where practical.

## Generation Preview Flow

The existing revisit flow has two steps: challenge-path preparation and first-page generation.
For a course that does not yet own a valid Spiral roster, the active steps become:

1. prepare the Spiral challenge path;
2. generate Spiral agents;
3. reveal the generated agent cards;
4. generate the first Spiral page; and
5. enter the challenge.

After the challenge blueprint is available, map its skeleton pages into the outline-shaped context
accepted by agent generation. Send those page titles and assessment goals together with the
original course name, description, language directive, avatars, voices, and model settings.

The agent-generation step reuses the existing title, icon, description, and progress treatment
from normal course generation. The reveal reuses `AgentRevealModal`; no second Spiral-only reveal
component should be introduced.

Persist the generated roster before opening the reveal. Record enough attempt preparation state to
distinguish:

- roster absent: generate it;
- roster saved but reveal incomplete: reopen the same cards without another model call; and
- reveal complete: continue to first-page generation.

For later attempts, `getActiveSteps` omits the agent-generation step entirely. The UI must not show
a fake completed generation step or reopen the reveal when no generation occurred.

## Runtime Resolution

Spiral runtime receives the attempt snapshot's `spiralAgentConfigs` and registers those exact
configs for chat, Roundtable participants, avatars, personas, priorities, and TTS.

Agent-role resolution is deterministic:

- `assistantAgentId` is the single assistant in the snapshot;
- `studentAgentIds` contains all two or three students in roster order; and
- `studentAgentId` is the first student when a single legacy field is required.

The new production path does not fall back to `REVISIT_DEFAULT_STUDENT_AGENT_IDS` or
`REVISIT_ASSISTANT_AGENT_ID`. Those constants may remain only for genuinely historical,
non-runnable compatibility code if tests prove they are still needed. A missing or invalid roster
in a runnable challenge redirects back to preparation instead of disguising the problem with
default agents.

The existing `agent-system-wb-student` and `agent-system-wb-assistant` templates remain authoritative.
Generated persona, avatar, voice, color, and priority are configuration injected into those roles;
the feature does not fork prompt templates.

## Import and Export

Add an optional `spiralAgents` collection to the classroom manifest. It uses the same portable
agent fields as the normal `agents` collection but is semantically separate.

Export includes the course's Spiral roster when present. Import:

1. generates fresh IDs for imported Spiral agents;
2. writes them to the imported stage's `spiralAgentConfigs`; and
3. does not put them into the normal generated-agents table.

Old manifests without `spiralAgents` remain valid. Their imported courses generate a roster on the
first Spiral preparation.

## Failure and Recovery

- Agent generation failure sets the attempt preparation error and leaves the user on Generation
  Preview at the agent step.
- Retry uses the same attempt.
- If no roster was committed, retry calls the model again.
- If the roster was committed before an interruption, retry/reload reuses it and resumes the reveal
  or next generation phase.
- No error path writes an incomplete roster.
- No error path changes normal course agent selection or generated-agent records.
- Abort and navigation behavior follows the current Generation Preview abort controller and does
  not surface intentional navigation as a generation error.

## Compatibility

- Existing courses require no eager migration.
- Existing courses with normal auto-generated agents keep them unchanged.
- Existing courses using preset agents keep their preset selection unchanged.
- Legacy unfinished attempts get their roster during the next preparation.
- Completed historical attempts that already contain enough agent information remain replayable.
  If a completed snapshot cannot identify its original participants, the UI should report that the
  historical challenge lacks roster data rather than inventing new people for the replay.

## Test Plan

### API

- Course mode preserves the existing one-teacher contract.
- Spiral mode accepts exactly one assistant plus two or three students.
- Spiral mode rejects a teacher, a missing assistant, fewer than two students, or more than three
  students.
- Language, avatar, color, voice, and voice-design normalization remain shared with course mode.

### Persistence

- Saving a Spiral roster persists it on the stage and attempt snapshot.
- Saving a Spiral roster does not delete or mutate normal generated-agent records.
- Reloading a course returns the same stable Spiral agent IDs.
- Import/export round-trips normal and Spiral rosters independently.
- Old stage and manifest records without the new optional field still load.

### Generation Preview

- First Spiral preparation includes the agent-generation step and calls the API once.
- The existing reveal modal receives the generated assistant and students.
- Refresh during reveal reopens the saved roster without a second API call.
- Later attempts omit the step, do not call the API, and do not show the reveal.
- A failed request remains retryable and never advances with default agents.

### Runtime

- Challenge participants, chat configs, avatars, personas, and TTS all use the snapshot roster.
- The assistant and all two or three students are resolved deterministically.
- Normal classroom loading after Spiral restores the normal roster.
- A runnable attempt with missing/invalid Spiral roster returns to preparation.
- Historical replay uses the attempt snapshot even if unrelated registry agents are present.

## Acceptance Criteria

The feature is complete when a user can generate a normal course, finish it, start Spiral, watch a
course-specific assistant and two or three students being generated and revealed in Generation
Preview, complete the challenge with those agents, and enter later challenges with the exact same
agents without another generation call. At no point may this process overwrite the course's normal
agents or silently substitute preset agents.
