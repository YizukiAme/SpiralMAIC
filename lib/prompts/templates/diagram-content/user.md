Create an interactive diagram for: {{title}}

## Diagram Type
{{diagramType}}

## Description
{{description}}

## Key Points
{{keyPoints}}

## Language
{{languageDirective}}

---

Generate a complete HTML diagram with:

1. **SVG DOM nodes** with icons, labels, and click-to-show details.
2. **Stable node IDs**: node `n1` must render as a real SVG/DOM element queryable by `#n1`; `n2` by `#n2`; `n3` by `#n3`.
3. **Stable edge IDs**: edge `n1 -> n2` must render as `#edge-n1-n2`; edge `n2 -> n3` as `#edge-n2-n3`.
4. **Edges with arrows** connecting nodes, with endpoints calculated from node dimensions.
5. **Step-by-step reveal** (下一步/上一步) and **expand all / 全部展开**.
6. **First node visible** on load.
7. **Expand all visible**: expand all must make every node and every edge visibly appear, not only update a JavaScript variable.
8. **SVG viewBox coverage**: the SVG `viewBox` must include all node coordinates, node dimensions, and edge labels; do not place nodes outside the visible viewport.
9. **No legend-only output**: the main graph canvas must not be blank when the legend is visible.
10. **Teacher action compatibility**: `#n1`, `#n2`, `#edge-n1-n2`, and similar targets must be querySelector-addressable when present in the config.
11. **High contrast**: White nodes on dark background, light edge labels.
12. **Mobile-friendly**: Collapsible sidebar, does not block the diagram.
13. **Valid JSON widget config**: embed config in `<script type="application/json" id="widget-config">` and ensure it is valid, JSON.parse-able JSON.
14. **JSON safety**: avoid unescaped quotes, malformed JSON, raw HTML fragments, and unescaped HTML attributes inside JSON string values.

Before final output, self-check that `JSON.parse(document.getElementById('widget-config').textContent)` succeeds and that expected node/edge selectors such as `#n1` and `#edge-n1-n2` exist in the SVG DOM.
