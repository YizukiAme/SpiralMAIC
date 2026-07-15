import { computeConceptRecall } from '@/lib/revisit/memory';
import type { StudyArtifactMindMapNode, UserConceptState } from '@/lib/revisit/types';
import { graphlib } from 'dagre-d3-es';
import { layout } from 'dagre-d3-es/src/dagre/index.js';

export interface MindMapGraphNode {
  id: string;
  label: string;
  note?: string;
  examples?: string[];
  conceptIds?: string[];
  sourceSceneIds?: string[];
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  matched: boolean;
  position: { x: number; y: number };
}

export interface MindMapGraphEdge {
  id: string;
  source: string;
  target: string;
}

export type MindMapNodeMemoryState =
  | { status: 'available'; recall: number }
  | { status: 'noCourseEvidence' }
  | { status: 'unlinkedNode' };

export function resolveMindMapNodeMemory(
  conceptIds: string[] | undefined,
  conceptStates: UserConceptState[],
  now: number,
): MindMapNodeMemoryState {
  if (conceptStates.length === 0) return { status: 'noCourseEvidence' };

  const conceptStateById = new Map(conceptStates.map((state) => [state.conceptId, state]));
  const recalls = (conceptIds ?? [])
    .map((id) => conceptStateById.get(id))
    .filter((state): state is UserConceptState => Boolean(state))
    .map((state) => computeConceptRecall(state, now));

  if (recalls.length === 0) return { status: 'unlinkedNode' };
  return {
    status: 'available',
    recall: recalls.reduce((sum, recall) => sum + recall, 0) / recalls.length,
  };
}

export function buildMindMapGraph(
  root: StudyArtifactMindMapNode,
  options: {
    collapsedNodeIds?: Set<string>;
    query?: string;
  } = {},
): { nodes: MindMapGraphNode[]; edges: MindMapGraphEdge[] } {
  const collapsedNodeIds = options.collapsedNodeIds ?? new Set<string>();
  const query = options.query?.trim().toLocaleLowerCase() ?? '';
  const nodes: MindMapGraphNode[] = [];
  const edges: MindMapGraphEdge[] = [];
  const visit = (node: StudyArtifactMindMapNode, depth: number) => {
    const haystack = [node.label, node.note ?? '', ...(node.examples ?? [])]
      .join(' ')
      .toLocaleLowerCase();
    nodes.push({
      id: node.id,
      label: node.label,
      note: node.note,
      examples: node.examples,
      conceptIds: node.conceptIds,
      sourceSceneIds: node.sourceSceneIds,
      depth,
      hasChildren: node.children.length > 0,
      collapsed: collapsedNodeIds.has(node.id),
      matched: Boolean(query && haystack.includes(query)),
      position: { x: 0, y: 0 },
    });
    if (collapsedNodeIds.has(node.id)) return;
    for (const child of node.children) {
      edges.push({ id: `${node.id}:${child.id}`, source: node.id, target: child.id });
      visit(child, depth + 1);
    }
  };
  visit(root, 0);

  const layoutGraph = new graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  layoutGraph.setGraph({ rankdir: 'LR', ranksep: 88, nodesep: 36, marginx: 12, marginy: 12 });
  for (const node of nodes) layoutGraph.setNode(node.id, { width: 220, height: 92 });
  for (const edge of edges) layoutGraph.setEdge(edge.source, edge.target);
  layout(layoutGraph, {});
  for (const node of nodes) {
    const positioned = layoutGraph.node(node.id) as { x?: number; y?: number } | undefined;
    node.position = {
      x: (positioned?.x ?? 110) - 110,
      y: (positioned?.y ?? 46) - 46,
    };
  }
  return { nodes, edges };
}

export function collectMindMapBranchNodeIds(root: StudyArtifactMindMapNode): string[] {
  const ids: string[] = [];
  const visit = (node: StudyArtifactMindMapNode) => {
    if (node.children.length > 0) ids.push(node.id);
    node.children.forEach(visit);
  };
  visit(root);
  return ids;
}

export function collectMindMapDescendantNodeIds(
  root: StudyArtifactMindMapNode,
  nodeId: string,
): string[] {
  const find = (node: StudyArtifactMindMapNode): StudyArtifactMindMapNode | null => {
    if (node.id === nodeId) return node;
    for (const child of node.children) {
      const match = find(child);
      if (match) return match;
    }
    return null;
  };
  const branch = find(root);
  if (!branch) return [];

  const descendants: string[] = [];
  const collect = (node: StudyArtifactMindMapNode) => {
    for (const child of node.children) {
      descendants.push(child.id);
      collect(child);
    }
  };
  collect(branch);
  return descendants;
}
