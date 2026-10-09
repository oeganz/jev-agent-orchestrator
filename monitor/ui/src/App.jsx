import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls, Handle, Position,
  ReactFlowProvider, useReactFlow, useStoreApi, useStore, ViewportPortal,
  useNodesState, useEdgesState,
  useInternalNode, getBezierPath, MarkerType, EdgeLabelRenderer,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import claudeLogo from './assets/providers/claude.svg';
import codexLogo from './assets/providers/codex.svg';
import geminiLogo from './assets/providers/gemini.svg';
import opencodeLogo from './assets/providers/opencode.svg';
import antigravityLogo from './assets/providers/antigravity.png';
import hermesAvatar from './assets/providers/hermes.png';
import cursorLogo from './assets/providers/cursor.svg';
import kilocodeLogo from './assets/providers/kilocode.svg';
import minimaxLogo from './assets/providers/minimax.svg';
import openaiLogo from './assets/providers/openai.svg';
import anthropicLogo from './assets/providers/anthropic.svg';
import { computeLayout, reconcilePositions, applyGroupDrag, groupDragDelta, hullsFromPositions } from './layout.js';
import { formatAge, truncateText, shouldShowBubble, idleSubline, idleAgeSeconds, loadBubblePref, saveBubblePref, accentFor, bubbleLines, placeBubbles, BUBBLE_DEFAULT_W, BUBBLE_DEFAULT_H, hueFor, identityColor, routeTether, firstCollision, bubbleDim } from './bubble.js';
import { _internals as layoutInternals } from './layout.js';

// The graph contract (T1 server, T2 UI):
//     {folder, branch}      state 'container'  (top grouping + repo branch sub-group)
//     {session, agent}      state active|idle|monitoring, with badge:'claude'|'orca'|'subagent'
//     {hermes}              state 'idle' (always-on node when GET HERMES_URL/health is up)
const RADIUS = { folder: 18, branch: 14, agent: 10, hermes: 12, session: 10 };
const COLORS = {
  folder: '#cfd9e6', branch: '#8ea4bf',
  agent: '#63a6ff', hermes: '#f07ab8', session: '#dbe4f0', line: '#3a4757',
};

// Per-card accent colour. Reused by the bubble overlay so the leader line
// and border identify the owner by colour. Kept as a thin wrapper around the
// pure helper in bubble.js so the legend and chip swatches stay in sync.
const colorOf = (d) => accentFor(d);

// Handles must exist for React Flow to place an edge at all - it resolves the
// edge's endpoint against handleBounds before it ever calls this component. The
// floating edge type then draws centre-to-centre and ignores where they sit.
const HANDLE = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0, background: 'transparent' };

// The provider chip: which agent software runs the node (claude, codex,
// hermes...), from the server's `provider` field on session nodes (set from
// Orca's `agentIdentity`) or the kind on hermes/branch. Unknown provider
// renders a neutral letter chip ("?") so the chip slot is never blank or
// misattributed.
const PROVIDERS = {
  claude:      { src: claudeLogo,      alt: 'claude' },
  codex:       { src: codexLogo,       alt: 'codex' },
  gemini:      { src: geminiLogo,      alt: 'gemini' },
  opencode:    { src: opencodeLogo,    alt: 'opencode' },
  antigravity: { src: antigravityLogo, alt: 'antigravity' },
  cursor:      { src: cursorLogo,      alt: 'cursor' },
  kilocode:    { src: kilocodeLogo,    alt: 'kilocode' },
  minimax:     { src: minimaxLogo,     alt: 'minimax' },
  openai:      { src: openaiLogo,      alt: 'openai' },
  anthropic:   { src: anthropicLogo,   alt: 'anthropic' },
  hermes:      { src: hermesAvatar,    alt: 'hermes' },
};

function ProviderChip({ data }) {
  if (data.kind === 'branch') {
    return (
      <span className="prov branch" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M6 4v6m0 0a2 2 0 1 0 0 4m0-4a2 2 0 1 0 0 4m0 0v8" /></svg>
      </span>
    );
  }
  if (data.kind === 'hermes' || data.provider === 'hermes') {
    return <span className="prov avatar"><img src={hermesAvatar} alt="hermes" /></span>;
  }
  const p = PROVIDERS[data.provider];
  if (p) return <span className="prov"><img src={p.src} alt={p.alt} /></span>;
  // Provider 'claude' (rendering for badge:'claude' transcript-only sessions)
  // gets the claude mark explicitly so the chip shows even when data.provider
  // is absent on the node.
  if (data.provider === 'claude') {
    return <span className="prov"><img src={claudeLogo} alt="claude" /></span>;
  }
  // Unknown provider: a neutral letter chip ("?") so the slot is never blank.
  if (data.kind === 'session') {
    return <span className="prov unknown" aria-label="unknown provider">?</span>;
  }
  // Agents / other kinds with no usable provider: render no chip rather than
  // misattribute an unknown one as claude.
  return null;
}

// Origin badge chip: 'orca' / 'subagent' / 'claude' - placed on session and agent
// frames so the dispatch mechanism is readable at a glance.
const BADGE_LABEL = { orca: 'orca', subagent: 'subagent', claude: 'claude' };

function OriginBadge({ data }) {
  const badge = BADGE_LABEL[data?.badge];
  if (!badge) return null;
  return <span className={'badge badge-' + badge} title={'origin: ' + badge}>{badge}</span>;
}

function AgentNode({ data }) {
  const dot = data.kind === 'branch' || data.kind === 'hermes'
    ? colorOf(data)
    : (data.state === 'active' ? '#4ecb8c' : data.state === 'monitoring' ? '#f0c860' : '#6b7787');
  const stateCls = data.kind === 'branch'
    ? 'container'
    : (data.state || 'idle');
  // Identity socket: a tiny dot on the TOP-CENTRE of every session /
  // agent card, painted with the card's identity hue (the same hue the
  // bubble border, tether and socket use). The card carries its owner
  // id in data.id (added by buildFlowNodes), so this is the one place
  // that turns id -> hue via the pure helper identityColor().
  // accentFor/colorOf stays in use on .gn-dot because there colour
  // means ROLE/KIND; here on the socket it means IDENTITY (different
  // signal: same card, different concept). The socket must not displace
  // the existing .gn-dot or the provider chip, so it is positioned
  // absolutely at the top edge of the .gn container.
  const showSocket = data.kind === 'session' || data.kind === 'agent';
  const socketColor = showSocket && data.id ? identityColor(data.id) : null;
  return (
    <div data-kind={data.kind} data-state={stateCls}
         className={'gn gn-box gn-' + stateCls}
         title={[data.label, data.sub, data.folder].filter(Boolean).join('\n')}>
      <Handle type="target" position={Position.Top} style={HANDLE} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={HANDLE} isConnectable={false} />
      <ProviderChip data={data} />
      <span className="gn-txt">
        <span className="gn-lbl">{data.label}</span>
        {data.sub ? <span className="gn-sub">{data.sub}</span> : null}
      </span>
      {data.kind === 'session' || data.kind === 'agent' ? <OriginBadge data={data} /> : null}
      {data.kind !== 'branch' ? (
        <span className="gn-dot" title={data.state} style={{ background: dot }} />
      ) : null}
      {showSocket && socketColor ? (
        <span className="gn-socket" title="bubble tether anchor"
              style={{ background: socketColor }} />
      ) : null}
    </div>
  );
}

