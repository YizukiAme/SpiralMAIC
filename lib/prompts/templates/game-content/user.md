Create an educational GAME widget for: {{title}}

## Game Type

{{gameType}}

## Description

{{description}}

## Key Points

{{keyPoints}}

## Scoring Configuration

{{scoring}}

## Language

{{languageDirective}}

---

Generate a FUN, INTERACTIVE HTML game with these MANDATORY features:

### Game Design (CRITICAL - NOT A QUIZ!)
1. **Interactive gameplay**: Player MUST control something meaningful (NOT just click answers)
2. **Real game mechanics**: Timing, aiming, dragging, balancing, catching, or building
3. **Skill-based success**: Outcome depends on player action, not just correct answer
4. **Engaging feedback**: Animations, sounds, visual effects for actions

### Preferred Game Types (in order of preference)
1. **Physics/Action**: Control parameters to achieve a goal (land safely, hit target, balance)
2. **Timing/Aim**: Click at right moment or adjust aim to succeed
3. **Drag-and-drop**: Sort, arrange, or build by dragging elements
4. **Simulation game**: Let player experiment with variables to find solution
5. **Card/Match**: Memory or matching games
6. **Quiz**: ONLY as last resort - make it visually interesting

### Simulation Integration (if game has visual simulation)
- Simulation MUST be interactive (player controls something)
- Simulation physics MUST match what player is learning
- Visual feedback MUST show player's progress toward goal
- Example: Don't ask "What thrust?" → LET PLAYER ADJUST thrust and see result!

### Game Elements
1. **Clear objective**: "Land safely", "Hit the target", "Sort correctly"
2. **Player controls**: Sliders, buttons, drag areas, or click targets
3. **Real-time feedback**: Score, progress bar, visual indicators
4. **Levels or challenges**: Progressive difficulty
5. **Achievement system**: Unlockable badges for accomplishments
6. **Replay value**: Random elements or multiple solutions

### Playable Payload (CRITICAL - NO EMPTY BOARD)
1. The game must not stop at an intro screen.
2. After clicking Start, the board must populate visible playable objects.
3. If the outline provides objects, cases, cards, steps, risk states, tool/task pairs, or decision cards, use them.
4. If the outline is underspecified, derive at least 5 concrete playable objects from the title, description, and key points.
5. Never leave target slots, boards, lanes, maps, or decision areas empty.
6. Every visible object must have an interaction rule and feedback.
7. Usually use 5-8 concrete objects/cases/cards; never fewer than 4 playable objects unless the game has a different clearly visible interaction structure.

### Visual Design
1. Attractive theme matching the subject
2. Clear UI for controls and feedback
3. Animations for success/failure
4. Responsive layout (mobile + desktop)

### Technical (MANDATORY)
1. **Inline onclick for start button**: `<button onclick="startGame()">开始</button>` - NOT addEventListener
2. **Custom CSS preferred**: Avoid Tailwind `@layer utilities` blocks; use plain CSS
3. **DOMContentLoaded wrapper**: Wrap game code in `document.addEventListener('DOMContentLoaded', ...)`
4. **Global start function**: `function startGame()` must be callable from onclick
5. Embedded `<script type="application/json" id="widget-config">`
6. `requestAnimationFrame` for smooth animations
7. Touch-friendly controls (min 44px touch targets)
8. localStorage for progress/high scores
9. Pause functionality

### Output
Return ONLY the HTML document. Make the game FUN enough that students want to play again!
