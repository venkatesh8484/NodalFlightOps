// ─── Data-source provenance shown in the hover tooltip ─────────────────────
// Mirrors PostalOps' getDataSourceInfo cascade, mapped to aviation systems:
// which operational system a class's live records come from, how fresh they
// are, and under what handling policy.
function getDataSourceInfo(classId) {
  const lid = String(classId).toLowerCase();
  if (lid.includes('airport') || lid.includes('terminal') || lid.includes('gateway') || lid.includes('facility') || lid.includes('kiosk') || lid.includes('desk')) {
    return {
      sourceSystem: 'AODB (Airport Operational Database)',
      latency: 'Near real-time (stand/gate event-driven)',
      governance: 'Confidential (NL-OPS//SCHIPHOL clearance)',
    };
  }
  if (lid.includes('aircraft') || lid.includes('assignment')) {
    return {
      sourceSystem: 'AMOS Fleet Registry + ADS-B stream',
      latency: 'Real-time streaming (~10s position latency)',
      governance: 'Internal Telemetry (Fleet Ops access)',
    };
  }
  if (lid.includes('crew')) {
    return {
      sourceSystem: 'Crew Rostering (duty & qualification registry)',
      latency: 'Near real-time (roster event-driven)',
      governance: 'Restricted — personnel data',
    };
  }
  if (lid.includes('flight') || lid.includes('route')) {
    return {
      sourceSystem: 'FLIFO / Schedule Management System',
      latency: 'Near real-time (movement message driven)',
      governance: 'Commercial Confidential',
    };
  }
  if (lid.includes('airline') || lid.includes('iata')) {
    return {
      sourceSystem: 'IATA reference data + partner agreements',
      latency: 'Slowly changing (SCD Type 2)',
      governance: 'Commercial Accounts',
    };
  }
  if (lid.includes('telemetry') || lid.includes('event') || lid.includes('fault') || lid.includes('hold') || lid.includes('delay')) {
    return {
      sourceSystem: 'FLIFO movement messages / ACARS',
      latency: 'Real-time (< 2s message latency)',
      governance: 'Operational Event History',
    };
  }
  if (lid.includes('action')) {
    return {
      sourceSystem: 'Agent action registry (PSS / AODB / VMS writeback)',
      latency: 'On execution (human-in-the-loop gated)',
      governance: 'Audit-logged — approver role required',
    };
  }
  return {
    sourceSystem: 'OntologyEngine artifacts (src/data/0*.json)',
    latency: 'On publish from the OntologyEngine tab',
    governance: 'Internal — semantic layer',
  };
}

const NODE_RADIUS = (d) => Math.max(18, 14 + d.degree * 2.2);

const META_STROKE = (metaType) =>
  metaType === 'ACTION' ? '#10b981' : metaType === 'AUTO_RECORD' ? '#a855f7' : '#3b82f6';
const META_FILL = (metaType) =>
  metaType === 'ACTION' ? '#ecfdf5' : metaType === 'AUTO_RECORD' ? '#faf5ff' : '#eff6ff';
const META_FILL_SELECTED = (metaType) =>
  metaType === 'ACTION' ? '#d1fae5' : metaType === 'AUTO_RECORD' ? '#f3e8ff' : '#dbeafe';

