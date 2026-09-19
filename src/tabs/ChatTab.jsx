// ============================================
// Chat tab — "Ask FlightOps" (Knowledge Agent)
// ============================================
// Grounded on the live Knowledge Graph via kg.toAgentContext() AND on the six
// artifacts the OntologyEngine writes to src/data/ (controlled vocabulary,
// metadata standard, taxonomy, thesaurus, ontology, knowledge graph). With an
// AI provider key configured (Settings) questions go to that provider with all
// of it as grounding; with no key it falls back to a deterministic KG-only
// answer engine.
//
// Every answer gets a GRAPH TRAVERSAL panel — a D3 force-directed sub-graph
// showing which ontology classes and live records the answer was derived from,
// plus the reasoning log for that turn. The panel's nodes and edges come from
// src/lib/ontologyBackbone.js — the same backbone the Explorer tab renders — so
// the chat's graph is provably the same graph, not a separate illustration.
// Ported from PostalOps' App.jsx chat workspace.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import {
  Send,
  Bot,
  User,
  Loader2,
  Network,
  KeyRound,
  Compass,
  Activity,
  Maximize2,
  Minimize2,
  X,
  Cpu,
} from 'lucide-react';

import { getKnowledgeGraph } from '../lib/knowledgeGraph.js';
import { predictAirportLoad } from '../lib/delayPredictor.js';
import { callProviderChat } from '../ontologyEngine/aiClient.js';
import {
  buildTraversalGraphFromAnswer,
  genericKgOverviewGraph,
  kgClassNode,
  kgInstanceNode,
  kgInstanceLink,
} from '../lib/ontologyBackbone.js';

import controlledVocab from '../data/01_controlled_vocabulary.json';
import taxonomy from '../data/03_taxonomy.json';
import thesaurus from '../data/04_thesaurus.json';
import ontologySchema from '../data/05_ontology.json';

const AGENT_SYSTEM_PROMPT = `You are the FlightOps Knowledge Agent — an expert system for KLM's Amsterdam Schiphol (AMS) hub flight operations. You reason by traversing the FlightOps Knowledge Graph: Airports, FlightRoutes, Flights (the passenger-connection at-risk entity) and Aircraft. You are precise, professional, and always show your graph-based reasoning chain. You handle airport gate utilization, routes, flight delays, passenger connection risk, aircraft assignment, and recovery/rebooking decisions. ALWAYS answer the user's actual question directly in the very first sentence — if they ask "how many", for a count, or for a specific value, state that number or value up front — and only then add supporting tables, detail, or your reasoning chain. You are given the LIVE knowledge graph data (not a fixed example) — every answer must be recomputed from the data you were actually given this turn, never recalled from memory of a typical example. Two differently-worded questions almost always require reading different fields or sorting differently (e.g. "busiest" = MAX(utilization), "most delayed" = MAX(delayMinutes), "how many X" = COUNT(X)) — never return the same answer body for two differently-worded questions unless the data genuinely makes them equivalent. When a question asks for a maximum, minimum, or ranking, name the single specific entity (its id and name) that answers it in your first sentence, and state the exact field value you used, before showing any supporting table. Respond in clean Markdown.`;

const SUGGESTED_PROMPTS = [
  { label: 'AMS hub status', text: 'What is the current status and gate utilization at AMS?' },
  { label: 'Delayed inbound', text: 'Which inbound flights are delayed and by how much?' },
  { label: 'Connection risk', text: 'Which onward connections are at risk under the 50-minute MCT?' },
  { label: 'Busiest airport', text: 'Which airport has the highest gate utilization right now?' },
  { label: 'Fleet breakdown', text: 'Break down the fleet by aircraft type and status.' },
  { label: 'Standby aircraft', text: 'Which aircraft are on standby and where are they based?' },
  { label: 'Ontology schema', text: 'Explain the ontology class relations in the FlightOps graph.' },
];

// ───────────────────────────────────────────────────────────────────────────
// Markdown rendering for agent bubbles (ported from PostalOps)
// ───────────────────────────────────────────────────────────────────────────