function FloatingEdge({ id, source, target, markerEnd, style, label, labelStyle, data }) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t || !s.measured || !t.measured) return null;
  const cx = (n) => n.internals.positionAbsolute.x + n.measured.width / 2;
  const cy = (n) => n.internals.positionAbsolute.y + n.measured.height / 2;
  const sx = cx(s), sy = cy(s), tx = cx(t), ty = cy(t);
  // Curved bezier, like the OmniRoute topology view: control points extend
  // horizontally out of each endpoint, which reads better than a straight line
  // when many edges share a hub.
  const [path] = getBezierPath({
    sourceX: sx, sourceY: sy, targetX: tx, targetY: ty,
    sourcePosition: Math.abs(tx - sx) > Math.abs(ty - sy)
      ? (tx > sx ? Position.Right : Position.Left)
      : (ty > sy ? Position.Bottom : Position.Top),
    targetPosition: Math.abs(tx - sx) > Math.abs(ty - sy)
      ? (tx > sx ? Position.Left : Position.Right)
      : (ty > sy ? Position.Top : Position.Bottom),
    curvature: 0.35,
  });
  // Midpoint, nudged off the line. Near the run end they bunched around the hub
  // and overlapped each other; exactly on the midpoint they sat across a node,
  // since a 70px label centred on a 170px edge reaches into both ends.
  const dx = tx - sx, dy = ty - sy;
  const len = Math.hypot(dx, dy) || 1;
  const labelX = (sx + tx) / 2 + (-dy / len) * 17;
  const labelY = (sy + ty) / 2 + (dx / len) * 17;
  // Animated while the CHILD endpoint is active. data.animated is the new
  // contract (server-driven); data.flow is kept for backward compatibility
  // with the legacy message-flow signal so the overlay keeps working.
  const flowing = data?.animated ?? data?.flow;
  // Animated edges: faint base line + bright dashed pulse marching along the
  // same bezier. The ParticleLayer adds the glowing dots travelling
  // parent->child along this same path.
  const baseStyle = flowing
    ? { ...style, opacity: 0.18, strokeWidth: 1.6 }
    : style;
  return (
    <>
      <path id={id} className="react-flow__edge-path" d={path} markerEnd={markerEnd} style={baseStyle} />
      {flowing ? (
        <path
          className="edge-flow"
          d={path}
          style={{ stroke: style?.stroke, markerEnd: undefined }}
        />
      ) : null}
      {label ? (
        <EdgeLabelRenderer>
          <div className="edge-label"
               style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`, ...labelStyle }}>
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

// <pure-graph-helpers>
// Folders are NOT drawn as cards: the tinted hull (group box) is the folder's
// visible identity. Folder nodes stay in the force simulation as layout hubs
// (they keep each folder's children together) but never reach React Flow, and
// neither do edges that start or end at one - with no card there is nothing to
// draw from.
const folderKey = (p) => String(p || '').replace(/[\\]/g, '/').replace(/\/+$/, '').toLowerCase();
const renderableNodes = (nodes) => nodes.filter((n) => n.kind !== 'folder');
const renderableEdges = (nodes, edges) => {
  const folderIds = new Set(nodes.filter((n) => n.kind === 'folder').map((n) => n.id));
  return edges.filter((e) => !folderIds.has(e.from) && !folderIds.has(e.to));
};
// path (case-insensitive) -> { label: short name, path: full path }. Folder node
// ids are slugs, so the hull cannot look the node up by id; key it by the path
// the server carries in `folder` / `sub`.
const buildFolderMeta = (nodes) => {
  const meta = new Map();
  for (const n of nodes) {
    if (n.kind !== 'folder') continue;
    const path = n.folder || n.sub || '';
    meta.set(folderKey(path), { label: n.label || path, path });
  }
  return meta;
};
const hullLabel = (meta, folder) => meta.get(folderKey(folder)) || { label: folder, path: folder };
// </pure-graph-helpers>

// Folder hulls: tinted rounded regions behind each folder's children so the
// grouping reads at a glance without relying on faint dashed edges. The hull
// descriptors are recomputed from the current member positions every render
// so a hull grows when a dragged node moves and always encloses its members.
// The 24 px group gap is a layout-time promise (computeLayout's separation
// pass) - after a manual drag, hulls may legitimately touch.
//
// Pointer drag: the hull box + its label are interactive. Pressing anywhere
// on them grabs the whole group (cursor: grab -> grabbing). The drag is
// anchored in FLOW space at pointerdown and re-applied ABSOLUTELY from that
// anchor on every move, so the group tracks the cursor exactly at any zoom and
// never accumulates drift. Panning the canvas is unaffected.
//
// The `nopan` class is what keeps React Flow's d3-zoom from panning the pane
// out from under the drag: d3-zoom binds its mousedown listener to
// `.react-flow__renderer` (an ancestor of the ViewportPortal this SVG lives
// in) and its filter calls event.target.closest('.nopan') — a hull press lands
// on the SVG rect, so the class on the <g> makes the pane ignore it. (d3-zoom
// listens to `mousedown`, not `pointerdown`, so a React synthetic
// stopPropagation could never have reached it; the primary-button
// preventDefault below suppresses the mousedown d3-zoom would otherwise get.)

function FolderHulls({ hulls, meta, onGroupDrag, dragRef, positionsRef, flowPointAt }) {
  const beginDrag = (e, h) => {
    // Only react to primary button. The hull is drawn over the React Flow
    // viewport, so the press lands on the pane's canvas rather than a node.
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Anchor the drag in flow space. `flowPointAt` is React Flow's own
    // screenToFlowPosition, so the anchor and every subsequent cursor sample
    // share one transform. Members are snapshotted here: each move applies
    // snapshot + absolute delta, never a running accumulation.
    const snap = new Map();
    for (const id of h.members) {
      const p = positionsRef.current.get(id);
      if (p) snap.set(id, { x: p.x, y: p.y });
    }
    dragRef.current = {
      members: h.members,
      snapshot: snap,
      startFlow: flowPointAt({ x: e.clientX, y: e.clientY }),
    };
    document.body.classList.add('hull-dragging');
  };
  const endDrag = () => { dragRef.current = null; document.body.classList.remove('hull-dragging'); };
  // Global pointermove/pointerup: the drag outlives the SVG <g> under the
  // cursor. Only those two listeners are needed — the anchor is captured in
  // beginDrag, so there is no window pointerdown to miss.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onMove = (e) => {
      const drag = dragRef.current;
      if (!drag) return;
      const { dx, dy } = groupDragDelta(drag.startFlow, flowPointAt({ x: e.clientX, y: e.clientY }));
      onGroupDrag(drag.members, drag.snapshot, dx, dy);
    };
    const onUp = () => endDrag();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup',   onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup',   onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [onGroupDrag, flowPointAt, dragRef]);

  if (!hulls || !hulls.length) return null;
  return (
    <ViewportPortal>
      <svg className="ws-hulls" aria-hidden="true">
        {hulls.map((h) => {
          const { label, path } = hullLabel(meta, h.folder);
          return (
            <g key={h.key} className="hull-group nopan"
               onPointerDown={(e) => beginDrag(e, h)}>
              <rect className="hull-box"
                    x={h.x} y={h.y} width={h.w} height={h.h} rx={26}
                    fill={`hsl(${h.hue} 45% 45% / 0.055)`}
                    stroke={`hsl(${h.hue} 55% 60% / 0.30)`}
                    strokeDasharray="7 7" strokeWidth={1.2} />
              {/* Label lives INSIDE the box at the top so the <g>'s
                  getBoundingClientRect() matches the box's. The spec's
                  hull-gap check is implemented as "no two hull-groups
                  overlap", and an out-of-box label would inflate the
                  <g>'s bbox and look like a hull collision when the
                  boxes are actually clear. */}
              <text className="hull-label"
                    x={h.x + 14} y={h.y + 16}>{label}<title>{path}</title></text>
            </g>
          );
        })}
      </svg>
    </ViewportPortal>
  );
}

// Particle layer: one shared rAF loop across every animated edge. Each
// animated edge has N particles (PARTICLES_PER_EDGE) whose progress, speed,
// perpendicular offset and pulse phase are kept in a refs map so the rAF
// loop can update cx/cy/opacity/r without re-rendering the React tree.
// The reference (diagram-anim/adlc-comparison-full.html) uses canvas +
// createRadialGradient; we use SVG with an feGaussianBlur filter so the
// particles pick up the same cyan glow without a per-frame gradient
// allocation.
const PARTICLES_PER_EDGE = 4;

function ParticleLayer() {
  const edges = useStore((s) => s.edges);
  const reducedMotion = useReducedMotion();
  // particleData: edgeId -> Array<N particles> with stable per-particle
  // properties (speed, offset, size, alpha, pulse offset, ref). Created
  // once when an edge first appears; the rAF loop reads from this map.
  const particleData = useRef(new Map());

  const animatedEdges = edges.filter((e) => e.data?.animated);

  // Initialise / clean up per animated edge.
  for (const edge of animatedEdges) {
    if (!particleData.current.has(edge.id)) {
      const arr = [];
      for (let i = 0; i < PARTICLES_PER_EDGE; i++) {
        arr.push({
          progress: i / PARTICLES_PER_EDGE + Math.random() * 0.3,
          speed: 0.0045 + Math.random() * 0.0045,
          offset: -8 + Math.random() * 16,
          size: 1.6 + Math.random() * 1.8,
          alpha: 0.45 + Math.random() * 0.35,
          pulseOffset: Math.random() * 1000,
          ref: null,
        });
      }
      particleData.current.set(edge.id, arr);
    }
  }
  // Drop data for edges that have been removed.
  const liveIds = new Set(animatedEdges.map((e) => e.id));
  for (const id of [...particleData.current.keys()]) {
    if (!liveIds.has(id)) particleData.current.delete(id);
  }

  // One rAF loop. Cancels when no animated edges OR reduced motion.
  useEffect(() => {
    if (reducedMotion) return;
    if (!animatedEdges.length) return;
    let raf = 0;
    const t0 = performance.now();
    const frame = (now) => {
      const t = now - t0;
      for (const edge of animatedEdges) {
        const pathEl = document.getElementById(edge.id);
        if (!pathEl || typeof pathEl.getTotalLength !== 'function') continue;
        const len = pathEl.getTotalLength();
        if (!len) continue;
        const particles = particleData.current.get(edge.id);
        if (!particles) continue;
        for (const p of particles) {
          p.progress += p.speed;
          if (p.progress > 1) p.progress -= 1;
          const pt = pathEl.getPointAtLength(p.progress * len);
          const ahead = pathEl.getPointAtLength(Math.min(len, (p.progress + 0.005) * len));
          const dx = ahead.x - pt.x, dy = ahead.y - pt.y;
          const L = Math.hypot(dx, dy) || 1;
          const nx = -dy / L, ny = dx / L;
          // Reference's two-phase pulse: 0.3 -> 0.8 -> 0.3 over 1 second.
          const pulsePhase = ((t + p.pulseOffset) % 1000) / 1000;
          const pulseAlpha = pulsePhase < 0.5
            ? 0.3 + (pulsePhase / 0.5) * 0.5
            : 0.8 - ((pulsePhase - 0.5) / 0.5) * 0.5;
          const scalePhase = ((t + p.pulseOffset) % 500) / 500;
          const scale = scalePhase < 0.5
            ? 0.85 + (scalePhase / 0.5) * 0.35
            : 1.20 - ((scalePhase - 0.5) / 0.5) * 0.35;
          const cx = pt.x + nx * p.offset;
          const cy = pt.y + ny * p.offset;
          if (p.ref) {
            p.ref.setAttribute('cx', cx.toFixed(2));
            p.ref.setAttribute('cy', cy.toFixed(2));
            p.ref.setAttribute('r', (p.size * scale).toFixed(2));
            p.ref.setAttribute('opacity', Math.min(0.95, p.alpha * pulseAlpha).toFixed(3));
          }
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [animatedEdges, reducedMotion]);

  if (reducedMotion) return null;
  return (
    <ViewportPortal>
      <svg className="ws-particles" aria-hidden="true">
        <defs>
          {/* Same gaussian-blur glow filter as the reference: feGaussianBlur
             stdDeviation 2 merged with SourceGraphic. Applied to every
             particle so the cyan dots carry a soft halo without a per-frame
             radial gradient. */}
          <filter id="ws-edge-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {animatedEdges.map((edge) => {
          const ps = particleData.current.get(edge.id);
          if (!ps) return null;
          return (
            <g key={edge.id} filter="url(#ws-edge-glow)">
              {ps.map((p, i) => (
                <circle
                  key={i}
                  ref={(el) => { if (el) p.ref = el; }}
                  fill="#67e8f9"
                  r={p.size}
                  opacity={p.alpha}
                />
              ))}
            </g>
          );
        })}
      </svg>
    </ViewportPortal>
  );
}

// Reduced-motion preference as a hook (no extra dependency).
function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

// No `folder` type: folder nodes are filtered out before React Flow (renderableNodes).
const nodeTypes = { branch: AgentNode, agent: AgentNode, hermes: AgentNode, session: AgentNode };
const edgeTypes = { floating: FloatingEdge };

// localStorage key for the Bubbles toggle. ON by default; a blocked storage
// (private mode, quota error) is caught inside loadBubblePref so the page
// never breaks on a missing or thrown storage.
const BUBBLE_KEY = 'fleet-monitor-bubbles';
// Truncate budgets for the bubble text. The bubble is capped at ~260 px
// wide; these keep the rendered lines under three visible rows.
const BUBBLE_ACTION_MAX = 36;
const BUBBLE_SAID_MAX = 56;

// Idle-card sub-line override: "idle · <age> · <branch>" replaces the server's
// generic sub for terminal-driven idle cards so the user can still tell how long
// it has been quiet. Helper lives next to the render so the test pins the
// exact string format.
function idleSubFor(node, nowMs) {
  if (node.kind !== 'session' && node.kind !== 'agent' && node.kind !== 'hermes') return node.sub;
  if (node.state !== 'idle') return node.sub;
  const ageSec = idleAgeSeconds(node.tsIdle, nowMs);
  const age = ageSec == null ? '' : formatAge(ageSec);
  // With no branch the override still adds the age tag (e.g. "idle · 8m"),
  // matching the contract the spec asks for; without either we keep the
  // server's existing sub.
  if (!age && !node.branch) return node.sub;
  return idleSubline(age, node.branch);
}

// Bubble overlay: a single React Flow ViewportPortal that hosts one <div> per
// working card (active | monitoring). Each bubble reads its host node's
// measured bounds via useInternalNode and positions itself absolutely in
// flow space; ViewportPortal inherits the viewport transform so the bubble
// tracks zoom and pan. Pointer-events are forced none so a bubble can never
// steal a card drag or the pane pan. The age ticks through a shared 1 s
// `nowMs` prop; one setInterval per page refreshes every bubble.
//
// `placements` is a Map<ownerId, { side, x, y, w, h, collision }> returned by
// placeBubbles() in the parent. Each placement is computed against every
// card and every other placed bubble, so the bubble never lands on top of a
// non-owner card and never overlaps another bubble (>= 4 px clear). The CSS
// `data-side` attribute carries the chosen side; the leader line element
// reorients itself based on the attribute (the default above stays a
// vertical bar; right/left rotate the bar to a horizontal orientation).
//
// `blockers` are the SAME non-owner card rects the placement pass used,
// pre-built once per placement pass and passed in so the tether's
// routeTether() call does not re-measure per bubble (a hot path on every
// poll). `hoverId` carries the D3 hover-isolation state: only the
// hovered card's bubble stays un-dimmed; everything else fades to 0.15.
// `suppressed` is the D4 set of bubble ids the reconciliation pass has
// decided to hide because they still overlap a non-owner card after the
// measured re-placement.
function BubbleLayer({ enabled, nowMs, candidates, placements, blockers, hoverId, suppressed }) {
  if (!enabled) return null;
  return (
    <ViewportPortal>
      {candidates.map((n) => {
        const data = n.data || {};
        if (!shouldShowBubble(data.state)) return null;
        const activity = data.activity;
        if (!activity || (!activity.action && !activity.said)) return null;
        const placement = placements && placements.get(n.id);
        // placeBubbles returns a placement with `collision: true` when no
        // side is clear of non-owner cards. Hide the bubble in that case:
        // showing it would overlap a card, which violates the spec's
        // "nothing overlaps, ever" invariant. The placement map only
        // contains entries for bubbles the helper actually placed; bubbles
        // the helper gave up on are simply absent.
        if (!placement) return null;
        if (placement.collision) return null;
        // D4: the post-render reconciliation may decide to hide this
        // bubble because its measured rect still overlaps a non-owner
        // card after one more placement pass. Skipped here so the
        // rendered tree never shows a bubble that the contract forbids.
        if (suppressed && suppressed.has(n.id)) return null;
        const dim = bubbleDim(hoverId, n.id) ? '1' : '0';
        return <Bubble key={n.id} nodeId={n.id} activity={activity}
                       nowMs={nowMs} placement={placement}
                       blockers={blockers || []} dim={dim} />;
      })}
    </ViewportPortal>
  );
}

function Bubble({ nodeId, activity, nowMs, placement, blockers, dim }) {
  const internal = useInternalNode(nodeId);
  if (!internal || !internal.measured) return null;
  // React Flow applies `transform: translate(positionAbsolute.x, positionAbsolute.y)`
  // to the node, so positionAbsolute IS the node's top-left in flow space
  // (not the centre, despite `nodeOrigin=[0.5, 0.5]` — the origin only
  // affects how the CSS transform is built, not how positionAbsolute is
  // reported in internals). Anchor the bubble on the card's TOP-CENTRE
  // (top-left + half the measured size) so the leader line's lower
  // endpoint lands on the card's top centre exactly. The CSS transform on
  // the bubble still shifts it up by 100% + 14 px, leaving room for the
  // tail and the leader line.
  const x = internal.internals.positionAbsolute.x + internal.measured.width / 2;
  const y = internal.internals.positionAbsolute.y;
  const ts = activity && activity.ts;
  const ageSec = ts ? Math.max(0, (nowMs - ts) / 1000) : 0;
  // bubbleLines() owns the rendering contract: action+said => age on the
  // action line; said-only => age on the said line. This is what makes the
  // "every bubble that has any activity shows an age" guarantee testable.
  const lines = bubbleLines(activity, ageSec);
  // Identity colour: the per-owner hue derived from the nodeId via
  // hueFor / identityColor (D1). accentFor/colorOf stay in use elsewhere
  // (state dot, legend swatch) — there colour means role/kind; here on
  // the bubble / tether / socket it means IDENTITY, which is the new
  // signal the user asked for. Fallback to the agent blue when no data
  // is set (defensive — should not happen in practice).
  const accent = identityColor(nodeId);
  // Placement from placeBubbles: a top-left rect in flow space the bubble
  // will occupy. The helper picked the side; we just place the element.
  // `side` is one of above|below|right|left — the CSS uses data-side to
  // rotate the leader line so it still points at the owner card.
  // --bubble-accent lives on the WRAP so both the tether SVG (sibling)
  // and the bubble (child) inherit it: the acceptance check prints the
  // tether stroke, the bubble border and the owner socket colour and
  // requires all three to be the same identity hue.
  const wrapStyle = { '--bubble-accent': accent };
  const style = { left: x, top: y };
  if (placement) {
    style.left = placement.x + placement.w / 2;
    style.top  = placement.y;
  }
  // Tether: routed from the bubble's tail tip (the bubble placement's
  // centre-x bottom edge for "above", mirrored for the other sides) to
  // the card's top-centre socket. The path is built once per render by
  // the pure `routeTether` helper, which checks every sampled point of
  // each segment against the caller's blocker list and inserts ONE bend
  // perpendicular to the segment when needed (D2). Without blockers
  // supplied here the bend never fires, but the same code path drives
  // the rendered line, so the path can never cross another card.
  let tether = null;
  if (placement) {
    const px = placement.x + placement.w / 2;
    const py = placement.y;
    // The "from" point: the tail tip on the chosen side of the bubble.
    // `above` is the default; the bubble's tail visually points down at
    // the card from its bottom edge. The other sides mirror the tip to
    // the bubble's other edges (note: bottom/top of the placement rect
    // because the bubble sits in placement.y, with `transform: translate(
    // -50%, 0)` anchoring its top-left at style.left - placement.w/2).
    let fx = px, fy = py;
    if (placement.side === 'above') fy = placement.y + placement.h;
    else if (placement.side === 'below') fy = placement.y;
    else if (placement.side === 'right') fx = placement.x;
    else if (placement.side === 'left') fx = placement.x + placement.w;
    tether = routeTether({
      from: { x: fx, y: fy },
      to: { x: x, y: y },
      blockers: blockers || [],
    });
  }
  return (
    <div className="bubble-wrap" data-dim={dim} style={wrapStyle}>
      {tether && tether.d ? (
        <svg className="bubble-tether" aria-hidden="true">
          <path d={tether.d} />
          <circle cx={x} cy={y} r={3} />
        </svg>
      ) : null}
      <div className="bubble"
           data-side={placement ? placement.side : 'above'}
           data-collision={placement && placement.collision ? '1' : undefined}
           style={style}
           data-activity-ts={ts || ''}
           data-owner-id={nodeId}>
        <div className="bubble-tail" aria-hidden="true" />
        {/* The legacy 14px CSS-bar .bubble-leader is gone: the routed
            .bubble-tether above carries the line in the owner's identity
            hue with a clear endpoint dot on the card's socket (D2). */}
        {lines.map((ln, i) => (
          <div className="bubble-line" key={ln.kind + '-' + i}>
            {ln.kind === 'action'
              ? <span className="bubble-action">{truncateText(ln.text, BUBBLE_ACTION_MAX)}</span>
              : <span className="bubble-said">{truncateText(ln.text, BUBBLE_SAID_MAX)}</span>}
            <span className="bubble-age">{ln.age}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Frozen edge vocabulary (T1): the tree is rendered as `tree` edges, the
// session>agent containment is `spawn` (animated while the agent is active),
// and same-folder peers share a `member` link.
const EDGE = {
  tree:   { stroke: '#5b6678', opacity: 0.55, dash: '2 4' },
  spawn:  { stroke: '#63a6ff', opacity: 0.9 },
  member: { stroke: COLORS.line, opacity: 0.45, dash: '2 4' },
  default: { stroke: '#55657a', opacity: 0.8 },
};

function Monitor() {
  const { fitView, screenToFlowPosition } = useReactFlow();
  const storeApi = useStoreApi();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [stats, setStats] = useState({});
  const [folderMeta, setFolderMeta] = useState(() => new Map());
  const [conn, setConn] = useState({ up: false, text: 'connecting…' });
  // Counter bumped after every positions-mutating step (poll, re-layout, drag)
  // so the live hull list re-evaluates. Cheap: hullsFromPositions is O(members)
  // and runs every render.
  const [positionsVersion, setPositionsVersion] = useState(0);
  // Bubbles toggle: persisted in localStorage, ON by default. A blocked
  // localStorage (private mode, quota, missing storage) is caught inside the
  // helpers so the page never breaks on a thrown storage.
  const [bubblesOn, setBubblesOn] = useState(() => loadBubblePref(BUBBLE_KEY, true));
  // Shared 1 s tick: drives bubble-age + idle-sub-line refresh without a
  // re-render storm (one setInterval refreshes every Bubble + idle card).
  const [nowMs, setNowMs] = useState(() => Date.now());

  // positions: Map<id, {x,y}>. Owned by the client, persists across polls,
  // updated by reconcilePositions (poll), computeLayout (initial / re-layout),
  // and applyGroupDrag (hull drag). Stored in a ref so applyGroupDrag can
  // mutate it inside a pointermove without forcing an extra render through
  // setState; we bump positionsVersion instead.
  const positionsRef = useRef(new Map());
  // First-graph flag: full computeLayout only on the first /graph payload.
  const didInitialLayoutRef = useRef(false);
  // Last raw graph for the "Re-layout" button.
  const lastGraphRef = useRef(null);
  // Pointer-drag scratch for the hull-grab handler. Lives here so the global
  // window listeners in FolderHulls read the latest closure.
  const hullDragRef = useRef(null);
  // True while a card is being dragged by hand. A poll that lands mid-drag must
  // not rebuild the node list under the cursor.
  const nodeDragRef = useRef(false);
  // Member-id->folder metadata, so onGroupDrag knows which folder each member
  // belongs to (the hulls list mirrors this, but iterating `nodes` is faster).
  const memberFolderRef = useRef(new Map());                   // id -> folderKey
  // The last hull list computed. Kept in a ref so reconcilePositions on the
  // next poll can read it without subscribing to state (and without re-render).
  const lastHullsRef = useRef([]);
  // Cards the user dragged this turn (or last turn). Passed to
  // reconcilePositions as `pinned` so the per-poll separation pass leaves
  // them exactly where the user put them and only moves OTHER cards. Cleared
  // after the next reconcilePositions call (the very call that uses them).
  const pinnedCardIdsRef = useRef(new Set());
  // Bubble placement map: re-computed whenever a poll / drag / re-layout
  // changes positions. Stored in state so BubbleLayer re-renders with the
  // new placements; keyed on positionsVersion + nodes.length like the live
  // hulls. placeBubbles() is O(bubbles * cards + bubbles^2) which is
  // sub-millisecond for the typical 5..20 active cards.
  const [bubblePlacements, setBubblePlacements] = useState(() => new Map());
  // Mirror of the CURRENT bubble placements. placeBubbles reads it as `prev`
  // so a bubble keeps its side + anchor while that position still fits (the
  // "sticky" contract), and computeAndSetPlacements compares against it so an
  // unchanged result never triggers a state update. Written only where
  // setBubblePlacements is called.
  const bubblePlacementsRef = useRef(new Map());
  // Mirror of suppressedBubbleIds (same reason: read inside the callback).
  const suppressedRef = useRef(new Set());
  const blockersSigRef = useRef('');
  // Non-owner card rects the placement pass used (the same rects
  // placeBubbles fed on its last run). The tether reads these via
  // routeTether() so the line bends AROUND obstacles without re-measuring
  // the DOM per bubble. Stored as state so it survives the bubble render
  // but updates together with bubblePlacements on every position mutation.
  const [bubbleBlockers, setBubbleBlockers] = useState([]);
  // D3: hover-isolation state. Hovering a card sets this to the card's
  // id; BubbleLayer dims every bubble except the one belonging to it
  // via the data-dim attribute on .bubble-wrap. A node-drag cancels the
  // hover so the dim doesn't flash off mid-drag.
  const [hoverId, setHoverId] = useState(null);
  // D4: bubbles suppressed by the post-render reconciliation pass.
  // Stored as state in a Set so BubbleLayer can skip them in O(1).
  // The reconciliation effect adds ids that STILL collide after one
  // measured re-placement pass, and clears ids whose owners no longer
  // collide.
  const [suppressedBubbleIds, setSuppressedBubbleIds] = useState(() => new Set());
  // D4: reconciliation guard. The post-render effect must not call
  // setBubblePlacements more than once per layout state (otherwise it
  // loops). computeAndSetPlacements clears the guard (a new layout is
  // coming in); the effect sets it after running.
  const reconciledRef = useRef(false);
  // D4: signature of positionsRef.current at the last
  // computeAndSetPlacements run. The guard + suppression set reset
  // ONLY when this signature changes (a real layout change), so the
  // 1 s ticker cannot oscillate the suppression set while the layout
  // stays put.
  const lastPositionsSigRef = useRef('');

  // Frame the graph once React Flow has measured the nodes. Fitting against
  // unmeasured (zero-size) boxes fits the wrong bounds and clips the graph.
  const scheduleFit = useCallback(() => {
    let tries = 0;
    const iv = setInterval(() => {
      const s = storeApi.getState();
      const all = s.nodeLookup.size > 0
        && [...s.nodeLookup.values()].every((n) => n.measured && n.measured.width);
      if (all) {
        clearInterval(iv);
        fitView({ padding: 0.05, minZoom: 0.6, maxZoom: 1.05, duration: 500 });
      } else if (++tries > 50) {
        clearInterval(iv);
      }
    }, 100);
  }, [storeApi, fitView]);

  // Build the React Flow node list using positionsRef.current. Called from
  // every path that mutates positions (applyGraph + applyGroupDrag + the 1 s
  // ticker). Keeping this in one helper means there's exactly one definition
  // of "what a node looks like on screen". `nowMs` is used to refresh the
  // idle-card sub-line ("idle · 8m · main") so a quiet terminal's age ticks.
  const buildFlowNodes = useCallback((graphNodes, nowMs) => {
    const store = storeApi.getState();
    return renderableNodes(graphNodes).map((n) => {
      const prev = store.nodeLookup.get(n.id);
      const pos = positionsRef.current.get(n.id);
      return {
        id: n.id,
        type: n.kind,
        position: pos ? { x: pos.x, y: pos.y } : { x: 0, y: 0 },
        data: {
          id: n.id,
          kind: n.kind, label: n.label, sub: idleSubFor(n, nowMs), state: n.state,
          role: n.role, badge: n.badge, model: n.model,
          // `provider` is the server-derived lowercase agent identity
          // ("claude", "antigravity", ...; "unknown" when absent). T1 wired
          // it onto every terminal-derived session node; we forward it so
          // ProviderChip can render the matching logo.
          provider: n.provider,
          folder: n.folder, branch: n.branch,
          parent: n.parent, ts: n.ts, tsIdle: n.tsIdle,
          // T1-supplied activity for the bubble overlay. Absent until T1
          // merges; BubbleLayer treats absent/missing action+said as no-op.
          activity: n.activity,
        },
        ...(prev && prev.measured ? { measured: prev.measured } : {}),
      };
    });
  }, [storeApi]);

  // Bubble placement: a single helper called from EVERY position-mutating
  // path (applyGraph, onGroupDrag, commitNodeDrag, handleRelayout, the 1 s
  // ticker) so the placement is always a pure function of the current
  // positions. Previously each path bumped positionsVersion and relied on
  // a separate useEffect to recompute placements; that effect read
  // positions from s.nodeLookup, which lags one render behind positionsRef
  // (the React Flow store updates after React commits, while positionsRef
  // is written in the same call that moved the cards). The 1-frame lag
  // is exactly the per-poll race that left a bubble on top of a card the
  // per-poll pass had just moved under it.
  //
  // The fix:
  //   - positionsRef.current is always fresh — it's the source of truth
  //     for card positions, and the same path that mutates it calls this
  //     helper in the same synchronous step.
  //   - The React Flow store (s.nodeLookup) is used only for MEASURED
  //     sizes (text-length-dependent, not position-dependent) and for the
  //     current zoom. Both change independently of position, so the store
  //     being one render stale is harmless.
  //   - Per-bubble size is read from the rendered DOM (the same source
  //     the previous implementation used) and divided by zoom to convert
  //     back to flow space.
  //
  // The helper no-ops when bubbles are off, no graph is loaded, or the
  // helper has no active cards to place. Drag is allowed to call it
  // during a node drag: the dragged card's position is already in
  // positionsRef (commitNodeDrag writes it), so the bubble follows the
  // card without jitter — the placement side is preserved by the push-out
  // arm, so the leader line never yanks to the other side.
  const computeAndSetPlacements = useCallback(() => {
    // Commit a placement map only when it differs from the current one:
    // same keys, same side/collision, and x/y/w/h within half a flow unit.
    // An identical result must NOT call setBubblePlacements (a state update
    // re-renders every bubble); this is also what makes the 1 s ticker's
    // unconditional call a no-op while nothing relevant moved.
    const commitPlacements = (next) => {
      const cur = bubblePlacementsRef.current;
      let same = cur.size === next.size;
      if (same) {
        for (const [id, p] of next) {
          const q = cur.get(id);
          if (!q || q.side !== p.side || !!q.collision !== !!p.collision
              || Math.abs(q.x - p.x) >= 0.5 || Math.abs(q.y - p.y) >= 0.5
              || Math.abs(q.w - p.w) >= 0.5 || Math.abs(q.h - p.h) >= 0.5) { same = false; break; }
        }
      }
      if (same) return;
      bubblePlacementsRef.current = next;
      // New placements deserve a fresh rendered-box check: a sticky bubble
      // that just moved (or a bubble re-placed after the toggle came back
      // on) may measure differently than the placement predicted.
      reconciledRef.current = false;
      setBubblePlacements(next);
    };
    // Same rule for the tether blockers: a fresh array every tick would
    // re-render the bubble layer for nothing.
    const setBlockersIfChanged = (block) => {
      const sig = block.map((r) => r.x.toFixed(1) + ',' + r.y.toFixed(1) + ',' + r.w.toFixed(1) + ',' + r.h.toFixed(1)).join('|');
      if (sig === blockersSigRef.current) return;
      blockersSigRef.current = sig;
      setBubbleBlockers(block);
    };
    if (!bubblesOn) { commitPlacements(new Map()); return; }
    if (!lastGraphRef.current) return;
    const g = lastGraphRef.current;
    const s = storeApi.getState();
    // D4 reset guard: only when the POSITIONS actually changed does a
    // fresh layout deserve a fresh reconciliation pass and a fresh
    // suppression set. Without this, the 1 s ticker (which always calls
    // this helper) would clear the suppression set every tick, bring
    // the offending bubble back for one render, and re-suppress it on
    // the next — an oscillation the acceptance test can catch.
    const sigParts = [];
    for (const [id, p] of positionsRef.current) {
      sigParts.push(id + ':' + p.x.toFixed(1) + ',' + p.y.toFixed(1));
    }
    sigParts.sort();
    const posSig = sigParts.join('|');
    // A bubble the reconciliation pass suppressed measured as overlapping a
    // card at its sticky spot; when the layout changes it must not be pinned
    // to that spot again, so its previous placement is dropped (it re-places
    // first-fit). Everything else stays sticky.
    let prevForPlace = bubblePlacementsRef.current;
    if (posSig !== lastPositionsSigRef.current) {
      lastPositionsSigRef.current = posSig;
      reconciledRef.current = false;
      if (suppressedRef.current.size) {
        prevForPlace = new Map(prevForPlace);
        for (const id of suppressedRef.current) prevForPlace.delete(id);
        suppressedRef.current = new Set();
        setSuppressedBubbleIds(new Set());
      }
    }
    // Measured sizes from the React Flow store. `measured.width` is the
    // CSS-pixel size of the rendered node (ResizeObserver output), NOT
    // the flow-space size — React Flow applies a `scale(zoom)` viewport
    // transform, so at zoom 0.8 a 220-flow-unit card measures 176 CSS
    // pixels. placeBubbles works in flow units (positions are flow),
    // so the measured size must be divided back by zoom. Feeding the
    // raw CSS-pixel size under-counted the real card footprint by
    // (1 - zoom), which let placeBubbles place a bubble 16 px clear of
    // the SMALLER card while it sat on top of the REAL one — the exact
    // residual bubbleOverNonOwnerCard the reconciliation could not
    // repair. Fall back to NODE_SIZE for any node the store hasn't
    // measured yet (a brand-new node appears before React Flow
    // measures it).
    const zoom = (s.transform && s.transform[2]) ? s.transform[2] : 1;
    const measuredById = new Map();
    for (const n of s.nodeLookup.values()) {
      if (n.measured && n.measured.width) {
        measuredById.set(n.id, { w: n.measured.width / zoom, h: n.measured.height / zoom });
      }
    }
    const sizeFor = (n) => {
      if (measuredById.has(n.id)) return measuredById.get(n.id);
      return layoutInternals.NODE_SIZE[n.kind] || { width: 220, height: 56 };
    };
    // All cards (renderable nodes) from the FRESH graph. positionsRef is
    // already the post-mutation source of truth — the same call that
    // moved the cards is now placing the bubbles, so the two cannot
    // disagree by a frame.
    const renderable = g.nodes.filter((n) => n.kind !== 'folder');
    const cards = renderable.map((n) => {
      const p = positionsRef.current.get(n.id);
      if (!p) return null;
      const sz = sizeFor(n);
      return { id: n.id, x: p.x, y: p.y, w: sz.w, h: sz.h };
    }).filter(Boolean);
    // Per-bubble size: use a FIXED CONSERVATIVE size that matches the CSS
    // caps. The bubble's rendered size is content-driven (max-width: 260 px,
    // up to 2 lines at 11 px/1.35 ≈ 42 px tall + padding), and it can
    // change between the placement pass (which reads the PREVIOUS frame's
    // DOM) and the render (which lays out the NEW content). A stale
    // measured size smaller than the real one puts the bubble outside the
    // placement's bounds — the exact bubbleOverNonOwnerCard defect this
    // task fixes. Using the CSS max (260x48) as the size for every
    // candidate rect guarantees the rendered bubble fits inside the
    // placement: the CSS transform translate(-50%, 0) centres the bubble on
    // style.left, so a narrower bubble's left edge is INSIDE the placement
    // and a shorter bubble's bottom is ABOVE the placement's bottom edge.
    // (The leader line is 14 px and BUBBLE_GAP is 16, so the line still
    // reaches the owner card.)
    const BUBBLE_PLACEMENT_W = 260;   // CSS max-width
    const BUBBLE_PLACEMENT_H = 48;    // 2 lines + padding
    const bubbles = renderable
      .filter((n) => shouldShowBubble(n.state))
      .filter((n) => n.activity && (n.activity.action || n.activity.said))
      .map((n) => ({ ownerId: n.id, size: { w: BUBBLE_PLACEMENT_W, h: BUBBLE_PLACEMENT_H } }));
    if (!bubbles.length) {
      commitPlacements(new Map());
      setBlockersIfChanged([]);
      return;
    }
    // Placement gap: BUBBLE_GAP (16 flow units) is the floor, but the
    // acceptance test measures the RENDERED screen gap < 1 px as an
    // overlap. At zoom 0.5 a 16-flow-unit gap renders as 8 screen px —
    // fine — but at zoom 1.3 a 1.2-flow-unit rounding overshoot on a
    // card edge eats the entire slack. Bumping the placement gap to
    // 24 flow units keeps the rendered screen gap >= 12 px at the
    // highest realistic zoom (1.05), so the sub-pixel jitter can never
    // dip below the 1 px threshold the test flags.
    const next = placeBubbles({ cards, bubbles, gap: 24, prev: prevForPlace });
    commitPlacements(next);
    // The blockers feed routeTether on the next render. Exclude the
    // owner of every bubble (the tether is allowed to start at the
    // owner's socket) AND, for tether purposes, exclude the bubble's
    // own rect (the tether begins at the bubble's tail, so passing the
    // bubble through blockers would force a bend on every bubble).
    // The blocker list is the same set of non-owner / non-self rects
    // placeBubbles saw on its pass, so the line never bisects the same
    // geometry the placement did.
    const block = cards
      .filter((c) => !bubbles.some((b) => b.ownerId === c.id))
      .map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h }));
    setBlockersIfChanged(block);
  }, [bubblesOn, storeApi]);

  const applyGraph = useCallback((g) => {
    const W = window.innerWidth, H = window.innerHeight;

    // Member -> folderKey index, used by both the first-graph and incremental
    // paths. Folder node ids are slugs, so the live hull list iterates the
    // server's `folder` field per member.
    for (const n of g.nodes) {
      if (n.kind !== 'folder' && n.folder) {
        memberFolderRef.current.set(n.id, folderKey(n.folder));
      }
    }

    if (!didInitialLayoutRef.current) {
      // First graph: full computeLayout. ticks=300 gives a fully settled
      // result on this machine. Subsequent polls reconcile incrementally.
      const { positions, hulls: newHulls } = computeLayout(
        g.nodes, g.edges, { width: W, height: H },
      );
      positionsRef.current = positions;
      setFolderMeta(buildFolderMeta(g.nodes));
      // Bump so the live hulls re-evaluate even though positionsRef changed.
      setPositionsVersion((v) => v + 1);
      // Stash the first-graph hull list in lastHullsRef so reconcileApplies
      // can pass prevHulls (kept for the rare folder-anchor code path).
      lastHullsRef.current = newHulls;
      didInitialLayoutRef.current = true;
      setNodes(buildFlowNodes(g.nodes, nowMs));
      scheduleFit();
      // Recompute bubble placements from the FRESH positions. The first
      // graph is the one that just settled every card, so the bubbles
      // must follow on the same render — the per-poll ticker is too late.
      computeAndSetPlacements();
    } else {
      // Subsequent /graph. Never re-run computeLayout. Existing positions
      // survive verbatim; brand-new nodes are placed incrementally. Removed
      // nodes are dropped. The hulls list is recomputed every render from
      // positionsRef.current.
      //
      // The per-poll separation pass that lives inside reconcilePositions
      // receives the dragged card ids in `pinned` so it only moves the
      // cards that were NOT touched by the user since the last poll. The
      // pass runs on the LIVE positions (positionsRef), not on the
      // simulation result, so the dragged cards never move.
      const r = reconcilePositions({
        prevPositions: positionsRef.current,
        prevHulls: lastHullsRef.current,
        nodes: g.nodes,
        edges: g.edges,
        opts: {
          width: W, height: H,
          pinned: pinnedCardIdsRef.current.size ? pinnedCardIdsRef.current : null,
        },
      });
      positionsRef.current = r.positions;
      lastHullsRef.current = r.hulls;
      // Pin survives a single poll: the pass that uses it is the one
      // that ran with the dragged positions. The next poll needs a fresh
      // decision (a different drag, a hull drag, or a new node).
      pinnedCardIdsRef.current = new Set();
      setFolderMeta(buildFolderMeta(g.nodes));
      setPositionsVersion((v) => v + 1);
      // A card (or hull) the user is holding right now is already tracked in
      // positionsRef by its drag handler; rebuilding the node list mid-drag
      // would only fight the pointer. Skip it - the next poll applies the data.
      if (!nodeDragRef.current && !hullDragRef.current) {
        setNodes(buildFlowNodes(g.nodes, nowMs));
      }
      // Recompute bubble placements from the FRESH positionsRef. The
      // per-poll separation pass that ran above may have moved cards
      // under existing bubbles; without this synchronous call the
      // placements would still reference the previous frame's positions
      // and the bubble would sit on top of a card it doesn't own
      // (the legacy race that produced bubbleOverNonOwnerCard=2..3).
      computeAndSetPlacements();
    }

    setEdges(renderableEdges(g.nodes, g.edges).map((l) => {
      const e = EDGE[l.kind] || EDGE.default;
      const target = g.nodes.find((x) => x.id === l.to);
      const animated = (l.data && (l.data.animated ?? l.data.flow))
        ?? (target ? target.state === 'active' : false);
      const isMember = l.kind === 'member';
      return {
        id: l.id,
        source: l.from,
        target: l.to,
        type: 'floating',
        label: undefined,
        labelStyle: { color: e.stroke },
        style: {
          stroke: e.stroke,
          opacity: animated ? Math.max(e.opacity, 0.85) : (isMember ? 0.32 : e.opacity * 0.7),
          strokeWidth: l.kind === 'spawn' ? 1.5 : (l.kind === 'tree' ? 1.1 : 1),
          strokeDasharray: e.dash,
        },
        markerEnd: isMember ? undefined
          : { type: MarkerType.ArrowClosed, width: 13, height: 13, color: animated ? e.stroke : (e.stroke + '99') },
        data: { flow: animated, animated },
      };
    }));

    // Stats over what this client actually shows - the living-only filter is
    // already done server-side; the chips reflect the rendered set.
    setStats({
      active: g.nodes.filter((n) => n.state === 'active').length,
      idle: g.nodes.filter((n) => n.state === 'idle').length,
      monitoring: g.nodes.filter((n) => n.state === 'monitoring').length,
      sessions: g.nodes.filter((n) => n.kind === 'session').length,
      agents: g.nodes.filter((n) => n.kind === 'agent').length,
      folders: g.nodes.filter((n) => n.kind === 'folder').length,
    });

    // Remember the latest graph so the Re-layout button has nodes/edges
    // without re-fetching from the server.
    lastGraphRef.current = g;
  }, [setNodes, setEdges, storeApi, scheduleFit, buildFlowNodes, nowMs, computeAndSetPlacements]);

  // React Flow's screenToFlowPosition, kept as a ref so FolderHulls reads the
  // latest closure without re-subscribing its window listeners each render.
  const flowPointAtRef = useRef(null);
  flowPointAtRef.current = screenToFlowPosition;
  const flowPointAt = useCallback((pt) => flowPointAtRef.current(pt), []);

  // Hull drag handler. `memberIds` is the drag's member list, `snapshot` the
  // member positions captured at pointerdown, and (dx, dy) the ABSOLUTE
  // FLOW-space delta from that same pointerdown (computed by groupDragDelta in
  // FolderHulls). Applying snapshot + delta — rather than accumulating — makes
  // the result a pure function of the current cursor position: the group tracks
  // the pointer exactly at any zoom and a mid-drag viewport change cannot drift it.
  //
  // A hull drag is also recorded as a pin: the very next poll's per-poll
  // separation pass receives the dragged member ids in `pinned` and leaves
  // them alone. Pinned hulls only move if the user moves them again, or
  // until a fresh "Re-layout" wipes everything.
  const onGroupDrag = useCallback((memberIds, snapshot, dx, dy) => {
    // Other members that were not in the snapshot (shouldn't normally happen,
    // but a poll can add a node to a folder mid-drag) keep their live position.
    const base = new Map(positionsRef.current);
    for (const [id, p] of snapshot) base.set(id, { x: p.x, y: p.y });
    positionsRef.current = applyGroupDrag({
      positions: base,
      memberIds,
      dx, dy,
    });
    for (const id of memberIds) pinnedCardIdsRef.current.add(id);
    setPositionsVersion((v) => v + 1);
    // Push the new positions into React Flow so the cards redraw at the new
    // location (hull follows from the live hull recompute).
    if (lastGraphRef.current) setNodes(buildFlowNodes(lastGraphRef.current.nodes, nowMs));
    // Recompute bubble placements from the FRESH positionsRef (same source
    // of truth as the cards). Without this the per-frame useEffect would
    // read the React Flow store one render later, so a hull drag that
    // moved a card under another card's bubble would leave the overlap
    // for a full tick (the legacy "bubbleOverNonOwnerCard" race).
    computeAndSetPlacements();
  }, [buildFlowNodes, setNodes, nowMs, computeAndSetPlacements]);

  // Bubble placement: a single helper called from EVERY position-mutating
  // path (applyGraph, onGroupDrag, commitNodeDrag, handleRelayout, the 1 s
  // ticker) so the placement is always a pure function of the current
  // positions. Previously each path bumped positionsVersion and relied on
  // a separate useEffect to recompute placements; that effect read
  // positions from s.nodeLookup, which lags one render behind positionsRef
  // (the React Flow store updates after React commits, while positionsRef
  // is written in the same call that moved the cards). The 1-frame lag
  // is exactly the per-poll race that left a bubble on top of a card the
  // per-poll pass had just moved under it.
  //
  // Defined above (right after buildFlowNodes) so all callers below can
  // reference it. See that definition for the full contract.

  // Card drags. React Flow moves the dragged card in its own node state, but the
  // 2.5 s poll rebuilds every card from positionsRef - so unless the drag is
  // written back there, the next poll snaps the card back to its old layout
  // position. Writing the final flow position into positionsRef is what makes a
  // hand-placed card stay put (reconcilePositions never moves a known id).
  // node.position is the card centre (nodeOrigin 0.5), the same convention
  // positionsRef uses.
  //
  // We also record the dragged id in pinnedCardIdsRef. The very next poll
  // hands that set to reconcilePositions's per-poll separation pass, which
  // then knows to leave the dragged card exactly where the user put it and
  // only move OTHER cards when a per-poll separation push would otherwise
  // shove it. Cleared after the next poll uses it (see applyGraph).
  const commitNodeDrag = useCallback((dragged) => {
    for (const n of dragged) {
      positionsRef.current.set(n.id, { x: n.position.x, y: n.position.y });
      pinnedCardIdsRef.current.add(n.id);
    }
    setPositionsVersion((v) => v + 1);       // the hull follows the card live
    // The card just moved: recompute bubble placements from the FRESH
    // positionsRef. The previous implementation waited for a useEffect on
    // positionsVersion, which read from s.nodeLookup — that lags one
    // render, so a card that landed under another card's bubble would
    // keep that overlap for the next 1 s ticker tick. The helper is
    // sub-millisecond for the typical 5..20 active cards, so calling it
    // synchronously here is cheap and closes the race.
    computeAndSetPlacements();
  }, [computeAndSetPlacements]);
  const onNodeDragStart = useCallback(() => { nodeDragRef.current = true; setHoverId(null); }, []);
  const onNodeDrag = useCallback((_e, node, dragged) => {
    commitNodeDrag(dragged && dragged.length ? dragged : [node]);
  }, [commitNodeDrag]);
  const onNodeDragStop = useCallback((_e, node, dragged) => {
    commitNodeDrag(dragged && dragged.length ? dragged : [node]);
    nodeDragRef.current = false;
  }, [commitNodeDrag]);

  // "Re-layout" button handler. Re-runs computeLayout on the latest payload,
  // overwriting every position (this wipes any prior user drags — that's the
  // button's job). The 24 px group-separation guarantee is restored here.
  const handleRelayout = useCallback(() => {
    const g = lastGraphRef.current;
    if (!g) return;
    const W = window.innerWidth, H = window.innerHeight;
    const { positions } = computeLayout(g.nodes, g.edges, { width: W, height: H });
    positionsRef.current = positions;
    lastHullsRef.current = hullsFromPositions(positions, g.nodes);
    setPositionsVersion((v) => v + 1);
    setNodes(buildFlowNodes(g.nodes, nowMs));
    scheduleFit();
    // Recompute bubble placements from the FRESH positions. Every card
    // has just moved (a Re-layout is a full reset) and the bubbles must
    // follow on the same render — the next 1 s ticker is too late.
    computeAndSetPlacements();
  }, [buildFlowNodes, setNodes, scheduleFit, nowMs, computeAndSetPlacements]);

  // Live hulls: recomputed from positionsRef + the latest node list. Cheap
  // (O(members)) and runs every render. The 24 px gap guarantee does NOT
  // apply here — only the layout-time separation pass enforces it. Keyed on
  // positionsVersion so a ref-mutation (drag, poll, re-layout) still triggers
  // a recompute on the next render.
  const liveHulls = useMemo(() => {
    if (!lastGraphRef.current) return [];
    return hullsFromPositions(positionsRef.current, lastGraphRef.current.nodes);
    // positionsVersion is the trigger; positionsRef is read inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionsVersion, nodes.length]);

  useEffect(() => {
    let ws, retry;
    const connect = () => {
      ws = new WebSocket(`ws://${location.host}`);
      ws.onopen = () => setConn({ up: true, text: `live · ${location.host}` });
      ws.onclose = () => { setConn({ up: false, text: 'disconnected · retry' }); retry = setTimeout(connect, 2000); };
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'graph') applyGraph(m); };
    };
    connect();
    return () => { clearTimeout(retry); if (ws) ws.close(); };
  }, [applyGraph]);

  // Shared 1 s ticker for bubble age + idle sub-line. One setInterval per page
  // refreshes every Bubble (the nowMs prop flows down through BubbleLayer).
  // A drag suppresses the setNodes call (commitNodeDrag owns the position) but
  // the ticker still fires so BubbleLayer's age keeps advancing.
  //
  // The ticker ALSO re-runs the per-poll separation pass: the WebSocket
  // only delivers a payload when the graph actually changes, so without
  // this periodic re-apply a stable graph would let hulls drift toward
  // each other (or stay at a sub-24-px gap the layout pass left). The
  // pass is a no-op when the layout is already settled; the per-poll cost
  // is bounded (40 passes) and under 5 ms on every workload measured.
  //
  // After the per-poll pass moves cards, computeAndSetPlacements is called
  // — the same helper the other position-mutating paths use, so the cards
  // and bubbles are placed atomically: the cards move in step 1, the
  // bubble placements are computed from the moved cards in step 2, and
  // React re-renders with both updates in one pass. The helper is the
  // single source of truth for bubble placement; the previous per-ticker
  // inline copy of the same logic is removed to keep one definition.
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      if (!nodeDragRef.current && !hullDragRef.current && lastGraphRef.current) {
        const g = lastGraphRef.current;
        const r = reconcilePositions({
          prevPositions: positionsRef.current,
          prevHulls: lastHullsRef.current,
          nodes: g.nodes,
          edges: g.edges,
          opts: { width: window.innerWidth, height: window.innerHeight },
        });
        positionsRef.current = r.positions;
        lastHullsRef.current = r.hulls;
        // Build the new node list. The placement is read off positionsRef
        // (already updated above) so the rendered cards reflect the
        // moved positions in this same render pass.
        const newNodes = buildFlowNodes(g.nodes, now);
        setNodes(newNodes);
        // Recompute bubble placements from the SAME positions the cards
        // now use. The helper reads cards from positionsRef (the per-poll
        // reconcile's output) plus the measured size from the store. This
        // avoids the race where the cards move but the bubble placements
        // are still pinned to the previous frame.
        computeAndSetPlacements();
        setPositionsVersion((v) => v + 1);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [buildFlowNodes, setNodes, computeAndSetPlacements]);

  // Bubbles toggle handler. Persists into localStorage synchronously so the
  // state survives a reload (the toggle button's whole reason for being).
  const toggleBubbles = useCallback(() => {
    setBubblesOn((v) => {
      const nv = !v;
      saveBubblePref(BUBBLE_KEY, nv);
      return nv;
    });
  }, []);

  // D3: hover-isolation handlers. BubbleLayer dims every bubble except
  // the one belonging to the card under the cursor. A node drag cancels
  // the hover so the dim doesn't flash off-mid-drag (the user can't see
  // it anyway).
  const onNodeMouseEnter = useCallback((_e, n) => setHoverId(n.id), []);
  const onNodeMouseLeave = useCallback(() => setHoverId(null), []);

  // D4: post-render reconciliation. Runs after React commits the current
  // placements. Reads real DOM rects of every rendered card + every
  // rendered bubble, converts them to flow space via
  // screenToFlowPosition. If a bubble's measured rect intersects a
// non-owner card, runs placeBubbles ONCE more with the measured rects
// and the measured bubble size (so placeBubbles cannot disagree with
// the rendered geometry by a 12-px label-induced overshoot). If a
// bubble STILL collides after that pass, adds its id to
// suppressedBubbleIds so BubbleLayer skips it. A reconciledRef guard
// prevents an infinite loop — cleared by computeAndSetPlacements (a
// new layout is coming in). useLayoutEffect (not useEffect) so the
// fix lands in the same paint frame as the violation.
  useLayoutEffect(() => {
    if (!bubblesOn) return;
    // No early return on reconciledRef: with sticky placement the placement
    // map no longer changes every tick, so a bubble whose rendered box grew
    // (new activity text, wider age) while its placement stayed put must
    // still be re-checked. The check is a handful of getBoundingClientRect
    // reads, and suppression is additive + set-guarded, so it cannot loop.
    if (!bubblePlacements.size) return;
    if (typeof window === 'undefined' || !window.document) return;
    // Detection runs in SCREEN pixels, the same units and the same
    // axis-aligned-gap metric the acceptance scripts use
    // (gap(bubble, card) = hypot(clamped dx, clamped dy); overlap when
    // gap < 1). Measuring in flow space (screenToFlowPosition) made the
    // detection blind at zoom != 1: a 0.9-px screen gap is 1.8 flow
    // units at zoom 0.5, so a fixed 1-flow-unit slack let it through
    // while the acceptance test flagged it. Screen pixels remove the
    // zoom from the equation entirely.
    const GAP_THRESHOLD_PX = 1;
    const axisGap = (a1, a2, b1, b2) => Math.max(0, Math.max(a1 - b2, b1 - a2));
    const cardEls = [...document.querySelectorAll('.react-flow__node')];
    const cardRects = new Map();                         // id -> DOMRect-ish {x,y,r,b}
    for (const el of cardEls) {
      const id = el.getAttribute('data-id');
      if (!id) continue;
      const r = el.getBoundingClientRect();
      cardRects.set(id, { x: r.left, y: r.top, r: r.right, b: r.bottom });
    }
    const bubbleEls = [...document.querySelectorAll('.react-flow__viewport .bubble')];
    // No bubbles in the DOM yet (placement state is set but the portal
    // render has not committed): do NOT arm the guard — arming it here
    // would let the very first pass, which saw zero bubbles, mark the
    // layout as reconciled and never check again. Retry on the next
    // positionsVersion tick, by which time the bubbles are committed.
    if (!bubbleEls.length) return;
    const newSuppressed = new Set();
    for (const el of bubbleEls) {
      const ownerId = el.getAttribute('data-owner-id');
      if (!ownerId) continue;
      const r = el.getBoundingClientRect();
      const bb = { x: r.left, y: r.top, r: r.right, b: r.bottom };
      for (const [cardId, cb] of cardRects) {
        if (cardId === ownerId) continue;
        const g = Math.hypot(axisGap(bb.x, bb.r, cb.x, cb.r), axisGap(bb.y, bb.b, cb.y, cb.b));
        if (g < GAP_THRESHOLD_PX) { newSuppressed.add(ownerId); break; }
      }
    }
    // Suppression is ADDITIVE and persistent within a layout's
    // lifetime. The suppression set ONLY resets when positionsRef
    // actually changes (see computeAndSetPlacements's signature
    // compare) — never when the DOM merely looks clean because the
    // suppressed bubbles are not rendering. Clearing on a clean DOM
    // would bring the offender back on the very next render and
    // oscillate the overlay forever.
    if (newSuppressed.size) {
      const merged = new Set(suppressedRef.current);
      for (const id of newSuppressed) merged.add(id);
      suppressedRef.current = merged;
      setSuppressedBubbleIds((prev) => {
        const next = new Set(prev);
        for (const id of newSuppressed) next.add(id);
        return next.size === prev.size ? prev : next;
      });
    }
    // Arm the guard ONLY when this pass found nothing to suppress. A
    // pass that just suppressed offenders must run again on the next
    // tick: the suppression render (and, after a Re-layout, the fitView
    // zoom animation) changes the geometry the next pass will measure,
    // and a guard armed on a mid-animation pass would freeze the stale
    // result. The tick loop is bounded in practice: after one clean
    // pass the guard arms and the effect idles until the next real
    // layout change.
    if (!newSuppressed.size) {
      reconciledRef.current = true;
    }
    // bubblePlacements is the trigger; positionsVersion resets the
    // guard via computeAndSetPlacements so the very next render re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bubblePlacements, positionsVersion, bubblesOn]);

  return (
    <div className="app">
      {/* The graph gets its own region and the panels sit beside it, never over
          it. Overlay panels slide under nodes on a force-directed canvas:
          reserving one strip (the right) still left a node hidden behind the
          legend and others behind the others. */}
      <div className="graph-area">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onNodeMouseEnter={onNodeMouseEnter}
          onNodeMouseLeave={onNodeMouseLeave}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodeOrigin={[0.5, 0.5]}
          minZoom={0.2}
          maxZoom={3}
          proOptions={{ hideAttribution: false }}
        >
          <FolderHulls hulls={liveHulls} meta={folderMeta}
                       onGroupDrag={onGroupDrag} dragRef={hullDragRef}
                       positionsRef={positionsRef} flowPointAt={flowPointAt} />
          <ParticleLayer />
          <BubbleLayer enabled={bubblesOn} nowMs={nowMs} candidates={nodes}
                       placements={bubblePlacements}
                       blockers={bubbleBlockers}
                       hoverId={hoverId}
                       suppressed={suppressedBubbleIds} />
          <Background color="#243040" gap={26} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      <aside className="side">
        <div className="card head">
          <h1>Fleet Monitor</h1>
          <div className="head-actions">
            <button type="button" className="relayout"
                    onClick={handleRelayout}
                    title="Re-run the force layout (wipes manual drags)">
              Re-layout
            </button>
            <button type="button" className={'toggle-bubbles' + (bubblesOn ? ' on' : ' off')}
                    onClick={toggleBubbles}
                    aria-pressed={bubblesOn}
                    title={bubblesOn ? 'Hide activity bubbles' : 'Show activity bubbles'}>
              Bubbles <span className="bubble-toggle-dot" aria-hidden="true" />
            </button>
          </div>
          <div className="stats">
            <span className="chip live">active <b>{stats.active ?? '–'}</b></span>
            <span className="chip">idle <b>{stats.idle ?? '–'}</b></span>
            <span className="chip monitor">monitoring <b>{stats.monitoring ?? '–'}</b></span>
            <span className="chip">sessions <b>{stats.sessions ?? '–'}</b></span>
            <span className="chip">agents <b>{stats.agents ?? '–'}</b></span>
            <span className="chip">folders <b>{stats.folders ?? '–'}</b></span>
          </div>
          <div className="conn">
            <span className={'dot' + (conn.up ? '' : ' off')} />{conn.text}
          </div>
        </div>

        <div className="card legend">
          {[
            { kind: 'folder', label: 'folder (group box)' },
            { kind: 'branch', label: 'branch' },
            { role: 'planner', label: 'planner' },
            { role: 'engineer', label: 'engineer' },
            { role: 'tester', label: 'tester' },
            { role: 'devops', label: 'devops' },
            { kind: 'session', label: 'Claude session' },
            { kind: 'hermes', label: 'Hermes' },
            { state: 'active', label: 'active (pulsing halo)' },
            { state: 'monitoring', label: 'monitoring (rotating ring)' },
            { state: 'idle', label: 'idle' },
          ].map((it) => (
            <div key={it.label}>
              <span className="swatch-bar" style={{ background: colorOf(it) }} />
              {it.label}
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Monitor />
    </ReactFlowProvider>
  );
}