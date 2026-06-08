Create a Task Engine outline from this vocational task request.

## User Task

{{requirement}}

---

{{userProfile}}

## Reference Materials

### PDF Content Summary

{{pdfContent}}

### Available Images

{{availableImages}}

### Retrieved and External Reference Context

{{researchContext}}

{{teacherContext}}

---

## Requirements

- First apply the suitability gate: decide whether the user task is a vocational procedural task before choosing procedural-skill.
- Suitable vocational procedural tasks involve a real or simulated work task, operation flow, tools/equipment/materials/state, safety or quality boundaries, GO/STOP or safe/unsafe decisions, and realistic consequences.
- Suitable examples include NEV battery-pack replacement pre-work safety confirmation, low-voltage distribution cabinet pre-energization confirmation, IV infusion identity and drip-rate setup, and welding pre-work equipment inspection.
- Not suitable examples include explaining the Pythagorean theorem, introducing Newton's second law, analyzing a poem, or explaining basic machine learning concepts.
- If the user task is not suitable for vocational procedural practice, generate a normal MAIC-style outline using slide plus ordinary interactive widgets: simulation, diagram, code, game, and visualization3d. Match the scene count and structure to the topic instead of forcing the 10-14 vocational mixed-scene ratio.
- If the user task is not suitable, do not output procedural-skill.
- If suitable, generate a mixed vocational training sequence for the same task workflow.
- If suitable, generate 10-14 scenes.
- If suitable, generate at least 10 scenes and no more than 14 scenes.
- If suitable, prefer 10-12 scenes by default.
- If suitable, start directly with the task scene; do not create a concept-introduction slide first.
- If suitable, the first scene must be a `slide`.
- If suitable, the first scene must be a course briefing / task overview.
- The first briefing slide must explain the task purpose, why the task matters, what will be trained, safety boundary / risk reminder, and final completion criteria / GO-STOP standard.
- The first scene must not include `widgetType` or `widgetOutline`.
- The first scene must not be a checklist, game, diagram, dashboard, operation panel, generic subject introduction, or pure theory lecture.
- Keep the first scene as a stable PPT-style slide with high-level briefing content only; do not expand detailed operation steps.
- First slide layout:
  - top: title plus one-sentence task goal;
  - middle: exactly 3 stable information cards: Task Purpose, Key Risk, Task Boundary;
  - lower-middle: 4-6 macro training stages only;
  - bottom: one compact GO/STOP completion standard;
  - safety red line as an independent card or compact warning block, not a floating callout.
- First slide density limits: cards use 2-3 lines each, training stages use 4-6 short macro phrases, GO and STOP each use one short standard.
- First slide must avoid long arrow flowcharts, floating callouts, dense two-row process maps, overlapping GO/STOP bars, bottom-heavy dashboards, absolute-positioned safety red line blocks, small text packed into corners, scrolling content, and any layout likely to overflow the 16:9 slide frame.
- Use a mixed structure:
  - 5-7 checklist / operation-confirmation scenes using `type: "interactive"` and `widgetType: "procedural-skill"`.
  - 2-4 explanation scenes, including the first briefing slide, using `type: "slide"` or at most 1 `widgetType: "diagram"`.
  - 2-4 challenge scenes using `type: "interactive"` and `widgetType: "game"`.
- Do not make every scene a procedural-skill checklist.
- Procedural-skill is a training mechanism, not a fixed visual style. Do not make all procedural-skill scenes the same dark checklist or dashboard.
- For each procedural-skill scene, imply a fitting training format / visual framing through existing `title`, `description`, `keyPoints`, and `widgetOutline` wording. Do not add new schema fields.
- Useful visual framing phrases include light step-card board, work-order desk, safety check station, process kanban, measurement station, control-console style, GO/STOP decision station, handoff checklist board, and troubleshooting station.
- Do not make every scene a game.
- Use slide for risk principles, standards, safety thresholds, and key judgment basis.
- Use game for GO/STOP decisions, troubleshooting, step ordering, risk identification, and abnormal-condition handling.
- Use at most 1 diagram for structure, process path, or risk propagation; if unsure, use slide.
- Procedural-skill scenes must include `procedureType`, `task`, `tools`, `steps`, `successCriteria`, and `errorConsequences`.
- Game scenes should include `gameType`, `challenge`, and `playerControls`.
- Every game scene must include a playable payload in `description` and `keyPoints`: concrete playable objects, rules for interaction, correct outcome or target state, wrong-choice feedback, success condition, and failure consequence.
- Do not write only vague game labels such as GO/STOP challenge, step ordering challenge, risk identification game, students decide whether to continue, or drag items into order. Name concrete step cards, inspection cases, risk states, tool/task pairs, fault symptoms, or decision cards.
- Usually include 5-8 concrete objects/cases/cards. Never fewer than 4 playable objects unless the game has a different clearly visible interaction structure.
- Recommended stable patterns / fallback patterns, not the only allowed patterns: sequence-ordering, GO/STOP decision, risk-classification, and tool-matching. Other equivalent gameplay is allowed if the playable payload is concrete.
- Split the overall task into specific trainable operation segments instead of putting the whole procedure into one scene.
- If you include a final scene, make it practical review, error handling, GO/STOP judgment, completion checking, or handoff confirmation, not an ordinary summary slide.
- Include at least one judgment, measurement, tool-use choice, safe/unsafe decision, go/stop decision, or recheck decision in the steps.
- Include realistic error consequences, not just "wrong answer".
- Keep the outline focused enough for a first generated scene to become an operable practice widget.

For the default NEV-A12 task, a good mixed 12-scene structure is:

1. Briefing slide: task goal, high-voltage risk boundary, training steps, completion criteria, and GO/STOP standard
2. Procedural skill: work-order confirmation and risk identification
3. Procedural skill: PPE and insulated tool inspection
4. Diagram or slide: high-voltage system risk path
5. Procedural skill: high-voltage power-down confirmation
6. Procedural skill: service disconnect / MSD operation
7. Slide: residual-voltage threshold and safety judgment basis
8. Procedural skill: residual-voltage measurement
9. Game: step-ordering challenge
10. Procedural skill: LOTO isolation and tagging
11. Game: GO / STOP safety decision
12. Procedural skill or slide: abnormal handling, completion check, and handoff

This NEV-A12 structure is an example only. For other vocational tasks, create an equivalent mixed training flow.

Return ONLY the JSON object with `languageDirective` and `outlines`. Do not use markdown fences or explanatory text.