function parseInlineMarkdown(text) {
  if (!text) return '';
  let tokens = [{ type: 'text', val: text }];

  // Bold
  let next = [];
  tokens.forEach((tok) => {
    if (tok.type !== 'text') return next.push(tok);
    tok.val.split(/\*\*/g).forEach((s, idx) => {
      if (idx % 2 === 1) next.push({ type: 'bold', val: s });
      else if (s) next.push({ type: 'text', val: s });
    });
  });
  tokens = next;

  // Inline code
  next = [];
  tokens.forEach((tok) => {
    if (tok.type !== 'text') return next.push(tok);
    tok.val.split(/`/g).forEach((s, idx) => {
      if (idx % 2 === 1) next.push({ type: 'code', val: s });
      else if (s) next.push({ type: 'text', val: s });
    });
  });
  tokens = next;

  return tokens.map((tok, i) => {
    if (tok.type === 'bold') return <strong key={i}>{tok.val}</strong>;
    if (tok.type === 'code') {
      return (
        <code
          key={i}
          style={{
            fontFamily: 'var(--mono, monospace)',
            fontSize: '0.92em',
            padding: '1px 4px',
            borderRadius: '4px',
            background: 'var(--surface-3)',
          }}
        >
          {tok.val}
        </code>
      );
    }
    return tok.val;
  });
}

function renderTable(rows, key) {
  const parsed = rows.map((r) =>
    r
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell, idx, arr) => idx > 0 && idx < arr.length - 1)
  );
  if (parsed.length === 0) return null;

  const headerRow = parsed[0];
  let dataRows = parsed.slice(1);
  if (dataRows.length > 0 && dataRows[0].every((cell) => /^:?-{2,}:?$/.test(cell))) {
    dataRows = dataRows.slice(1);
  }

  return (
    <div key={key} style={{ overflowX: 'auto', margin: '10px 0' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11.5px', border: '1px solid var(--line)' }}>
        <thead>
          <tr style={{ background: 'var(--surface-2, var(--surface-3))' }}>
            {headerRow.map((cell, i) => (
              <th key={i} style={{ padding: '6px 8px', border: '1px solid var(--line)', fontWeight: 600, textAlign: 'left' }}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataRows.map((row, r) => (
            <tr key={r} style={{ background: r % 2 === 0 ? 'var(--paper)' : 'var(--surface)' }}>
              {row.map((cell, c) => (
                <td key={c} style={{ padding: '6px 8px', border: '1px solid var(--line)' }}>
                  {parseInlineMarkdown(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderMarkdown(text) {
  if (!text) return null;
  const lines = text.split('\n');
  const out = [];
  let tableRows = [];

  const flushTable = (i) => {
    if (tableRows.length > 0) {
      out.push(renderTable(tableRows, `tbl-${i}`));
      tableRows = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('|') && line.endsWith('|')) {
      tableRows.push(line);
      continue;
    }
    flushTable(i);

    if (line.startsWith('```')) {
      let code = '';
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        code += `${lines[i]}\n`;
        i++;
      }
      out.push(
        <pre
          key={`code-${i}`}
          style={{
            background: '#1e293b',
            color: '#f8fafc',
            padding: '10px',
            borderRadius: '6px',
            overflowX: 'auto',
            margin: '8px 0',
            fontFamily: 'var(--mono, monospace)',
            fontSize: '11px',
          }}
        >
          <code>{code}</code>
        </pre>
      );
      continue;
    }

    if (line.startsWith('### ')) {
      out.push(<h4 key={`h3-${i}`} style={{ margin: '12px 0 6px', fontWeight: 600, fontSize: '13px' }}>{parseInlineMarkdown(line.slice(4))}</h4>);
      continue;
    }
    if (line.startsWith('## ')) {
      out.push(<h3 key={`h2-${i}`} style={{ margin: '14px 0 8px', fontWeight: 700, fontSize: '14px' }}>{parseInlineMarkdown(line.slice(3))}</h3>);
      continue;
    }
    if (line.startsWith('# ')) {
      out.push(<h2 key={`h1-${i}`} style={{ margin: '16px 0 10px', fontWeight: 800, fontSize: '15px' }}>{parseInlineMarkdown(line.slice(2))}</h2>);
      continue;
    }
    if (line.startsWith('* ') || line.startsWith('- ')) {
      out.push(<li key={`li-${i}`} style={{ marginLeft: '14px', listStyleType: 'disc', margin: '3px 0 3px 14px' }}>{parseInlineMarkdown(line.slice(2))}</li>);
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      out.push(
        <li key={`ol-${i}`} style={{ marginLeft: '14px', listStyleType: 'decimal', margin: '3px 0 3px 14px' }}>
          {parseInlineMarkdown(line.replace(/^\d+\.\s/, ''))}
        </li>
      );
      continue;
    }
    if (line) {
      out.push(<p key={`p-${i}`} style={{ margin: '0 0 8px', lineHeight: 1.55 }}>{parseInlineMarkdown(line)}</p>);
    }
  }

  flushTable('end');
  return <div>{out}</div>;
}

// ───────────────────────────────────────────────────────────────────────────
// Deterministic, no-LLM fallback engine — KG-grounded, with traversal graphs
// ───────────────────────────────────────────────────────────────────────────

