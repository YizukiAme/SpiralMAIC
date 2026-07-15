'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Search, X } from 'lucide-react';
import { Handle, Position, type Edge, type Node, type NodeProps } from '@xyflow/react';

import { Canvas } from '@/components/ai-elements/canvas';
import { Controls } from '@/components/ai-elements/controls';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  buildMindMapGraph,
  collectMindMapBranchNodeIds,
  resolveMindMapNodeMemory,
  type MindMapNodeMemoryState,
  type MindMapGraphNode,
} from '@/lib/revisit/mind-map';
import { getConceptStates } from '@/lib/revisit/db';
import { computeConceptRecall, revisitColorForRecall } from '@/lib/revisit/memory';
import type { MindMapStudyArtifact, UserConceptState } from '@/lib/revisit/types';
import type { Scene } from '@/lib/types/stage';
import { cn } from '@/lib/utils';
import { FORMAL_REVISIT_SCOPE, type RevisitDataScope } from '@/lib/revisit/scope';
import { getRevisitNow } from '@/lib/revisit/clock';
import { SourceSceneReferences } from '@/components/revisit/artifact-viewer/source-scene-references';

const COLLAPSE_EXIT_MS = 160;
const EXPAND_ENTER_MS = 180;

type MindMapNodeAnimationState = 'idle' | 'entering' | 'exiting';

type MindMapNodeData = Record<string, unknown> &
  MindMapGraphNode & {
    memoryRecall: number | null;
    memoryState: MindMapNodeMemoryState;
    memoryColor: string;
    animationState: MindMapNodeAnimationState;
    onToggle: (nodeId: string) => void;
  };

type MindMapFlowNode = Node<MindMapNodeData, 'mindMap'>;

const nodeTypes = { mindMap: MindMapNode };

