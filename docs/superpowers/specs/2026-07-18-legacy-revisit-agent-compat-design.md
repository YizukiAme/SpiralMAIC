# Legacy Spiral Challenge Agent Compatibility

## Goal

Restore read-only playback for completed Spiral challenges created before agent rosters were
snapshotted, without weakening the generated-roster requirements for new or unfinished
challenges.

## Root Cause

Older Spiral challenges did not persist an agent roster on their attempt snapshot. At runtime
they always used the built-in assistant and three built-in students:

- `default-2` — AI助教
- `default-4` — 好奇宝宝
- `default-3` — 显眼包
- `default-5` — 笔记员

The generated-agent rollout correctly made new challenges require an explicit course-owned
roster, but it also made completed legacy attempts without a roster fail with
`this historical challenge does not contain its agent roster`.

## Chosen Design

When and only when a completed attempt has neither a valid `spiralAgentConfigs` snapshot nor a
valid legacy `generatedAgentConfigs` roster, runtime creates an in-memory compatibility roster
from the four built-in agents above.

Each compatibility agent receives a stable `legacy-revisit-*` ID while retaining the original
name, role, persona, avatar, color, priority, actions, and voice metadata. Synthetic IDs keep the
runtime hydration path from overwriting or deleting the registry's actual `default-*` entries.

The compatibility roster is not persisted to the course, attempt, or generated-agent database.
It exists only for the lifetime of that historical playback session.

## Resolution Order

The runtime roster resolver uses this order:

1. A valid `sourceStage.spiralAgentConfigs` snapshot.
2. For completed legacy attempts, a valid assistant/student subset from
   `sourceStage.generatedAgentConfigs`.
3. For completed legacy attempts only, the synthetic compatibility roster built from the four
   historical defaults.
4. No roster.

Unfinished attempts that reach step 4 continue to return to Generation Preview for normal Spiral
agent generation. They never receive the compatibility defaults.

## Runtime Isolation

Compatibility agents use the existing transient Spiral registry hydration path. Hydration may
clear other generated runtime agents, but it must not mutate the built-in defaults or write normal
generated-agent records. Leaving Spiral continues to restore the normal classroom roster through
the existing classroom load flow.

The strict `resolveRevisitAgentIds()` contract remains unchanged: production rosters still reject
raw `default-*` IDs and still require exactly one assistant plus two or three students. The
synthetic compatibility roster satisfies that same contract.

## Error Handling

If one of the required built-in agent definitions is unexpectedly unavailable or no longer has
the expected role, compatibility resolution returns no roster and preserves the existing
historical-roster error. It must not create partial or anonymous agents.

## Tests

Add focused tests proving that:

- a completed attempt with no persisted roster receives the historical four-agent compatibility
  roster;
- compatibility IDs are stable, synthetic, and accepted by strict runtime ID resolution;
- names, roles, personas, avatars, colors, priorities, actions, and voice metadata are copied;
- unfinished attempts with no roster still return no roster;
- an explicit Spiral snapshot and a valid legacy generated roster take precedence;
- hydration does not overwrite built-in default agents or write generated-agent database records.

Run the focused revisit tests, then the full Vitest suite, lint, and production build.