function answerFromKgOnly(kg, question) {
  const q = question.toLowerCase();
  const flights = kg.getAllFlights();
  const airports = kg.getAllAirports();
  const aircraft = kg.getAllAircraft();

  const logs = [
    { type: 'info', text: `QUERY · "${question}"` },
    { type: 'kg', text: 'KG INIT · Loading 06_knowledge_graph.json + 05_ontology.json' },
  ];

  // COUNT questions
  if (/\b(how many|number of|count of|total number of)\b/.test(q)) {
    if (/flight/.test(q)) {
      logs.push({ type: 'kg', text: 'TRAVERSE · Flight → hasRecord → all instances' });
      logs.push({ type: 'success', text: `RESOLVED · COUNT(Flight instances) = ${flights.length}` });
      return {
        text: `**There are ${flights.length} flights** in the current knowledge graph.`,
        logs,
        traversalGraph: {
          nodes: [kgClassNode('Flight'), ...flights.slice(0, 8).map((f) => kgInstanceNode(f.id, f.id, f.status === 'AT_RISK' ? 'critical' : 'normal'))],
          edges: flights.slice(0, 8).map((f) => kgInstanceLink('Flight', f.id)),
          walkPath: ['Flight', ...flights.slice(0, 8).map((f) => f.id)],
        },
      };
    }
    if (/airport|hub/.test(q)) {
      logs.push({ type: 'kg', text: 'TRAVERSE · Airport → hasRecord → all instances' });
      logs.push({ type: 'success', text: `RESOLVED · COUNT(Airport instances) = ${airports.length}` });
      return {
        text: `**There are ${airports.length} airports** in the network — ${airports.filter((a) => a.role === 'HUB').length} hub, ${airports.filter((a) => a.role !== 'HUB').length} spoke.`,
        logs,
        traversalGraph: {
          nodes: [kgClassNode('Airport'), ...airports.map((a) => kgInstanceNode(a.id, a.id, a.status !== 'OPERATIONAL' ? 'critical' : 'normal'))],
          edges: airports.map((a) => kgInstanceLink('Airport', a.id)),
          walkPath: ['Airport', ...airports.map((a) => a.id)],
        },
      };
    }
    if (/aircraft|tail|fleet/.test(q)) {
      logs.push({ type: 'db', text: 'DB QUERY · aircraft.csv — COUNT(*)' });
      logs.push({ type: 'success', text: `RESOLVED · COUNT(Aircraft) = ${aircraft.length}` });
      return {
        text: `**There are ${aircraft.length} aircraft** in the active fleet.`,
        logs,
        traversalGraph: {
          nodes: [kgClassNode('Aircraft'), ...aircraft.slice(0, 8).map((a) => kgInstanceNode(a.id, a.id, 'normal'))],
          edges: aircraft.slice(0, 8).map((a) => kgInstanceLink('Aircraft', a.id)),
          walkPath: ['Aircraft', ...aircraft.slice(0, 8).map((a) => a.id)],
        },
      };
    }
  }

  // DELAY / RISK
  if (/(delay|at.?risk|disrupt|connection)/.test(q)) {
    const delayed = flights.filter((f) => f.delayMinutes > 0).sort((a, b) => b.delayMinutes - a.delayMinutes);
    logs.push({ type: 'kg', text: 'TRAVERSE · Flight → hasDelay → Telemetry Event' });

    if (delayed.length === 0) {
      logs.push({ type: 'success', text: 'RESOLVED · No flights with delayMinutes > 0' });
      return { text: 'No flights are currently delayed.', logs, traversalGraph: genericKgOverviewGraph() };
    }

    const worst = delayed[0];
    logs.push({ type: 'success', text: `RESOLVED · MAX(delayMinutes) = ${worst.delayMinutes} on ${worst.id}` });

    const rows = delayed
      .map((f) => `| ${f.id} | ${f.originAirportId} → ${f.destinationAirportId} | +${f.delayMinutes}m | ${f.connectionRiskTier} | ${f.status} |`)
      .join('\n');

    return {
      text: `**${delayed.length} flight(s) are currently delayed.** The most delayed is **${worst.id}** at **+${worst.delayMinutes} minutes** (${worst.status}).

| Flight | Leg | Delay | Risk tier | Status |
|---|---|---|---|---|
${rows}`,
      logs,
      traversalGraph: {
        nodes: [
          kgClassNode('Flight'),
          ...delayed.slice(0, 8).map((f) => kgInstanceNode(f.id, f.id, f.status === 'AT_RISK' ? 'critical' : 'action')),
        ],
        edges: delayed.slice(0, 8).map((f) => kgInstanceLink('Flight', f.id)),
        walkPath: ['Flight', ...delayed.slice(0, 8).map((f) => f.id)],
      },
    };
  }

  // UTILIZATION / BUSIEST
  if (/(busiest|utilization|congest|saturat|capacity|headroom)/.test(q)) {
    const { predictions } = predictAirportLoad(kg, 1.0);
    const ranked = [...predictions].sort((a, b) => b.utilizationPct - a.utilizationPct);
    const busiest = ranked[0];
    logs.push({ type: 'kg', text: 'TRAVERSE · Airport → hasCapacity → utilization projection' });
    logs.push({ type: 'success', text: `RESOLVED · MAX(utilizationPct) = ${busiest.utilizationPct}% at ${busiest.airportId}` });

    const rows = ranked
      .map((p) => `| ${p.airportId} | ${p.airportName} | ${p.utilizationPct}% | ${p.status} |`)
      .join('\n');

    return {
      text: `**${busiest.airportName} (${busiest.airportId})** is the busiest airport at **${busiest.utilizationPct}% gate utilization** (${busiest.status}).

| Airport | Name | Utilization | Status |
|---|---|---|---|
${rows}`,
      logs,
      traversalGraph: {
        nodes: [kgClassNode('Airport'), ...ranked.slice(0, 8).map((p) => kgInstanceNode(p.airportId, p.airportId, p.utilizationPct >= 85 ? 'critical' : p.utilizationPct < 60 ? 'healthy' : 'normal'))],
        edges: ranked.slice(0, 8).map((p) => kgInstanceLink('Airport', p.airportId)),
        walkPath: ['Airport', ...ranked.slice(0, 8).map((p) => p.airportId)],
      },
    };
  }

  // FLEET
  if (/aircraft|tail|fleet|standby/.test(q)) {
    const byType = {};
    aircraft.forEach((a) => {
      byType[a.aircraftType] = (byType[a.aircraftType] || 0) + 1;
    });
    logs.push({ type: 'db', text: 'DB QUERY · aircraft.csv — GROUP BY aircraft_type' });
    logs.push({ type: 'success', text: `RESOLVED · ${aircraft.length} aircraft across ${Object.keys(byType).length} type(s)` });

    const rows = Object.entries(byType).map(([t, c]) => `| ${t} | ${c} |`).join('\n');
    return {
      text: `**There are ${aircraft.length} aircraft** in the fleet.

| Type | Count |
|---|---|
${rows}`,
      logs,
      traversalGraph: {
        nodes: [kgClassNode('Aircraft'), ...aircraft.slice(0, 8).map((a) => kgInstanceNode(a.id, a.id, a.status === 'STANDBY' ? 'healthy' : 'normal'))],
        edges: aircraft.slice(0, 8).map((a) => kgInstanceLink('Aircraft', a.id)),
        walkPath: ['Aircraft', ...aircraft.slice(0, 8).map((a) => a.id)],
      },
    };
  }

  // SPECIFIC AIRPORT
  const airportMatch = airports.find((a) => new RegExp(`\\b${a.id}\\b`, 'i').test(question) || q.includes((a.city || '').toLowerCase()));
  if (airportMatch) {
    logs.push({ type: 'kg', text: `TRAVERSE · Airport → hasRecord → instance:${airportMatch.id}` });
    logs.push({ type: 'success', text: `RESOLVED · status=${airportMatch.status}, utilization=${airportMatch.currentUtilizationPct}%` });
    return {
      text: `**${airportMatch.name} (${airportMatch.id})** is **${airportMatch.status}** — running at **${airportMatch.currentUtilizationPct}% gate utilization**, with ${airportMatch.freeGates} of ${airportMatch.gates} gates free.`,
      logs,
      traversalGraph: {
        nodes: [kgClassNode('Airport'), kgInstanceNode(airportMatch.id, airportMatch.id, airportMatch.status !== 'OPERATIONAL' ? 'critical' : 'normal')],
        edges: [kgInstanceLink('Airport', airportMatch.id)],
        walkPath: ['Airport', airportMatch.id],
      },
    };
  }

  // SPECIFIC FLIGHT
  const flightMatch = flights.find((f) => new RegExp(`\\b${f.id}\\b`, 'i').test(question));
  if (flightMatch) {
    const risk = kg.computeConnectionRisk(flightMatch.id);
    const atRisk = risk.filter((r) => r.atRisk);
    logs.push({ type: 'kg', text: `TRAVERSE · Flight → hasRecord → instance:${flightMatch.id}` });
    logs.push({ type: 'kg', text: 'TRAVERSE · Flight → connectsTo → onward Flight (MCT check)' });
    logs.push({ type: 'success', text: `RESOLVED · ${atRisk.length} onward connection(s) below MCT` });
    return {
      text: `**${flightMatch.id}** (${flightMatch.originAirportId} → ${flightMatch.destinationAirportId}) is **${flightMatch.status}** with **+${flightMatch.delayMinutes}m** delay and ${flightMatch.paxCount} passengers aboard. **${atRisk.length} onward connection(s) are at risk.**`,
      logs,
      traversalGraph: {
        nodes: [
          kgClassNode('Flight'),
          kgInstanceNode(flightMatch.id, flightMatch.id, flightMatch.status === 'AT_RISK' ? 'critical' : 'normal'),
          ...atRisk.slice(0, 5).map((r) => kgInstanceNode(r.onwardFlightId, r.onwardFlightId, 'critical')),
        ],
        edges: [
          kgInstanceLink('Flight', flightMatch.id),
          ...atRisk.slice(0, 5).map((r) => ({ source: flightMatch.id, target: r.onwardFlightId, label: 'connectsTo', kind: 'relation' })),
        ],
        walkPath: [flightMatch.id, ...atRisk.slice(0, 5).map((r) => r.onwardFlightId)],
      },
    };
  }

  logs.push({ type: 'warn', text: 'No matching KG query pattern — returned capability summary.' });
  return {
    text: `I can answer questions about the **${flights.length} flights**, **${airports.length} airports** and **${aircraft.length} aircraft** in the live knowledge graph. Try asking about delays, connection risk, gate utilization, or a specific flight/airport code (e.g. "status of KL1008"). Configure an AI provider key in Settings for open-ended reasoning over the full graph and the OntologyEngine artifacts.`,
    logs,
    traversalGraph: genericKgOverviewGraph(),
  };
}