export function MindMapViewer({
  artifact,
  dataScope,
  sourceScenes,
}: {
  artifact: MindMapStudyArtifact;
  dataScope?: RevisitDataScope;
  sourceScenes: Scene[];
}) {
  const scope = dataScope ?? FORMAL_REVISIT_SCOPE;
  const { t } = useI18n();
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<Set<string>>(new Set());
  const [enteringNodeIds, setEnteringNodeIds] = useState<Set<string>>(new Set());
  const [exitingNodeIds, setExitingNodeIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [conceptStates, setConceptStates] = useState<UserConceptState[]>([]);
  const [memoryNow, setMemoryNow] = useState(() => Date.now());
  const prefersReducedMotion = usePrefersReducedMotion();
  const committedCollapsedNodeIdsRef = useRef(collapsedNodeIds);
  const targetCollapsedNodeIdsRef = useRef(collapsedNodeIds);
  const transitionTimerRef = useRef<number | null>(null);
  const transitionFrameRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getConceptStates(artifact.stageId, scope), getRevisitNow(scope)]).then(
      ([states, now]) => {
        if (!cancelled) {
          setConceptStates(states);
          setMemoryNow(now);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [artifact.stageId, scope]);

  const conceptStateById = useMemo(
    () => new Map(conceptStates.map((state) => [state.conceptId, state])),
    [conceptStates],
  );
  const cancelPendingTransition = useCallback(() => {
    if (transitionTimerRef.current != null) window.clearTimeout(transitionTimerRef.current);
    if (transitionFrameRef.current != null) window.cancelAnimationFrame(transitionFrameRef.current);
    transitionTimerRef.current = null;
    transitionFrameRef.current = null;
  }, []);

  const beginEnteringAnimation = useCallback((nodeIds: string[]) => {
    if (nodeIds.length === 0) {
      setEnteringNodeIds(new Set());
      return;
    }
    setEnteringNodeIds(new Set(nodeIds));
    transitionFrameRef.current = window.requestAnimationFrame(() => {
      transitionFrameRef.current = window.requestAnimationFrame(() => {
        transitionFrameRef.current = null;
        setEnteringNodeIds(new Set());
      });
    });
  }, []);

  const animateToCollapsedNodeIds = useCallback(
    (nextCollapsedNodeIds: Set<string>) => {
      cancelPendingTransition();
      const next = new Set(nextCollapsedNodeIds);
      targetCollapsedNodeIdsRef.current = next;
      const currentGraph = buildMindMapGraph(artifact.content.root, {
        collapsedNodeIds: committedCollapsedNodeIdsRef.current,
      });
      const nextGraph = buildMindMapGraph(artifact.content.root, {
        collapsedNodeIds: next,
      });
      const currentVisibleIds = new Set(currentGraph.nodes.map((node) => node.id));
      const nextVisibleIds = new Set(nextGraph.nodes.map((node) => node.id));
      const disappearingIds = [...currentVisibleIds].filter((id) => !nextVisibleIds.has(id));
      const appearingIds = [...nextVisibleIds].filter((id) => !currentVisibleIds.has(id));

      if (prefersReducedMotion) {
        committedCollapsedNodeIdsRef.current = next;
        setCollapsedNodeIds(next);
        setEnteringNodeIds(new Set());
        setExitingNodeIds(new Set());
        return;
      }

      if (disappearingIds.length > 0) {
        setEnteringNodeIds(new Set());
        setExitingNodeIds(new Set(disappearingIds));
        transitionTimerRef.current = window.setTimeout(() => {
          transitionTimerRef.current = null;
          committedCollapsedNodeIdsRef.current = next;
          setCollapsedNodeIds(next);
          setExitingNodeIds(new Set());
          beginEnteringAnimation(appearingIds);
        }, COLLAPSE_EXIT_MS);
        return;
      }

      committedCollapsedNodeIdsRef.current = next;
      setCollapsedNodeIds(next);
      setExitingNodeIds(new Set());
      beginEnteringAnimation(appearingIds);
    },
    [artifact.content.root, beginEnteringAnimation, cancelPendingTransition, prefersReducedMotion],
  );

  const toggleNode = useCallback(
    (nodeId: string) => {
      const next = new Set(targetCollapsedNodeIdsRef.current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      animateToCollapsedNodeIds(next);
    },
    [animateToCollapsedNodeIds],
  );

  useEffect(() => cancelPendingTransition, [cancelPendingTransition]);
  const graph = useMemo(
    () => buildMindMapGraph(artifact.content.root, { collapsedNodeIds, query }),
    [artifact.content.root, collapsedNodeIds, query],
  );
  const exportGraph = useMemo(
    () => buildMindMapGraph(artifact.content.root),
    [artifact.content.root],
  );
  const nodes = useMemo<MindMapFlowNode[]>(
    () =>
      graph.nodes.map((node) => {
        const memoryState = resolveMindMapNodeMemory(node.conceptIds, conceptStates, memoryNow);
        const memoryRecall = memoryState.status === 'available' ? memoryState.recall : null;
        return {
          id: node.id,
          type: 'mindMap',
          position: node.position,
          data: {
            ...node,
            memoryRecall,
            memoryState,
            memoryColor: revisitColorForRecall(memoryRecall),
            animationState: exitingNodeIds.has(node.id)
              ? 'exiting'
              : enteringNodeIds.has(node.id)
                ? 'entering'
                : 'idle',
            onToggle: toggleNode,
          },
          selected: selectedNodeId === node.id,
        };
      }),
    [
      conceptStates,
      enteringNodeIds,
      exitingNodeIds,
      graph.nodes,
      memoryNow,
      selectedNodeId,
      toggleNode,
    ],
  );
  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => ({
        ...edge,
        type: 'smoothstep',
        style: {
          stroke: 'var(--border)',
          strokeWidth: 2,
          opacity: enteringNodeIds.has(edge.target) || exitingNodeIds.has(edge.target) ? 0 : 1,
          transition: `opacity ${exitingNodeIds.has(edge.target) ? COLLAPSE_EXIT_MS : EXPAND_ENTER_MS}ms ease`,
        },
      })),
    [enteringNodeIds, exitingNodeIds, graph.edges],
  );
  const selected = nodes.find((node) => node.id === selectedNodeId)?.data;
  const branchIds = useMemo(
    () => collectMindMapBranchNodeIds(artifact.content.root),
    [artifact.content.root],
  );

  return (
    <div className="relative flex h-full min-h-[560px] overflow-hidden print:h-auto print:min-h-0">
      <div className="artifact-mind-map-canvas relative min-w-0 flex-1 bg-slate-50/80 [--sidebar:#f8fafc] dark:bg-slate-950/60 dark:[--sidebar:#0f172a]">
        <div className="absolute inset-x-3 top-3 z-10 flex flex-wrap items-center gap-2 print:hidden">
          <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              className="border-border/70 bg-white/90 ps-9 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-slate-900/90"
              placeholder={t('revisit.viewer.searchMindMap')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="border-border/70 bg-white/90 backdrop-blur-md dark:border-white/10 dark:bg-slate-900/90"
            onClick={() => animateToCollapsedNodeIds(new Set())}
          >
            <ChevronsUpDown />
            {t('revisit.viewer.expandAll')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-border/70 bg-white/90 backdrop-blur-md dark:border-white/10 dark:bg-slate-900/90"
            onClick={() => animateToCollapsedNodeIds(new Set(branchIds))}
          >
            <ChevronsDownUp />
            {t('revisit.viewer.collapseAll')}
          </Button>
        </div>

        <Canvas
          nodes={nodes as Node[]}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          panOnDrag
          panOnScroll={false}
          fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
          minZoom={0.2}
          maxZoom={1.8}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
        >
          <Controls
            showInteractive={false}
            className="border-border/70 bg-white/90 backdrop-blur-md dark:border-white/10 dark:bg-slate-900/90"
          />
        </Canvas>
      </div>

      {selected ? (
        <aside className="absolute inset-y-0 right-0 z-20 w-[min(88vw,340px)] overflow-y-auto border-l border-border/70 bg-white/90 p-5 shadow-lg backdrop-blur-xl sm:relative sm:shadow-none dark:border-white/10 dark:bg-slate-900/90 print:hidden">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase text-emerald-700 dark:text-emerald-300">
                {t('revisit.viewer.nodeDetails')}
              </p>
              <h2 className="mt-2 text-xl font-semibold">{selected.label}</h2>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('common.close')}
              onClick={() => setSelectedNodeId(null)}
            >
              <X />
            </Button>
          </div>
          <div className="mt-5 flex items-center gap-2">
            <span
              className="size-2.5 rounded-full"
              style={{ backgroundColor: selected.memoryColor }}
            />
            <span className="text-sm text-muted-foreground">
              {selected.memoryState.status === 'available'
                ? t('revisit.viewer.memoryPercent', {
                    percent: Math.round(selected.memoryState.recall * 100),
                  })
                : selected.memoryState.status === 'noCourseEvidence'
                  ? t('revisit.viewer.noCourseMemoryEvidence')
                  : t('revisit.viewer.nodeMemoryUnlinked')}
            </span>
          </div>
          {selected.note ? <p className="mt-5 text-sm leading-6">{selected.note}</p> : null}
          {selected.examples?.length ? (
            <section className="mt-6 border-t pt-4">
              <h3 className="text-sm font-semibold">{t('revisit.viewer.examples')}</h3>
              <ul className="mt-2 list-disc space-y-2 ps-5 text-sm text-muted-foreground">
                {selected.examples.map((example, index) => (
                  <li key={index}>{example}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {selected.sourceSceneIds?.length ? (
            <section className="mt-6 border-t pt-4">
              <h3 className="text-sm font-semibold">{t('revisit.viewer.sources')}</h3>
              <SourceSceneReferences
                sourceSceneIds={selected.sourceSceneIds}
                sourceScenes={sourceScenes}
                className="mt-2"
              />
            </section>
          ) : null}
        </aside>
      ) : null}

      <MindMapExportSurface
        title={artifact.title}
        graph={exportGraph}
        conceptStateById={conceptStateById}
        memoryNow={memoryNow}
      />
    </div>
  );
}

function MindMapNode({ data, selected }: NodeProps<MindMapFlowNode>) {
  const { t } = useI18n();
  return (
    <div
      className={cn(
        'relative w-[220px] rounded-lg border border-border/70 bg-white/90 px-4 py-3 text-start shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-slate-900/90',
        data.animationState !== 'idle' && 'scale-[0.96] opacity-0',
        data.matched && 'ring-2 ring-amber-400',
        selected && 'border-primary ring-2 ring-primary/20',
      )}
      data-animation-state={data.animationState}
      style={{
        borderInlineStartColor: data.memoryColor,
        borderInlineStartWidth: 5,
        transition: `opacity ${data.animationState === 'exiting' ? COLLAPSE_EXIT_MS : EXPAND_ENTER_MS}ms ease, transform ${data.animationState === 'exiting' ? COLLAPSE_EXIT_MS : EXPAND_ENTER_MS}ms ease`,
      }}
    >
      <Handle type="target" position={Position.Left} className="pointer-events-none opacity-0" />
      <p className="line-clamp-2 text-sm font-semibold leading-5">{data.label}</p>
      {data.note ? (
        <p className="mt-1 line-clamp-2 text-xs leading-4 text-muted-foreground">{data.note}</p>
      ) : null}
      {data.memoryRecall != null ? (
        <p className="mt-2 text-[10px] tabular-nums text-muted-foreground">
          {Math.round(data.memoryRecall * 100)}%
        </p>
      ) : null}
      {data.hasChildren ? (
        <button
          type="button"
          className="nodrag absolute top-1/2 -right-3 z-10 grid size-6 -translate-y-1/2 place-items-center rounded-full border border-border/70 bg-white/95 shadow-sm dark:border-white/10 dark:bg-slate-900/95"
          aria-label={
            data.collapsed ? t('revisit.viewer.expandNode') : t('revisit.viewer.collapseNode')
          }
          onClick={(event) => {
            event.stopPropagation();
            data.onToggle(data.id);
          }}
        >
          {data.collapsed ? (
            <ChevronRight className="size-3" />
          ) : (
            <ChevronDown className="size-3" />
          )}
        </button>
      ) : null}
      <Handle type="source" position={Position.Right} className="pointer-events-none opacity-0" />
    </div>
  );
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setPrefersReducedMotion(mediaQuery.matches);
    update();
    mediaQuery.addEventListener('change', update);
    return () => mediaQuery.removeEventListener('change', update);
  }, []);

  return prefersReducedMotion;
}

function MindMapExportSurface({
  title,
  graph,
  conceptStateById,
  memoryNow,
}: {
  title: string;
  graph: ReturnType<typeof buildMindMapGraph>;
  conceptStateById: Map<string, UserConceptState>;
  memoryNow: number;
}) {
  const padding = 48;
  const headerHeight = 92;
  const width = Math.max(...graph.nodes.map((node) => node.position.x + 220), 640) + padding * 2;
  const height =
    Math.max(...graph.nodes.map((node) => node.position.y + 92), 360) + padding * 2 + headerHeight;
  const printScale = Math.min(1, 1000 / width, 680 / height);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

  return (
    <div
      id="artifact-visual-export"
      data-artifact-kind="mindMap"
      className="mind-map-export-surface fixed -left-[20000px] top-0 overflow-hidden bg-white text-neutral-950 print:static print:block"
      style={
        {
          width,
          height,
          '--mind-map-print-scale': String(printScale),
        } as CSSProperties
      }
    >
      <header className="absolute inset-x-0 top-0 flex h-[92px] items-center border-b border-neutral-200 px-12">
        <div>
          <p className="text-xs font-semibold uppercase text-emerald-700">Spiral Study Studio</p>
          <h1 className="mt-1 text-2xl font-bold">{title}</h1>
        </div>
      </header>
      <svg className="absolute inset-0 size-full" aria-hidden="true">
        {graph.edges.map((edge) => {
          const source = nodeById.get(edge.source);
          const target = nodeById.get(edge.target);
          if (!source || !target) return null;
          const startX = source.position.x + padding + 220;
          const startY = source.position.y + padding + headerHeight + 46;
          const endX = target.position.x + padding;
          const endY = target.position.y + padding + headerHeight + 46;
          const midX = (startX + endX) / 2;
          return (
            <path
              key={edge.id}
              d={`M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`}
              fill="none"
              stroke="#cbd5e1"
              strokeWidth="2"
            />
          );
        })}
      </svg>
      {graph.nodes.map((node) => {
        const recalls = (node.conceptIds ?? [])
          .map((id) => conceptStateById.get(id))
          .filter((state): state is UserConceptState => Boolean(state))
          .map((state) => computeConceptRecall(state, memoryNow));
        const recall =
          recalls.length > 0
            ? recalls.reduce((sum, value) => sum + value, 0) / recalls.length
            : null;
        return (
          <div
            key={node.id}
            className="absolute h-[92px] w-[220px] overflow-hidden rounded-lg border border-neutral-200 bg-white px-4 py-3 shadow-sm"
            style={{
              left: node.position.x + padding,
              top: node.position.y + padding + headerHeight,
              borderInlineStartColor: revisitColorForRecall(recall),
              borderInlineStartWidth: 5,
            }}
          >
            <p className="line-clamp-2 text-sm font-semibold leading-5">{node.label}</p>
            {node.note ? (
              <p className="mt-1 line-clamp-2 text-xs leading-4 text-neutral-500">{node.note}</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
