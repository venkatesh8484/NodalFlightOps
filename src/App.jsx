// ============================================
// FlightOps — top-level 4-tab application shell
// ============================================
// Mirrors PostalOps' App.jsx structure: Console / Explorer / Chat / OntologyEngine
// tabs, a shared Knowledge Graph singleton built once from data/*.json, and a
// shared aiConfig (provider/apiKey/model) used by both the Chat tab and the
// OntologyEngine tab.

import React, { useEffect, useMemo, useState } from 'react';
import { Plane, Network, MessageSquare, Workflow, Settings as SettingsIcon } from 'lucide-react';

import ConsoleTab from './tabs/ConsoleTab.jsx';
import ExplorerTab from './tabs/ExplorerTab.jsx';
import ChatTab from './tabs/ChatTab.jsx';
import OntologyEngineTab from './ontologyEngine/OntologyEngineTab.jsx';
import SettingsModal from './components/SettingsModal.jsx';

import { buildKnowledgeGraph } from './lib/knowledgeGraph.js';

import airportsData from '../data/airports.json';
import routesData from '../data/flight_routes.json';
import flightsData from '../data/flights.json';
import aircraftData from '../data/aircraft.json';

const AI_CONFIG_STORAGE_KEY = 'flightops.aiConfig';
// OpenSky OAuth2 client credentials for the Console tab's live traffic
// feed. Optional — the feed degrades to anonymous access without them.
const OPENSKY_STORAGE_KEY = 'flightops.openSkyConfig';
// Optional CARTO basemap key for the Console map. Empty means the console
// uses its keyless basemap — see BASEMAPS in ConsoleTab.jsx for why.
const BASEMAP_STORAGE_KEY = 'flightops.basemapConfig';

const TABS = [
  { key: 'console', label: 'AMS OCC Console', icon: Plane },
  { key: 'explorer', label: 'Ontology Graph Explorer', icon: Network },
  { key: 'chat', label: 'Ask FlightOps', icon: MessageSquare },
  { key: 'ontology', label: 'OntologyEngine', icon: Workflow },
];

export default function App() {
  // Build the KG singleton once, before any tab mounts.
  useMemo(() => {
    buildKnowledgeGraph({
      airports: airportsData,
      routes: routesData,
      flights: flightsData,
      aircraft: aircraftData,
    });
  }, []);

  const [activeTab, setActiveTab] = useState('console');

  const [aiConfig, setAiConfig] = useState(() => {
    const fallback = { provider: 'gemini', apiKey: '', model: 'gemini-3.6-flash' };
    try {
      const saved = window.localStorage.getItem(AI_CONFIG_STORAGE_KEY);
      if (saved) return { ...fallback, ...JSON.parse(saved) };
    } catch {
      // ignore malformed/unavailable storage
    }
    return fallback;
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(AI_CONFIG_STORAGE_KEY, JSON.stringify(aiConfig));
    } catch {
      // ignore unavailable storage
    }
  }, [aiConfig]);

  const [openSkyConfig, setOpenSkyConfig] = useState(() => {
    const fallback = { clientId: '', clientSecret: '' };
    try {
      const saved = window.localStorage.getItem(OPENSKY_STORAGE_KEY);
      if (saved) return { ...fallback, ...JSON.parse(saved) };
    } catch {
      // ignore malformed/unavailable storage
    }
    return fallback;
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(OPENSKY_STORAGE_KEY, JSON.stringify(openSkyConfig));
    } catch {
      // ignore unavailable storage
    }
  }, [openSkyConfig]);

  const [basemapConfig, setBasemapConfig] = useState(() => {
    const fallback = { cartoKey: '' };
    try {
      const saved = window.localStorage.getItem(BASEMAP_STORAGE_KEY);
      if (saved) return { ...fallback, ...JSON.parse(saved) };
    } catch {
      // ignore malformed/unavailable storage
    }
    return fallback;
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(BASEMAP_STORAGE_KEY, JSON.stringify(basemapConfig));
    } catch {
      // ignore unavailable storage
    }
  }, [basemapConfig]);

  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', boxSizing: 'border-box', background: 'var(--surface)' }}>
      <header className="header-navigation">
        <div className="header-nav-brand">
          <Plane size={19} style={{ color: 'var(--agent)' }} />
          <span>FlightOps <small>AMS Operations</small></span>
          <span className="kl-badge">KLM</span>
        </div>
        <nav className="header-nav-tabs">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                className={`nav-tab-btn ${activeTab === t.key ? 'active' : ''}`}
                onClick={() => setActiveTab(t.key)}
              >
                <Icon size={14} /> {t.label}
              </button>
            );
          })}
        </nav>
        <button className="header-nav-settings" onClick={() => setSettingsOpen(true)} title="AI Agent Settings">
          <SettingsIcon size={16} />
        </button>
      </header>

      <main style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {activeTab === 'console' && (
          <ConsoleTab
            openSkyConfig={openSkyConfig}
            basemapConfig={basemapConfig}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}
        {activeTab === 'explorer' && <ExplorerTab />}

        {/* CHAT WORKSPACE
            Kept mounted (hidden via CSS) rather than conditionally rendered.
            ChatTab's `messages` history lives only in React state with no
            persistence, so `{activeTab === 'chat' && <ChatTab />}` unmounted
            the whole component on switch-away and remounted it from scratch
            (fresh useState initialiser) on switch-back, wiping the
            conversation every time the operator looked at another tab.
            Mirrors the OntologyEngine fix below and PostalOps' App.jsx. */}
        <div
          style={{
            display: activeTab === 'chat' ? 'flex' : 'none',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
          }}
        >
          <ChatTab aiConfig={aiConfig} onOpenSettings={() => setSettingsOpen(true)} />
        </div>

        {/* ONTOLOGYENGINE WORKSPACE
            Kept mounted (hidden via CSS) rather than conditionally rendered, so an
            in-flight pipeline run and its stage-3 output survive tab switches
            instead of being unmounted mid-run. Mirrors PostalOps' App.jsx. */}
        <div
          style={{
            display: activeTab === 'ontology' ? 'block' : 'none',
            height: '100%',
            overflowY: 'auto',
          }}
        >
          <OntologyEngineTab aiConfig={aiConfig} onOpenSettings={() => setSettingsOpen(true)} />
        </div>
      </main>

      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        aiConfig={aiConfig}
        setAiConfig={setAiConfig}
        openSkyConfig={openSkyConfig}
        setOpenSkyConfig={setOpenSkyConfig}
        basemapConfig={basemapConfig}
        setBasemapConfig={setBasemapConfig}
      />
    </div>
  );
}