// ───────────────────────────────────────────────────────────────────────────

export default function ChatTab({ aiConfig, onOpenSettings }) {
  const kg = getKnowledgeGraph();
  const hasApiKey = Boolean(aiConfig?.apiKey);

  const [messages, setMessages] = useState(() => [
    {
      id: 1,
      sender: 'agent',
      text: `Hi, I'm the **FlightOps Knowledge Agent**. I reason over the live flight-operations knowledge graph — airports, routes, flights and aircraft — together with the ontology artifacts produced by the OntologyEngine. Ask me anything about the network, then open **Graph Traversal** on any answer to see exactly which classes and records it came from.`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      reasoningLogs: [{ type: 'info', text: 'SESSION · Knowledge Agent ready' }],
      traversalGraph: genericKgOverviewGraph(),
    },
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [activeMessageId, setActiveMessageId] = useState(1);
  const [graphPanelOpen, setGraphPanelOpen] = useState(true);
  const [graphPanelExpanded, setGraphPanelExpanded] = useState(false);

  const scrollRef = useRef(null);
  const graphSvgRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, isTyping]);

  const activeMsg = useMemo(
    () => messages.find((m) => m.id === activeMessageId) || null,
    [messages, activeMessageId]
  );

  // ─── D3 traversal renderer ───────────────────────────────────────────────
  // Draws the active answer's traversal sub-graph: ontology classes as larger
  // nodes coloured by metaType, live records as smaller nodes coloured by
  // status, walk-path nodes glowing and numbered in visit order.
  useEffect(() => {
    if (!graphPanelOpen || !graphSvgRef.current) return;

    const svgEl = graphSvgRef.current;
    d3.select(svgEl).selectAll('*').remove();

    const graph = activeMsg?.traversalGraph;
    if (!graph) return;

    const container = svgEl.parentElement;
    const width = container?.clientWidth || 360;
    const height = container?.clientHeight || 400;

    const svg = d3.select(svgEl).attr('width', width).attr('height', height);
    const defs = svg.append('defs');

    // Grid backdrop — same visual language as the Explorer canvas
    defs
      .append('pattern')
      .attr('id', 'travGridPattern')
      .attr('width', 32)
      .attr('height', 32)
      .attr('patternUnits', 'userSpaceOnUse')
      .append('path')
      .attr('d', 'M 32 0 L 0 0 0 32')
      .attr('fill', 'none')
      .attr('stroke', 'rgba(99, 102, 241, 0.08)')
      .attr('stroke-width', 1);

    svg
      .append('rect')
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('fill', 'url(#travGridPattern)')
      .style('pointer-events', 'none');

    const arrow = (id, fill, size) =>
      defs
        .append('marker')
        .attr('id', id)
        .attr('viewBox', '0 -5 10 10')
        .attr('refX', 24)
        .attr('refY', 0)
        .attr('markerWidth', size)
        .attr('markerHeight', size)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-4L8,0L0,4')
        .attr('fill', fill);

    arrow('trav-arrow', '#94a3b8', 6);
    arrow('trav-arrow-active', '#6366f1', 7);

    const glow = defs
      .append('filter')
      .attr('id', 'glow-traversal')
      .attr('x', '-60%')
      .attr('y', '-60%')
      .attr('width', '220%')
      .attr('height', '220%');
    glow.append('feGaussianBlur').attr('stdDeviation', '3.5').attr('result', 'blur');
    glow
      .append('feMerge')
      .selectAll('feMergeNode')
      .data(['blur', 'SourceGraphic'])
      .enter()
      .append('feMergeNode')
      .attr('in', (d) => d);

    const walkSet = new Set(graph.walkPath || []);

    // Which edges lie along the walk path — those are drawn lit up.
    const walkEdges = new Set();
    if (graph.walkPath && graph.walkPath.length > 1) {
      for (let i = 0; i < graph.walkPath.length - 1; i++) {
        const s = graph.walkPath[i];
        const t = graph.walkPath[i + 1];
        graph.edges.forEach((e, idx) => {
          if ((e.source === s && e.target === t) || (e.source === t && e.target === s)) walkEdges.add(idx);
        });
      }
    }

    const classFill = (metaType) =>
      metaType === 'ACTION' ? '#ecfdf5' : metaType === 'AUTO_RECORD' ? '#faf5ff' : '#eff6ff';
    const classStroke = (metaType) =>
      metaType === 'ACTION' ? '#10b981' : metaType === 'AUTO_RECORD' ? '#a855f7' : '#3b82f6';
    const statusStroke = (status) =>
      status === 'critical' ? '#ef4444' : status === 'healthy' ? '#22c55e' : status === 'action' ? '#f59e0b' : '#94a3b8';
    const statusFill = (status) =>
      status === 'critical' ? '#fef2f2' : status === 'healthy' ? '#f0fdf4' : status === 'action' ? '#fffbeb' : '#f8fafc';

    const nodeStroke = (d) => (d.kind === 'instance' ? statusStroke(d.status) : classStroke(d.metaType));
    const nodeFill = (d) => (d.kind === 'instance' ? statusFill(d.status) : classFill(d.metaType));

    // Only keep edges whose endpoints are both present, so d3.forceLink can't
    // throw on a dangling id.
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    const nodeData = graph.nodes.map((n) => ({ ...n }));
    const edgeData = graph.edges
      .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
      .map((e, i) => ({ ...e, idx: i }));

    const simulation = d3
      .forceSimulation(nodeData)
      .force('link', d3.forceLink(edgeData).id((d) => d.id).distance((d) => (d.kind === 'instance' ? 70 : 110)).strength(0.6))
      .force('charge', d3.forceManyBody().strength(-320))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide(42));

    const g = svg.append('g');
    svg.call(d3.zoom().scaleExtent([0.3, 3]).on('zoom', (event) => g.attr('transform', event.transform)));

    const linkGroup = g.selectAll('.trav-link').data(edgeData).enter().append('g');

    const linkLines = linkGroup
      .append('line')
      .attr('stroke', (d) => (walkEdges.has(d.idx) ? '#6366f1' : d.kind === 'instance' ? '#cbd5e1' : '#94a3b8'))
      .attr('stroke-width', (d) => (walkEdges.has(d.idx) ? 2.5 : 1.25))
      .attr('stroke-dasharray', (d) => (d.kind === 'instance' ? '3,3' : null))
      .attr('stroke-opacity', (d) => (walkEdges.has(d.idx) ? 1 : 0.7))
      .attr('marker-end', (d) => (walkEdges.has(d.idx) ? 'url(#trav-arrow-active)' : 'url(#trav-arrow)'))
      .style('filter', (d) => (walkEdges.has(d.idx) ? 'url(#glow-traversal)' : 'none'));

    const linkLabels = linkGroup
      .append('text')
      .text((d) => d.label)
      .attr('font-size', '8px')
      .attr('fill', (d) => (walkEdges.has(d.idx) ? '#4f46e5' : '#64748b'))
      .attr('text-anchor', 'middle')
      .attr('dy', -4)
      .attr('font-family', 'var(--mono, monospace)')
      .attr('font-weight', (d) => (walkEdges.has(d.idx) ? '700' : '400'))
      .style('paint-order', 'stroke')
      .style('stroke', '#f8fafc')
      .style('stroke-width', '3px');

    const nodeGroup = g
      .selectAll('.trav-node')
      .data(nodeData)
      .enter()
      .append('g')
      .style('cursor', 'pointer')
      .style('filter', 'drop-shadow(0 2px 5px rgba(15,23,42,0.10))')
      .call(
        d3
          .drag()
          .on('start', (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on('drag', (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on('end', (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          })
      );

    nodeGroup.append('title').text((d) => (d.kind === 'class' ? `${d.label} — ontology class${d.desc ? `\n${d.desc}` : ''}` : `${d.label} — live record (${d.status})`));

    // Breathing halo on walk-path nodes
    nodeGroup
      .filter((d) => walkSet.has(d.id))
      .append('circle')
      .attr('r', (d) => (d.kind === 'instance' ? 15 : 19) + 6)
      .attr('fill', 'none')
      .attr('stroke', nodeStroke)
      .attr('stroke-width', 1.5)
      .attr('stroke-opacity', 0.55);

    nodeGroup
      .append('circle')
      .attr('r', (d) => (walkSet.has(d.id) ? (d.kind === 'instance' ? 15 : 19) : d.kind === 'instance' ? 11 : 14))
      .attr('fill', nodeFill)
      .attr('stroke', nodeStroke)
      .attr('stroke-width', (d) => (walkSet.has(d.id) ? 2.5 : 1.75))
      .style('filter', (d) => (walkSet.has(d.id) ? 'url(#glow-traversal)' : 'none'));

    nodeGroup
      .append('circle')
      .attr('r', (d) => (walkSet.has(d.id) ? 4.5 : 3))
      .attr('fill', nodeStroke);

    nodeGroup
      .append('text')
      .text((d) => d.label)
      .attr('dy', (d) => (walkSet.has(d.id) ? (d.kind === 'instance' ? 29 : 33) : d.kind === 'instance' ? 23 : 26))
      .attr('text-anchor', 'middle')
      .attr('font-size', (d) => (walkSet.has(d.id) ? '10px' : '9px'))
      .attr('fill', '#1e293b')
      .attr('font-weight', (d) => (walkSet.has(d.id) ? '700' : '500'))
      .attr('font-family', 'var(--sans, system-ui)')
      .style('paint-order', 'stroke')
      .style('stroke', '#f8fafc')
      .style('stroke-width', '3px');

    // Visit-order badges
    if (graph.walkPath && graph.walkPath.length > 0) {
      const badgeOffset = (d) => (walkSet.has(d.id) ? (d.kind === 'instance' ? 15 : 19) : 14) - 2;

      nodeGroup
        .filter((d) => walkSet.has(d.id))
        .append('circle')
        .attr('cx', badgeOffset)
        .attr('cy', (d) => -badgeOffset(d))
        .attr('r', 7.5)
        .attr('fill', '#6366f1')
        .attr('stroke', '#f8fafc')
        .attr('stroke-width', 1.5);

      nodeGroup
        .filter((d) => walkSet.has(d.id))
        .append('text')
        .text((d) => graph.walkPath.indexOf(d.id) + 1)
        .attr('x', badgeOffset)
        .attr('y', (d) => -badgeOffset(d))
        .attr('text-anchor', 'middle')
        .attr('dy', 3)
        .attr('font-size', '8px')
        .attr('fill', '#ffffff')
        .attr('font-weight', '700')
        .attr('font-family', 'var(--mono, monospace)');
    }

    simulation.on('tick', () => {
      linkLines
        .attr('x1', (d) => d.source.x)
        .attr('y1', (d) => d.source.y)
        .attr('x2', (d) => d.target.x)
        .attr('y2', (d) => d.target.y);

      linkLabels.attr('x', (d) => (d.source.x + d.target.x) / 2).attr('y', (d) => (d.source.y + d.target.y) / 2);

      nodeGroup.attr('transform', (d) => `translate(${d.x},${d.y})`);
    });

    return () => simulation.stop();
  }, [activeMsg, graphPanelOpen, graphPanelExpanded]);

  // ─── Send ────────────────────────────────────────────────────────────────
  async function handleSend(textToSend) {
    const question = (textToSend || input).trim();
    if (!question || isTyping) return;

    const now = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    setMessages((prev) => [...prev, { id: Date.now(), sender: 'user', text: question, timestamp: now() }]);
    setInput('');
    setIsTyping(true);

    const baseLogs = [
      { type: 'info', text: `QUERY · "${question}"` },
      { type: 'kg', text: 'KG INIT · Loading knowledge graph + ontology artifacts' },
    ];

    let replyText = '';
    let replyLogs = [];
    let traversalGraph = null;

    try {
      if (hasApiKey) {
        const context = kg.toAgentContext();
        const stats = context?.stats || {};

        replyLogs.push({ type: 'info', text: `KG → ${aiConfig.provider} model: ${aiConfig.model}` });
        replyLogs.push({
          type: 'kg',
          text: `SERIALIZE · KnowledgeGraph.toAgentContext() · ${stats.totalAirports ?? 0} airports, ${stats.totalRoutes ?? 0} routes, ${stats.totalFlights ?? 0} flights, ${stats.totalAircraft ?? 0} aircraft`,
        });

        // Ground in the live graph AND the OntologyEngine artifacts, so term
        // definitions come from the published thesaurus rather than the model's
        // own priors.
        const userPrompt = `Live Knowledge Graph (airports, routes, flights, aircraft and their edges — the full current state, not an example):
${JSON.stringify(context)}

Ontology Schema (object properties / relations):
${JSON.stringify(ontologySchema.Object_Properties)}

SKOS Concept Taxonomy (Concept_ID, Preferred_Term_PT, Broader_Term_BT, Narrower_Term_NT):
${JSON.stringify(taxonomy)}

SKOS Thesaurus (same concepts with UF aliases and Scope_Note_SN definitions — this is where term DEFINITIONS live, use it for "what is X" questions):
${JSON.stringify(thesaurus)}

Controlled Vocabulary (approved terms and their aliases):
${JSON.stringify(controlledVocab)}

User Query:
${question}

Answer using ONLY the data above. If the question asks for a maximum, minimum, filter or ranking, explicitly compute it over the relevant array (e.g. sort airports by currentUtilizationPct) and name the specific entity (id + name) that answers it — do not just restate the full unranked list. If the question asks what a term means, search the Thesaurus PT and UF (alias) fields case-insensitively — including acronyms — and answer from its Scope_Note_SN; only say a term isn't defined after checking Thesaurus UF/PT and Controlled Vocabulary Aliases. State which field(s) you used.`;

        replyText = await callProviderChat(aiConfig, AGENT_SYSTEM_PROMPT, userPrompt, 4000);
        replyLogs.push({ type: 'success', text: `RESOLVED · ${aiConfig.provider} response generated from live KG context.` });

        // Recover a traversal from the answer so LLM replies get a graph too.
        traversalGraph = buildTraversalGraphFromAnswer(replyText, kg) || genericKgOverviewGraph();
      } else {
        const res = answerFromKgOnly(kg, question);
        await new Promise((r) => setTimeout(r, 350));
        replyText = res.text;
        replyLogs = res.logs.slice(2); // baseLogs already carries the first two
        traversalGraph = res.traversalGraph;
      }
    } catch (err) {
      const fallback = answerFromKgOnly(kg, question);
      replyText = `**AI provider error:** ${err?.message || err}. Falling back to local knowledge-graph reasoning.\n\n${fallback.text}`;
      replyLogs = [...replyLogs, ...fallback.logs.slice(2), { type: 'warn', text: `Error · ${err?.message || err}. Used fallback.` }];
      traversalGraph = fallback.traversalGraph;
    }

    const agentId = Date.now() + 1;
    setMessages((prev) => [
      ...prev,
      {
        id: agentId,
        sender: 'agent',
        text: replyText,
        timestamp: now(),
        reasoningLogs: [...baseLogs, ...replyLogs],
        traversalGraph,
      },
    ]);
    setActiveMessageId(agentId);
    if (!graphPanelOpen) setGraphPanelOpen(true);
    setIsTyping(false);
  }

  const logClass = (log) => {
    const t = log.text || '';
    if (t.includes('QUERY')) return { color: '#6366f1' };
    if (t.includes('TRAVERSE') || t.includes('KG') || t.includes('SCAN')) return { color: '#0ea5e9' };
    if (t.includes('DB')) return { color: '#a855f7' };
    if (t.includes('RESOLVED') || t.includes('SERIALIZE')) return { color: '#16a34a' };
    if (t.includes('Error') || log.type === 'warn') return { color: '#dc2626' };
    return { color: 'var(--muted-2)' };
  };

  const panelWidth = graphPanelExpanded ? '58%' : '360px';

  return (
    <div style={{ display: 'flex', height: '100%', boxSizing: 'border-box', position: 'relative' }}>
      <style>{`
        @keyframes trav-pulse { 0%,100% { opacity: .25; } 50% { opacity: .75; } }
      `}</style>

      {/* ─── CHAT PANE ─────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '10px 22px',
            borderBottom: '1px solid var(--line)',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: '28px',
              height: '28px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--agent-soft)',
              color: 'var(--agent)',
            }}
          >
            <Network size={15} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--ink)' }}>FlightOps Knowledge Agent</div>
            <div style={{ fontSize: '10.5px', color: 'var(--muted-2)' }}>
              {hasApiKey ? 'Online — reasoning via knowledge graph + ontology artifacts' : 'Online — local knowledge-graph reasoning'}
            </div>
          </div>

          <button onClick={onOpenSettings} style={chipBtn(hasApiKey)} title={hasApiKey ? `Answering via ${aiConfig.provider} (${aiConfig.model}). Click to change.` : 'No LLM provider configured. Click to add an API key.'}>
            <Cpu size={13} /> {hasApiKey ? aiConfig.provider : 'KG only'}
          </button>
          <button onClick={() => setGraphPanelOpen((p) => !p)} style={chipBtn(graphPanelOpen)} title={graphPanelOpen ? 'Hide graph panel' : 'Show graph panel'}>
            <Compass size={13} /> Graph
          </button>
        </div>

        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {messages.map((m) => (
            <div key={m.id} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', flexDirection: m.sender === 'user' ? 'row-reverse' : 'row' }}>
              <div
                style={{
                  width: '28px',
                  height: '28px',
                  borderRadius: '50%',
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: m.sender === 'agent' ? 'var(--agent-soft)' : 'var(--surface-3)',
                  color: m.sender === 'agent' ? 'var(--agent)' : 'var(--ink)',
                }}
              >
                {m.sender === 'agent' ? <Bot size={15} /> : <User size={15} />}
              </div>

              <div
                style={{
                  maxWidth: graphPanelExpanded ? '100%' : '680px',
                  padding: '10px 14px',
                  borderRadius: '12px',
                  fontSize: '13px',
                  lineHeight: 1.6,
                  minWidth: 0,
                  background: m.sender === 'agent' ? 'var(--surface)' : 'var(--agent)',
                  color: m.sender === 'agent' ? 'var(--ink)' : '#fff',
                  border: m.sender === 'agent' ? '1px solid var(--line)' : 'none',
                }}
              >
                {m.sender === 'agent' ? renderMarkdown(m.text) : <span>{m.text}</span>}

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    marginTop: '6px',
                    fontSize: '10px',
                    color: m.sender === 'agent' ? 'var(--muted-2)' : 'rgba(255,255,255,0.75)',
                  }}
                >
                  <span>{m.timestamp}</span>
                  {m.sender === 'agent' && m.traversalGraph && (
                    <button
                      onClick={() => {
                        setActiveMessageId(m.id);
                        if (!graphPanelOpen) setGraphPanelOpen(true);
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        fontSize: '10px',
                        fontWeight: activeMessageId === m.id ? 700 : 500,
                        color: activeMessageId === m.id ? 'var(--agent)' : 'var(--muted-2)',
                      }}
                    >
                      <Network size={10} /> View graph traversal
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}

          {isTyping && (
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <div style={{ width: '28px', height: '28px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--agent-soft)', color: 'var(--agent)' }}>
                <Bot size={15} />
              </div>
              <Loader2 size={14} className="spin-animation" style={{ color: 'var(--agent)' }} />
            </div>
          )}
        </div>

        {/* Suggested prompts */}
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', padding: '0 22px 8px' }}>
          {SUGGESTED_PROMPTS.map((p) => (
            <button key={p.label} onClick={() => handleSend(p.text)} disabled={isTyping} style={suggestionChip}>
              {p.label}
            </button>
          ))}
        </div>

        {!hasApiKey && (
          <div style={{ margin: '0 22px 8px', padding: '8px 12px', borderRadius: '8px', background: 'var(--warn-soft)', border: '1px solid var(--warn)', fontSize: '11px', color: 'var(--warn)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <KeyRound size={12} />
            No AI provider configured — answering from the local knowledge graph only.
            <button onClick={onOpenSettings} style={{ marginLeft: 'auto', background: 'none', border: '1px solid var(--warn)', borderRadius: '6px', padding: '3px 8px', fontSize: '10.5px', color: 'var(--warn)', cursor: 'pointer' }}>
              Open Settings
            </button>
          </div>
        )}

        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: '8px' }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSend();
            }}
            placeholder="Ask about delays, connection risk, airport utilization…"
            disabled={isTyping}
            style={{ flex: 1, padding: '10px 14px', fontSize: '13px', border: '1px solid var(--line)', borderRadius: '10px', background: 'var(--surface)', color: 'var(--ink)', boxSizing: 'border-box' }}
          />
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || isTyping}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '10px 16px',
              fontSize: '13px',
              fontWeight: 600,
              border: 'none',
              borderRadius: '10px',
              cursor: !input.trim() || isTyping ? 'not-allowed' : 'pointer',
              background: !input.trim() || isTyping ? 'var(--surface-3)' : 'var(--agent)',
              color: !input.trim() || isTyping ? 'var(--muted-2)' : '#fff',
            }}
          >
            <Send size={14} /> Send
          </button>
        </div>
      </div>

      {/* ─── GRAPH TRAVERSAL PANEL ─────────────────────────────────────── */}
      {graphPanelOpen && (
        <div
          style={{
            width: panelWidth,
            flexShrink: 0,
            borderLeft: '1px solid var(--line)',
            background: 'var(--paper)',
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            transition: 'width 180ms ease',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
            <Compass size={14} style={{ color: 'var(--agent)' }} />
            <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--ink)' }}>Graph Traversal</span>
            <span
              style={{
                marginLeft: 'auto',
                fontSize: '9px',
                fontWeight: 700,
                letterSpacing: '0.06em',
                padding: '2px 6px',
                borderRadius: '4px',
                background: 'var(--agent-soft)',
                color: 'var(--agent)',
              }}
            >
              ONTOLOGY GRAPH
            </span>
            <button onClick={() => setGraphPanelExpanded((p) => !p)} style={iconOnlyBtn} title={graphPanelExpanded ? 'Collapse' : 'Expand'}>
              {graphPanelExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
            <button
              onClick={() => {
                setGraphPanelOpen(false);
                setGraphPanelExpanded(false);
              }}
              style={iconOnlyBtn}
              title="Close"
            >
              <X size={13} />
            </button>
          </div>

          {/* Graph canvas */}
          <div style={{ flex: 1, minHeight: '220px', position: 'relative', overflow: 'hidden' }}>
            <svg ref={graphSvgRef} style={{ display: 'block' }} />
            {!activeMsg?.traversalGraph && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  fontSize: '11.5px',
                  color: 'var(--muted-2)',
                  textAlign: 'center',
                  padding: '0 20px',
                }}
              >
                <Network size={32} style={{ color: 'var(--line-strong)' }} />
                <span>Select a response to view its graph traversal path.</span>
              </div>
            )}
          </div>

          {/* Reasoning log */}
          <div style={{ borderTop: '1px solid var(--line)', flexShrink: 0, maxHeight: '190px', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>
              <Activity size={12} /> Reasoning Log
            </div>
            <div style={{ overflowY: 'auto', padding: '0 14px 10px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
              {activeMsg?.reasoningLogs?.length ? (
                activeMsg.reasoningLogs.map((log, i) => (
                  <div key={i} style={{ fontFamily: 'var(--mono, monospace)', fontSize: '10px', lineHeight: 1.5, ...logClass(log) }}>
                    {log.text}
                  </div>
                ))
              ) : (
                <div style={{ fontSize: '10.5px', color: 'var(--muted-2)' }}>Select a response to view reasoning steps.</div>
              )}
            </div>
          </div>

          {/* Legend */}
          <div style={{ borderTop: '1px solid var(--line)', padding: '8px 14px', display: 'flex', flexWrap: 'wrap', gap: '10px', flexShrink: 0 }}>
            {[
              ['#3b82f6', 'Ontology class'],
              ['#10b981', 'Action class'],
              ['#94a3b8', 'Live record'],
              ['#ef4444', 'Critical'],
              ['#22c55e', 'Healthy'],
              ['#6366f1', 'Walk path'],
            ].map(([color, label]) => (
              <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '9.5px', color: 'var(--muted-2)' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: color }} />
                {label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const chipBtn = (active) => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  padding: '5px 10px',
  fontSize: '11px',
  fontWeight: 600,
  borderRadius: '999px',
  cursor: 'pointer',
  border: `1px solid ${active ? 'var(--agent)' : 'var(--line-strong)'}`,
  background: active ? 'var(--agent-soft)' : 'var(--surface)',
  color: active ? 'var(--agent)' : 'var(--muted)',
  marginLeft: '6px',
  flexShrink: 0,
});

const iconOnlyBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '24px',
  height: '24px',
  borderRadius: '6px',
  border: '1px solid var(--line)',
  background: 'var(--surface)',
  color: 'var(--muted)',
  cursor: 'pointer',
  flexShrink: 0,
};

const suggestionChip = {
  padding: '5px 10px',
  fontSize: '10.5px',
  fontWeight: 500,
  borderRadius: '999px',
  border: '1px solid var(--line)',
  background: 'var(--surface)',
  color: 'var(--muted)',
  cursor: 'pointer',
};