export default function ExplorerTab() {
  const containerRef = useRef(null);
  const svgRef = useRef(null);
  const tooltipRef = useRef(null);
  const simulationRef = useRef(null);
  const zoomBehaviorRef = useRef(null);
  const hideTooltipTimer = useRef(null);

  const [expandedClasses, setExpandedClasses] = useState(() => new Set(Object.keys(ONTOLOGY_CLASSES)));
  const [selectedClass, setSelectedClass] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [resizeTick, setResizeTick] = useState(0);

  const stats = useMemo(
    () => ({ classes: Object.keys(ONTOLOGY_CLASSES).length, relations: ONTOLOGY_RELATIONS.length }),
    []
  );

  // Re-layout when the canvas resizes (panel collapse, window resize) — PostalOps
  // does this with an explorerResizeTick; a ResizeObserver is the same idea
  // without a manual trigger at every call site.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let frame = null;
    const observer = new ResizeObserver(() => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setResizeTick((t) => t + 1));
    });
    observer.observe(el);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  // ══════════════════════════════════════════════════════════════════════════
  // GRAPH BUILD EFFECT
  //
  // Deliberately depends ONLY on what changes the graph's TOPOLOGY
  // (expandedClasses) plus the canvas size. Selection and search are applied by
  // the two separate effects below.
  //
  // This matters for more than tidiness: the previous version listed
  // `selectedClass` and `searchQuery` here, so the first click of a double-click
  // triggered a state update that ran this effect, called
  // svg.selectAll('*').remove(), and rebuilt every node. The second click then
  // landed on a brand-new DOM element, so the browser never dispatched a
  // `dblclick` at all and expand/collapse silently did nothing. (PostalOps'
  // App.jsx has the same bug for the same reason.) Keeping selection and search
  // out of these deps is what makes double-click work — and stops the force
  // simulation restarting from scratch on every click.
  // ══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const container = containerRef.current;
    const svgEl = svgRef.current;
    if (!container || !svgEl) return undefined;

    const hasSubclasses = (className) =>
      Object.values(ONTOLOGY_CLASSES).some((cls) => cls.parentClass === className);

    // Only root classes are visible by default; a class's children are visible once
    // its parent is both visible AND in expandedClasses (starts fully expanded).
    const visibleClasses = new Set();
    Object.keys(ONTOLOGY_CLASSES).forEach((key) => {
      if (!ONTOLOGY_CLASSES[key].parentClass) visibleClasses.add(key);
    });
    let added = true;
    while (added) {
      added = false;
      Object.keys(ONTOLOGY_CLASSES).forEach((key) => {
        const cls = ONTOLOGY_CLASSES[key];
        if (cls.parentClass && expandedClasses.has(cls.parentClass) && visibleClasses.has(cls.parentClass) && !visibleClasses.has(key)) {
          visibleClasses.add(key);
          added = true;
        }
      });
    }
    const visibleKeys = Object.keys(ONTOLOGY_CLASSES).filter((key) => visibleClasses.has(key));

    const nodesData = visibleKeys.map((key) => {
      const cls = ONTOLOGY_CLASSES[key];
      const degree = ONTOLOGY_RELATIONS.filter((r) => r.source === key || r.target === key).length;
      return { id: key, name: cls.name, metaType: cls.metaType, color: cls.color, desc: cls.desc, degree };
    });
    const visibleRelations = ONTOLOGY_RELATIONS.filter((r) => visibleClasses.has(r.source) && visibleClasses.has(r.target));
    const linksData = visibleRelations.map((r) => ({ id: r.id, source: r.source, target: r.target, label: r.label, type: r.type }));

    const width = container.clientWidth || 900;
    const height = container.clientHeight || 640;

    const svg = d3.select(svgEl).attr('viewBox', [0, 0, width, height]);
    svg.selectAll('*').remove();

    // ── defs: arrow markers per relation type + glow filters ────────────────
    const defs = svg.append('defs');
    const addArrow = (id, fill) =>
      defs
        .append('marker')
        .attr('id', id)
        .attr('viewBox', '0 -5 10 10')
        .attr('refX', 22)
        .attr('refY', 0)
        .attr('markerWidth', 6)
        .attr('markerHeight', 6)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-4L8,0L0,4')
        .attr('fill', fill);

    addArrow('ontology-arrow', '#94a3b8');
    addArrow('ontology-arrow-structural', '#3b82f6');
    addArrow('ontology-arrow-action', '#047857');

    const addGlow = (id, deviation) => {
      const f = defs.append('filter').attr('id', id).attr('x', '-60%').attr('y', '-60%').attr('width', '220%').attr('height', '220%');
      f.append('feGaussianBlur').attr('stdDeviation', deviation).attr('result', 'blur');
      f.append('feMerge').selectAll('feMergeNode').data(['blur', 'SourceGraphic']).enter().append('feMergeNode').attr('in', (d) => d);
    };
    addGlow('glow-structural', 3);
    addGlow('glow-action', 3);

    const rootG = svg.append('g');

    const nodesCopy = nodesData.map((n) => ({ ...n }));
    const linksCopy = linksData.map((l) => ({ ...l }));

    const simulation = d3
      .forceSimulation(nodesCopy)
      .force('link', d3.forceLink(linksCopy).id((d) => d.id).distance(110).strength(0.55))
      .force('charge', d3.forceManyBody().strength(-260))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide().radius((d) => NODE_RADIUS(d) + 24));
    simulationRef.current = simulation;

    // ── links ───────────────────────────────────────────────────────────────
    const linkLayer = rootG.append('g').attr('class', 'links-layer');
    const linkElements = linkLayer
      .selectAll('path')
      .data(linksCopy)
      .join('path')
      .attr('class', 'link')
      .attr('fill', 'none')
      .attr('stroke', (d) => (d.type === 'action' ? '#10b981' : '#94a3b8'))
      .attr('stroke-width', (d) => (d.label === 'subClassOf' ? 1.6 : 1.2))
      .attr('stroke-dasharray', (d) => (d.label === 'subClassOf' ? null : '3,3'))
      .attr('marker-end', 'url(#ontology-arrow)')
      .style('cursor', 'pointer');

    // ── link labels (hidden until hover) ────────────────────────────────────
    const linkLabelLayer = rootG.append('g').attr('class', 'link-labels-layer');
    const linkLabelElements = linkLabelLayer
      .selectAll('g')
      .data(linksCopy)
      .join('g')
      .attr('class', 'link-label-group')
      .style('opacity', 0)
      .style('pointer-events', 'none');

    linkLabelElements
      .append('rect')
      .attr('rx', 3)
      .attr('fill', 'var(--paper)')
      .attr('stroke', 'var(--line)')
      .attr('height', 13);

    const linkLabelText = linkLabelElements
      .append('text')
      .text((d) => d.label)
      .attr('font-size', 8.5)
      .attr('font-family', 'var(--mono)')
      .attr('text-anchor', 'middle')
      .attr('dy', 3.2)
      .attr('fill', (d) => (d.type === 'action' ? '#047857' : '#1d4ed8'));

    // Size each label's backing rect to its rendered text.
    linkLabelElements.each(function () {
      const g = d3.select(this);
      const t = g.select('text').node();
      const w = t ? t.getComputedTextLength() + 8 : 30;
      g.select('rect').attr('width', w).attr('x', -w / 2).attr('y', -6.5);
    });

    // ── nodes ───────────────────────────────────────────────────────────────
    const nodeLayer = rootG.append('g').attr('class', 'nodes-layer');
    const nodeContainers = nodeLayer
      .selectAll('g.node-container')
      .data(nodesCopy)
      .join('g')
      .attr('class', 'node-container')
      .style('cursor', 'pointer')
      .style('filter', 'drop-shadow(0 3px 8px rgba(0,0,0,0.10))')
      .call(
        d3.drag()
          .on('start', (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x; d.fy = d.y;
          })
          .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
          .on('end', (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null; d.fy = null;
          })
      );

    nodeContainers
      .append('circle')
      .attr('class', 'node')
      .attr('r', NODE_RADIUS)
      .attr('fill', (d) => META_FILL(d.metaType))
      .attr('stroke', (d) => META_STROKE(d.metaType))
      .attr('stroke-width', 2.5);

    nodeContainers
      .append('path')
      .attr('class', 'node-icon')
      .attr('d', (d) => getIconPath(d.id))
      .attr('fill', 'none')
      .attr('stroke', (d) => (d.metaType === 'ACTION' ? '#047857' : d.metaType === 'AUTO_RECORD' ? '#7e22ce' : '#1d4ed8'))
      .attr('stroke-width', 1.5)
      .attr('stroke-linecap', 'round')
      .attr('stroke-linejoin', 'round')
      .style('pointer-events', 'none')
      .attr('transform', (d) => {
        const scale = (NODE_RADIUS(d) * 0.55) / 24;
        const offset = -12 * scale;
        return `translate(${offset}, ${offset}) scale(${scale})`;
      });

    const labelLayer = rootG.append('g').attr('class', 'labels-layer');
    const labelElements = labelLayer
      .selectAll('text')
      .data(nodesCopy)
      .join('text')
      .text((d) => d.name + (hasSubclasses(d.id) ? (expandedClasses.has(d.id) ? ' ⊖' : ' ⊕') : ''))
      .attr('text-anchor', 'middle')
      .attr('font-size', 9.5)
      .attr('font-family', 'var(--mono)')
      .attr('font-weight', 600)
      .attr('fill', 'var(--ink)')
      .style('pointer-events', 'none')
      .style('paint-order', 'stroke')
      .style('stroke', 'var(--paper)')
      .style('stroke-width', '3px');

    // ── hover: tooltip + neighbourhood highlight ────────────────────────────
    const linkEndId = (ref) => (typeof ref === 'object' && ref !== null ? ref.id : ref);

    const positionTooltip = (event) => {
      const tip = tooltipRef.current;
      if (!tip) return;
      const bounds = container.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      // Flip to the other side when close to an edge so the tooltip stays inside.
      const flipX = x + 270 > bounds.width;
      const flipY = y + 170 > bounds.height;
      tip.style.left = `${flipX ? Math.max(8, x - 262) : x + 14}px`;
      tip.style.top = `${flipY ? Math.max(8, y - 160) : y + 14}px`;
    };

    const resetHighlight = () => {
      linkLabelElements.style('opacity', 0);
      linkElements
        .style('opacity', 1)
        .attr('stroke-width', (l) => (l.label === 'subClassOf' ? 1.6 : 1.2))
        .attr('stroke', (l) => (l.type === 'action' ? '#10b981' : '#94a3b8'))
        .attr('marker-end', 'url(#ontology-arrow)')
        .style('filter', 'none');
      nodeContainers.style('opacity', 1);
      labelElements.style('opacity', 1);
    };

    nodeContainers
      .on('mouseover', (event, d) => {
        if (hideTooltipTimer.current) clearTimeout(hideTooltipTimer.current);

        const isNeighbour = (n) =>
          n.id === d.id ||
          linksCopy.some((l) => {
            const s = linkEndId(l.source);
            const t = linkEndId(l.target);
            return (s === d.id && t === n.id) || (t === d.id && s === n.id);
          });

        const touchesHovered = (l) => linkEndId(l.source) === d.id || linkEndId(l.target) === d.id;

        // Dim everything not in the hovered node's neighbourhood.
        nodeContainers.style('opacity', (n) => (isNeighbour(n) ? 1 : 0.15));
        labelElements.style('opacity', (n) => (isNeighbour(n) ? 1 : 0.15));

        linkElements
          .style('opacity', (l) => (touchesHovered(l) ? 1 : 0.12))
          .attr('stroke-width', (l) => (touchesHovered(l) ? 2.6 : 1))
          .attr('stroke', (l) => (touchesHovered(l) ? (l.type === 'action' ? '#047857' : '#3b82f6') : l.type === 'action' ? '#10b981' : '#94a3b8'))
          .attr('marker-end', (l) => (touchesHovered(l) ? (l.type === 'action' ? 'url(#ontology-arrow-action)' : 'url(#ontology-arrow-structural)') : 'url(#ontology-arrow)'))
          .style('filter', (l) => (touchesHovered(l) ? (l.type === 'action' ? 'url(#glow-action)' : 'url(#glow-structural)') : 'none'));

        // Reveal the verb on every edge touching this class.
        linkLabelElements.style('opacity', (l) => (touchesHovered(l) ? 1 : 0));

        const src = getDataSourceInfo(d.id);
        const tip = tooltipRef.current;
        if (tip) {
          tip.innerHTML = `
            <div style="border-bottom:1px solid var(--line); padding-bottom:5px; margin-bottom:6px; display:flex; align-items:center; justify-content:space-between; gap:8px;">
              <strong style="color:var(--ink); font-size:12px;">${d.name}</strong>
              <span style="background:${META_STROKE(d.metaType)}; color:#fff; font-size:8.5px; font-weight:700; padding:2px 5px; border-radius:3px; text-transform:uppercase; white-space:nowrap;">${d.metaType.replace(/_/g, ' ')}</span>
            </div>
            <div style="font-size:10px; color:var(--muted); margin-bottom:6px; line-height:1.45;">${d.desc || ''}</div>
            <div style="font-size:9px; color:var(--muted); line-height:1.55; border-top:1px dashed var(--line); padding-top:6px;">
              <strong style="color:var(--ink);">Data Source:</strong> <span style="color:#0284c7; font-weight:600;">${src.sourceSystem}</span><br>
              <strong style="color:var(--ink);">Data Freshness:</strong> <span style="color:#0284c7; font-weight:600;">${src.latency}</span><br>
              <strong style="color:var(--ink);">Handling Policy:</strong> <span style="color:#0284c7; font-weight:600;">${src.governance}</span><br>
              <strong style="color:var(--ink);">Degree:</strong> <span style="color:#0284c7; font-weight:600;">${d.degree} relation(s)</span>
            </div>`;
          tip.style.opacity = '0.97';
          positionTooltip(event);
        }

        // Auto-hide so the tooltip stops covering the graph while you study the
        // highlighted neighbourhood (PostalOps uses the same 3s timeout).
        hideTooltipTimer.current = setTimeout(() => {
          if (tooltipRef.current) tooltipRef.current.style.opacity = '0';
        }, 3000);
      })
      .on('mousemove', (event) => positionTooltip(event))
      .on('mouseout', () => {
        if (hideTooltipTimer.current) clearTimeout(hideTooltipTimer.current);
        resetHighlight();
        if (tooltipRef.current) tooltipRef.current.style.opacity = '0';
      })
      .on('click', (event, d) => {
        setSelectedClass(d.id);
        setSearchQuery('');
      })
      .on('dblclick', (event, d) => {
        event.stopPropagation(); // keep d3-zoom's dblclick-to-zoom from also firing
        if (!hasSubclasses(d.id)) return;
        setExpandedClasses((prev) => {
          const next = new Set(prev);
          if (next.has(d.id)) next.delete(d.id);
          else next.add(d.id);
          return next;
        });
      });

    // ── link hover: thicken, glow, reveal just that verb ────────────────────
    linkElements
      .on('mouseover', function hoverLink(event, d) {
        d3.select(this)
          .attr('stroke-width', 3.2)
          .attr('stroke', d.type === 'action' ? '#047857' : '#3b82f6')
          .attr('marker-end', d.type === 'action' ? 'url(#ontology-arrow-action)' : 'url(#ontology-arrow-structural)')
          .style('filter', d.type === 'action' ? 'url(#glow-action)' : 'url(#glow-structural)');
        linkLabelElements.style('opacity', (l) => (l.id === d.id ? 1 : 0));
      })
      .on('mouseout', () => resetHighlight());

    simulation.on('tick', () => {
      linkElements.attr('d', (d) => `M${d.source.x},${d.source.y} L${d.target.x},${d.target.y}`);
      linkLabelElements.attr('transform', (d) => `translate(${(d.source.x + d.target.x) / 2},${(d.source.y + d.target.y) / 2})`);
      nodeContainers.attr('transform', (d) => `translate(${d.x},${d.y})`);
      labelElements.attr('x', (d) => d.x).attr('y', (d) => d.y - (NODE_RADIUS(d) + 8));
    });

    const zoomBehavior = d3
      .zoom()
      .scaleExtent([0.2, 4])
      .on('zoom', (event) => rootG.attr('transform', event.transform));
    svg.call(zoomBehavior);
    // Disable d3-zoom's own dblclick-to-zoom so a double-click on empty canvas
    // doesn't fight the expand/collapse gesture on nodes.
    svg.on('dblclick.zoom', null);
    zoomBehaviorRef.current = zoomBehavior;

    return () => {
      if (hideTooltipTimer.current) clearTimeout(hideTooltipTimer.current);
      simulation.stop();
    };
  }, [expandedClasses, resizeTick]);

  // ── selection styling — applied WITHOUT rebuilding the graph ──────────────
  // Separate effect so clicking a node never destroys the SVG (see the note on
  // the build effect). Adds the same glowing halo the chat traversal panel uses.
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const svg = d3.select(svgEl);

    svg
      .selectAll('circle.node')
      .attr('stroke-width', (d) => (d.id === selectedClass ? 4.5 : 2.5))
      .attr('stroke', (d) => (d.id === selectedClass ? '#2563eb' : META_STROKE(d.metaType)))
      .attr('fill', (d) => (d.id === selectedClass ? META_FILL_SELECTED(d.metaType) : META_FILL(d.metaType)));

    svg
      .selectAll('g.node-container')
      .style('filter', (d) =>
        d.id === selectedClass ? 'drop-shadow(0 0 10px rgba(37,99,235,0.4))' : 'drop-shadow(0 3px 8px rgba(0,0,0,0.10))'
      );

    svg.selectAll('g.node-container').each(function eachNode(d) {
      const nodeG = d3.select(this);
      let halo = nodeG.select('circle.selection-halo');
      if (d.id === selectedClass) {
        if (halo.empty()) {
          halo = nodeG.insert('circle', ':first-child').attr('class', 'selection-halo ontology-pulse-ring');
        }
        halo
          .attr('r', NODE_RADIUS(d) + 6)
          .attr('fill', 'none')
          .attr('stroke', META_STROKE(d.metaType))
          .attr('stroke-width', 1.5)
          .style('filter', 'url(#glow-structural)')
          .style('display', null);
      } else if (!halo.empty()) {
        halo.style('display', 'none');
      }
    });
  }, [selectedClass, expandedClasses, resizeTick]);

  // ── search dimming — also applied without a rebuild ───────────────────────
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const svg = d3.select(svgEl);
    const q = searchQuery.trim().toLowerCase();
    const match = (d) => !q || d.name.toLowerCase().includes(q);
    svg.selectAll('g.node-container').style('opacity', (d) => (match(d) ? 1 : 0.15));
    svg.selectAll('g.labels-layer text').style('opacity', (d) => (match(d) ? 1 : 0.15));
  }, [searchQuery, expandedClasses, resizeTick]);

  function zoomBy(factor) {
    const svg = d3.select(svgRef.current);
    if (zoomBehaviorRef.current) svg.transition().duration(200).call(zoomBehaviorRef.current.scaleBy, factor);
  }

  function resetView() {
    const svg = d3.select(svgRef.current);
    if (zoomBehaviorRef.current) svg.transition().duration(300).call(zoomBehaviorRef.current.transform, d3.zoomIdentity);
  }

  return (
    <div style={{ display: 'flex', height: '100%', boxSizing: 'border-box' }}>
      <style>{`
        @keyframes ontologyPulseRing {
          0%, 100% { opacity: 0.28; }
          50%      { opacity: 0.85; }
        }
        .ontology-pulse-ring {
          animation: ontologyPulseRing 1.8s ease-in-out infinite;
          pointer-events: none;
        }
        .ontology-graph-tooltip {
          background: var(--paper);
          border: 1px solid var(--line-strong);
          color: var(--ink);
          padding: 10px 12px;
          border-radius: 8px;
          font-size: 11px;
          font-family: var(--sans);
          width: 248px;
          box-shadow: 0 6px 18px rgba(15, 23, 42, 0.12);
          pointer-events: none;
          position: absolute;
          opacity: 0;
          z-index: 1000;
          transition: opacity 0.15s ease;
        }
      `}</style>

      {/* LEFT — legend */}
      <div style={{ width: '230px', flexShrink: 0, borderRight: '1px solid var(--line)', padding: '14px', overflowY: 'auto', background: 'var(--surface)' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
          Ontology Legend
        </div>
        <div style={{ maxHeight: '260px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' }}>
          {Object.values(ONTOLOGY_CLASSES).map((cls) => (
            <div key={cls.name} style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '11px', color: 'var(--ink)' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: cls.color, flexShrink: 0 }} />
              <span style={{ opacity: cls.parentClass ? 0.7 : 1 }}>{cls.name}</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
          Graph Stats
        </div>
        <div style={{ fontSize: '11px', color: 'var(--muted)', lineHeight: 1.8, fontFamily: 'var(--mono)' }}>
          {stats.classes} ontology classes<br />
          {stats.relations} semantic relations
        </div>
        <div style={{ marginTop: '14px', fontSize: '10px', color: 'var(--muted-2)', lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--muted)' }}>Hover</strong> a class for its data source and to highlight its
          neighbourhood. <strong style={{ color: 'var(--muted)' }}>Click</strong> to inspect it.{' '}
          <strong style={{ color: 'var(--muted)' }}>Double-click</strong> an expandable class (⊕/⊖) to reveal or collapse
          its narrower terms. <strong style={{ color: 'var(--muted)' }}>Drag</strong> to reposition, scroll to zoom.
        </div>
      </div>

      {/* CENTER — graph canvas */}
      <div ref={containerRef} style={{ flex: 1, position: 'relative', background: 'var(--paper)', minWidth: 0 }}>
        <div style={{ position: 'absolute', top: '12px', left: '12px', right: '12px', zIndex: 5, display: 'flex', gap: '8px' }}>
          <div style={{ position: 'relative', flex: 1, maxWidth: '320px' }}>
            <Search size={13} style={{ position: 'absolute', left: '9px', top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-2)' }} />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search a class or concept…"
              style={{
                width: '100%', padding: '7px 10px 7px 28px', fontSize: '12px',
                border: '1px solid var(--line)', borderRadius: '8px',
                background: 'var(--surface)', color: 'var(--ink)', boxSizing: 'border-box',
                fontFamily: 'var(--mono)',
              }}
            />
          </div>
          <div style={{ display: 'flex', gap: '4px' }}>
            <button onClick={() => zoomBy(1.4)} style={iconBtn} title="Zoom in"><ZoomIn size={14} /></button>
            <button onClick={() => zoomBy(0.7)} style={iconBtn} title="Zoom out"><ZoomOut size={14} /></button>
            <button onClick={resetView} style={iconBtn} title="Reset view"><Maximize2 size={14} /></button>
            {panelCollapsed && (
              <button onClick={() => setPanelCollapsed(false)} style={iconBtn} title="Show class inspector">
                <ChevronLeft size={14} />
              </button>
            )}
          </div>
        </div>

        <svg ref={svgRef} width="100%" height="100%" />

        {/* Hover tooltip — an HTML overlay, so it can carry rich provenance markup */}
        <div ref={tooltipRef} className="ontology-graph-tooltip" />
      </div>

      {/* RIGHT — detail panel (collapsible, so the graph can go full-width) */}
      {!panelCollapsed && (
        <div style={{ width: '320px', flexShrink: 0, borderLeft: '1px solid var(--line)', background: 'var(--surface)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', padding: '12px 14px', borderBottom: '1px solid var(--line)', fontSize: '12px', fontWeight: 700, color: 'var(--ink)', flexShrink: 0 }}>
            <span>Class Inspector</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              {selectedClass && (
                <button onClick={() => setSelectedClass(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }} title="Clear selection">
                  <X size={14} />
                </button>
              )}
              <button onClick={() => setPanelCollapsed(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }} title="Collapse panel — view the graph full width">
                <ChevronRight size={16} />
              </button>
            </span>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <DetailPanel node={selectedClass ? { id: selectedClass } : null} onSelect={setSelectedClass} />
          </div>
        </div>
      )}
    </div>
  );
}

const iconBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: '30px', height: '30px', border: '1px solid var(--line)', borderRadius: '8px',
  background: 'var(--surface)', color: 'var(--ink)', cursor: 'pointer',
};
