# Interactive Diagram Generator

Generate a self-contained HTML diagram with connected nodes.

## Data Schema

```json
{
  "nodes": [
    { "id": "n1", "label": "Label", "icon": "target", "details": "Description" }
  ],
  "edges": [
    { "from": "n1", "to": "n2", "label": "next" }
  ],
  "revealOrder": ["n1", "n2"]
}
```

## Core Requirements

1. **SVG DOM-based** with embedded valid JSON config. Do not use canvas-only rendering for diagrams that need teacher action targets.
2. **First node visible** on load.
3. **High contrast**: White nodes on dark background, light edge labels.
4. **Edges connect to node edges** (account for node dimensions and arrow offset).
5. **Mobile**: Sidebar/panel collapsible, does not block diagram.
6. **No jitter**: Avoid hover transform conflicts on click.
7. **All nodes connected**: No orphan nodes.
8. **Main canvas visible**: Never render only a legend while the main diagram canvas is blank.

## Stable SVG DOM Target Contract

Teacher actions target the diagram iframe with CSS selectors. The generated HTML must expose stable, querySelector-addressable SVG DOM targets:

- Every node must render as a real SVG/group DOM element with an id matching the node data id.
  - Node `n1` must produce an element queryable by `#n1` (for example `<g id="n1">`).
  - Node `n2` must produce `#n2`; node `n3` must produce `#n3`.
- Every edge must render as a real SVG/path/group DOM element with a stable id derived from endpoints.
  - Edge `n1 -> n2` must produce an element queryable by `#edge-n1-n2`.
  - Edge `n2 -> n3` must produce `#edge-n2-n3`.
- If `widget-config.nodes` contains node id `n1`, the HTML must contain `document.querySelector('#n1')`.
- If `widget-config.edges` contains `{ "from": "n1", "to": "n2" }`, the HTML must contain `document.querySelector('#edge-n1-n2')`.
- Highlight, annotation, reveal, next, previous, and expand-all behavior must operate on these real DOM elements, not only internal state variables.
- Do not generate teacher action targets or reveal targets that are absent from the SVG DOM.
- All DOM access must be null-safe: if a selector is missing, skip gracefully rather than throwing.

## Visibility and Layout Contract

A valid diagram must show its actual graph, not only labels or a legend.

- At least the first node must be visible initially.
- When the learner clicks “expand all” / “reveal all” / “全部展开”, all nodes and all edges must become visible.
- “Visible” means:
  - not `display: none`;
  - not `visibility: hidden`;
  - `opacity > 0`;
  - non-zero bounding box;
  - located inside the SVG `viewBox` and visible viewport.
- The SVG must have explicit width/height or responsive sizing and a `viewBox` that covers every node coordinate plus node dimensions and edge labels.
- Nodes and edges must not be placed outside the visible viewport.
- Reveal-all must update real DOM visibility classes/styles/attributes; do not implement reveal-all as a state-only variable.
- If the legend is visible, the main graph canvas must also contain visible node and edge elements.

## Valid JSON and Widget Config Contract

The `<script type="application/json" id="widget-config">` block is parsed by the platform and must be strictly valid JSON.

- The widget-config must be `JSON.parse`-able without errors.
- Do not place unescaped double quotes inside JSON string values.
- Do not insert raw HTML strings with unescaped attributes into widget-config JSON.
- Avoid embedding long HTML fragments inside JSON string fields.
- Keep widget-config values as plain text data; render formatting in DOM/CSS outside JSON.
- Ensure every quote inside JSON string values is escaped.
- The generated HTML must not throw `SyntaxError` from malformed JSON or malformed script content.
- If inline data is needed for nodes/edges, prefer valid JSON in the widget-config. If you use a JS object literal outside the JSON script, it must be syntactically valid and must not replace the valid widget-config.
- Before final output, self-check that this works:

```javascript
JSON.parse(document.getElementById('widget-config').textContent);
document.querySelector('#n1');
document.querySelector('#edge-n1-n2');
```

## Edge Connection Code

```javascript
const NODE_WIDTH = 180, NODE_HEIGHT = 70, ARROW_OFFSET = 10;

function getEdgePoints(from, to) {
    const dx = to.x - from.x, dy = to.y - from.y;
    let sx, sy, ex, ey;

    if (Math.abs(dy) > Math.abs(dx)) { // Vertical
        sx = from.x;
        sy = dy > 0 ? from.y + NODE_HEIGHT/2 : from.y - NODE_HEIGHT/2;
        ex = to.x;
        ey = dy > 0 ? to.y - NODE_HEIGHT/2 - ARROW_OFFSET : to.y + NODE_HEIGHT/2 + ARROW_OFFSET;
    } else { // Horizontal
        sx = dx > 0 ? from.x + NODE_WIDTH/2 : from.x - NODE_WIDTH/2;
        sy = from.y;
        ex = dx > 0 ? to.x - NODE_WIDTH/2 - ARROW_OFFSET : to.x + NODE_WIDTH/2 + ARROW_OFFSET;
        ey = to.y;
    }
    return `M ${sx} ${sy} L ${ex} ${ey}`;
}
```

## Common Failure Modes

Avoid these failures:

- Do not render only a legend while the main diagram is blank.
- Do not omit DOM ids for nodes.
- Do not omit DOM ids for edges.
- Do not place nodes outside the SVG viewBox.
- Do not leave all nodes hidden at initial render.
- Do not implement reveal-all as state-only without updating DOM.
- Do not generate teacher action targets that cannot be querySelector() matched.
- Do not use canvas-only rendering for diagrams that need teacher action targets.
- Do not output malformed widget-config JSON.
- Do not include unescaped quotes in JSON string values.
- Do not embed raw HTML attributes inside JSON strings unless properly escaped.
- Do not let iframe execution fail with SyntaxError before nodes/edges are rendered.

## Output

Return exactly ONE complete HTML document. No markdown fences, no duplication, no explanation text.
