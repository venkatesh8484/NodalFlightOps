// ============================================
// SettingsModal — AI provider configuration
// ============================================
// Ported from PostalOps' src/App.jsx SettingsModal component (same shape:
// provider / apiKey / model, saved into aiConfig). FlightOps reuses it
// verbatim for the "Ask FlightOps" chat tab and the OntologyEngine tab,
// which both consume the same aiConfig object.

import React, { useState, useEffect } from 'react';
import { Settings, Cpu, Key, X, Radio, Map as MapIcon, Loader } from 'lucide-react';
import { testOpenSkyCredentials } from '../lib/openSkyClient.js';

export default function SettingsModal({
  isOpen, onClose, aiConfig, setAiConfig,
  openSkyConfig = { clientId: '', clientSecret: '' }, setOpenSkyConfig,
  basemapConfig = { cartoKey: '' }, setBasemapConfig,
}) {
  const [localConfig, setLocalConfig] = useState(aiConfig);
  const [localSky, setLocalSky] = useState(openSkyConfig);
  const [localMap, setLocalMap] = useState(basemapConfig);
  const [skyTest, setSkyTest] = useState(null);      // {ok, message} | null
  const [skyTesting, setSkyTesting] = useState(false);

  useEffect(() => { setLocalConfig(aiConfig); }, [aiConfig]);
  useEffect(() => { setLocalSky(openSkyConfig); }, [openSkyConfig]);
  useEffect(() => { setLocalMap(basemapConfig); }, [basemapConfig]);
  // A previous PASS is not evidence about the credentials now in the box.
  useEffect(() => { setSkyTest(null); }, [localSky.clientId, localSky.clientSecret]);

  const runSkyTest = async () => {
    setSkyTesting(true);
    try {
      setSkyTest(await testOpenSkyCredentials(localSky));
    } catch (err) {
      setSkyTest({ ok: false, message: `Test failed: ${err.message}` });
    } finally {
      setSkyTesting(false);
    }
  };

  if (!isOpen) return null;

  const providerModels = {
    gemini: ['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview'],
    openrouter: ['google/gemini-3.6-flash', 'anthropic/claude-sonnet-4', 'openai/gpt-4o', 'meta-llama/llama-4-maverick'],
    claude: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250414', 'claude-opus-4-20250514'],
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 99999,
        background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--paper, #fff)', border: '1px solid var(--line, #e5e7eb)',
          borderRadius: '12px', padding: '24px', width: '460px', maxWidth: '95vw',
          maxHeight: '92vh', overflowY: 'auto',
          boxShadow: '0 20px 60px -12px rgba(0,0,0,0.25)',
          fontFamily: 'var(--sans)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Settings size={18} style={{ color: 'var(--agent, #3b82f6)' }} />
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: 'var(--ink, #0f172a)' }}>AI Agent Settings</h3>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-2, #94a3b8)', padding: '4px' }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Provider Selection */}
        <div style={{ marginBottom: '16px' }}>
          <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--muted-2, #64748b)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '6px' }}>
            <Cpu size={12} style={{ marginRight: '4px', verticalAlign: '-2px' }} />
            AI Provider
          </label>
          <div style={{ display: 'flex', gap: '6px' }}>
            {[
              { id: 'gemini', label: 'Google Gemini', color: '#4285f4' },
              { id: 'openrouter', label: 'OpenRouter', color: '#6366f1' },
              { id: 'claude', label: 'Anthropic Claude', color: '#d97706' },
            ].map((p) => (
              <button
                key={p.id}
                onClick={() => setLocalConfig((prev) => ({ ...prev, provider: p.id, model: providerModels[p.id][0] }))}
                style={{
                  flex: 1, padding: '8px 6px', fontSize: '11px', fontWeight: 600,
                  border: localConfig.provider === p.id ? `2px solid ${p.color}` : '1px solid var(--line, #e5e7eb)',
                  background: localConfig.provider === p.id ? `${p.color}10` : 'var(--surface, #f8fafc)',
                  borderRadius: '8px', cursor: 'pointer', color: 'var(--ink, #0f172a)',
                  transition: 'all 150ms ease',
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* API Key */}
        <div style={{ marginBottom: '16px' }}>
          <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--muted-2, #64748b)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '6px' }}>
            <Key size={12} style={{ marginRight: '4px', verticalAlign: '-2px' }} />
            API Key
          </label>
          <input
            type="password"
            placeholder={`Enter your ${localConfig.provider === 'gemini' ? 'Google AI' : localConfig.provider === 'openrouter' ? 'OpenRouter' : 'Anthropic'} API key...`}
            value={localConfig.apiKey}
            onChange={(e) => setLocalConfig((prev) => ({ ...prev, apiKey: e.target.value }))}
            style={{
              width: '100%', padding: '8px 12px', fontSize: '13px',
              border: '1px solid var(--line, #e5e7eb)', borderRadius: '8px',
              background: 'var(--surface, #f8fafc)', color: 'var(--ink, #0f172a)',
              fontFamily: 'var(--mono)', boxSizing: 'border-box', outline: 'none',
            }}
          />
          <div style={{ fontSize: '10px', color: 'var(--muted-2, #94a3b8)', marginTop: '4px' }}>
            {localConfig.provider === 'gemini' && 'Get key from aistudio.google.com'}
            {localConfig.provider === 'openrouter' && 'Get key from openrouter.ai/keys'}
            {localConfig.provider === 'claude' && 'Get key from console.anthropic.com'}
          </div>
        </div>

        {/* Model Selection */}
        <div style={{ marginBottom: '20px' }}>
          <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--muted-2, #64748b)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '6px' }}>
            Model
          </label>
          <select
            value={localConfig.model}
            onChange={(e) => setLocalConfig((prev) => ({ ...prev, model: e.target.value }))}
            style={{
              width: '100%', padding: '8px 12px', fontSize: '13px',
              border: '1px solid var(--line, #e5e7eb)', borderRadius: '8px',
              background: 'var(--surface, #f8fafc)', color: 'var(--ink, #0f172a)',
              fontFamily: 'var(--sans)', cursor: 'pointer', boxSizing: 'border-box',
            }}
          >
            {providerModels[localConfig.provider]?.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>

        {/* Status indicator */}
        <div
          style={{
            padding: '10px 12px', borderRadius: '8px', marginBottom: '16px',
            background: localConfig.apiKey ? 'rgba(5, 150, 105, 0.06)' : 'rgba(245, 158, 11, 0.06)',
            border: `1px solid ${localConfig.apiKey ? 'rgba(5, 150, 105, 0.2)' : 'rgba(245, 158, 11, 0.2)'}`,
            fontSize: '11px', display: 'flex', alignItems: 'center', gap: '8px',
          }}
        >
          <span
            style={{
              width: '6px', height: '6px', borderRadius: '50%',
              background: localConfig.apiKey ? '#059669' : '#d97706',
            }}
          />
          <span style={{ color: localConfig.apiKey ? '#059669' : '#d97706', fontWeight: 600 }}>
            {localConfig.apiKey
              ? `${localConfig.provider.charAt(0).toUpperCase() + localConfig.provider.slice(1)} connected — AI agent enabled`
              : 'No API key — Ask FlightOps falls back to local knowledge-graph lookups'}
          </span>
        </div>


        {/* ══════════════════════════════════════════════════════════
            OPENSKY NETWORK — live ADS-B feed for the Console map
            ══════════════════════════════════════════════════════════
            Optional. Without credentials the console still runs, on
            OpenSky's anonymous allowance (~400 credits/day, and a
            world-wide query costs 4), which is enough for a short demo
            at a slow refresh. OAuth2 client credentials raise that to
            ~4000/day and unlock the 15-second refresh. Register an
            API client at opensky-network.org → Account. */}
        <div style={{ borderTop: '1px solid var(--line, #e5e7eb)', paddingTop: '18px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            <Radio size={15} style={{ color: 'var(--agent, #3b82f6)' }} />
            <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: 'var(--ink, #0f172a)' }}>
              OpenSky Network — live traffic feed
            </h3>
          </div>

          <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--muted-2, #64748b)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '6px' }}>
            <Key size={12} style={{ marginRight: '4px', verticalAlign: '-2px' }} />
            Client ID
          </label>
          <input
            type="text"
            placeholder="OpenSky API client id (optional)"
            value={localSky.clientId || ''}
            onChange={(e) => setLocalSky((prev) => ({ ...prev, clientId: e.target.value }))}
            style={{
              width: '100%', padding: '8px 12px', fontSize: '13px', marginBottom: '10px',
              border: '1px solid var(--line, #e5e7eb)', borderRadius: '8px',
              background: 'var(--surface, #f8fafc)', color: 'var(--ink, #0f172a)',
              fontFamily: 'var(--mono)', boxSizing: 'border-box', outline: 'none',
            }}
          />

          <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--muted-2, #64748b)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '6px' }}>
            Client Secret
          </label>
          <input
            type="password"
            placeholder="OpenSky API client secret (optional)"
            value={localSky.clientSecret || ''}
            onChange={(e) => setLocalSky((prev) => ({ ...prev, clientSecret: e.target.value }))}
            style={{
              width: '100%', padding: '8px 12px', fontSize: '13px',
              border: '1px solid var(--line, #e5e7eb)', borderRadius: '8px',
              background: 'var(--surface, #f8fafc)', color: 'var(--ink, #0f172a)',
              fontFamily: 'var(--mono)', boxSizing: 'border-box', outline: 'none',
            }}
          />

          {/* A live check against the token endpoint. Without it the only
              symptom of a wrong secret is a map that looks completely
              normal on a quarter of the allowance. */}
          <button
            onClick={runSkyTest}
            disabled={skyTesting || !localSky.clientId || !localSky.clientSecret}
            style={{
              marginTop: '10px', padding: '7px 14px', fontSize: '12px', fontWeight: 600,
              border: '1px solid var(--line, #e5e7eb)', borderRadius: '8px',
              background: 'var(--surface, #f8fafc)', color: 'var(--ink, #0f172a)',
              cursor: skyTesting || !localSky.clientId || !localSky.clientSecret ? 'not-allowed' : 'pointer',
              opacity: !localSky.clientId || !localSky.clientSecret ? 0.55 : 1,
              display: 'inline-flex', alignItems: 'center', gap: '6px',
            }}
          >
            {skyTesting ? <Loader size={12} /> : <Radio size={12} />}
            {skyTesting ? 'Requesting token…' : 'Test connection'}
          </button>

          {skyTest && (
            <div
              style={{
                padding: '10px 12px', borderRadius: '8px', marginTop: '10px',
                background: skyTest.ok ? 'rgba(5, 150, 105, 0.07)' : 'rgba(220, 38, 38, 0.07)',
                border: `1px solid ${skyTest.ok ? 'rgba(5, 150, 105, 0.25)' : 'rgba(220, 38, 38, 0.25)'}`,
                fontSize: '11px', lineHeight: 1.5,
                color: skyTest.ok ? '#059669' : '#dc2626', fontWeight: 600,
              }}
            >
              {skyTest.message}
            </div>
          )}

          <div
            style={{
              padding: '10px 12px', borderRadius: '8px', marginTop: '12px',
              background: localSky.clientId && localSky.clientSecret ? 'rgba(5, 150, 105, 0.06)' : 'rgba(245, 158, 11, 0.06)',
              border: `1px solid ${localSky.clientId && localSky.clientSecret ? 'rgba(5, 150, 105, 0.2)' : 'rgba(245, 158, 11, 0.2)'}`,
              fontSize: '11px', display: 'flex', alignItems: 'center', gap: '8px',
            }}
          >
            <span
              style={{
                width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0,
                background: localSky.clientId && localSky.clientSecret ? '#059669' : '#d97706',
              }}
            />
            <span style={{ color: localSky.clientId && localSky.clientSecret ? '#059669' : '#d97706', fontWeight: 600, lineHeight: 1.45 }}>
              {localSky.clientId && localSky.clientSecret
                ? 'OAuth2 configured — ~4000 credits/day, 15s refresh available'
                : 'Anonymous access — ~400 credits/day; keep the console refresh at 60s'}
            </span>
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════
            BASEMAP — CARTO API key (optional)
            ══════════════════════════════════════════════════════════
            CARTO's raster CDN began requiring an API key and does not
            fail closed: it serves a valid tile with "API KEY REQUIRED"
            printed into the image, which is what tiled that message
            across the console map. The console therefore defaults to a
            keyless basemap and only uses CARTO when a key is present. */}
        <div style={{ borderTop: '1px solid var(--line, #e5e7eb)', paddingTop: '18px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            <MapIcon size={15} style={{ color: 'var(--agent, #3b82f6)' }} />
            <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: 'var(--ink, #0f172a)' }}>
              Basemap — CARTO API key
            </h3>
          </div>

          <input
            type="text"
            placeholder="CARTO basemap key (optional)"
            value={localMap.cartoKey || ''}
            onChange={(e) => setLocalMap((prev) => ({ ...prev, cartoKey: e.target.value }))}
            style={{
              width: '100%', padding: '8px 12px', fontSize: '13px',
              border: '1px solid var(--line, #e5e7eb)', borderRadius: '8px',
              background: 'var(--surface, #f8fafc)', color: 'var(--ink, #0f172a)',
              fontFamily: 'var(--mono)', boxSizing: 'border-box', outline: 'none',
            }}
          />

          <div
            style={{
              padding: '10px 12px', borderRadius: '8px', marginTop: '12px',
              background: localMap.cartoKey ? 'rgba(5, 150, 105, 0.06)' : 'rgba(100, 116, 139, 0.07)',
              border: `1px solid ${localMap.cartoKey ? 'rgba(5, 150, 105, 0.2)' : 'rgba(100, 116, 139, 0.2)'}`,
              fontSize: '11px', lineHeight: 1.5,
              color: localMap.cartoKey ? '#059669' : 'var(--muted-2, #64748b)',
            }}
          >
            {localMap.cartoKey
              ? 'CARTO basemaps active — the watermark disappears once the key is valid.'
              : 'Using the keyless Esri basemap (World Street Map for Streets, Canvas Dark Gray for '
                + 'Dark). Free CARTO keys (5M tiles/month, no account needed) are issued instantly at '
                + "carto.com/basemaps/apikey — paste one here to switch to CARTO's own cartography "
                + '(Voyager / Dark Matter), styled closer to Google Maps.'}
          </div>
        </div>

        {/* Save / Cancel */}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px', fontSize: '12px', fontWeight: 600,
              border: '1px solid var(--line, #e5e7eb)', borderRadius: '8px',
              background: 'var(--surface, #f8fafc)', cursor: 'pointer', color: 'var(--ink, #0f172a)',
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => {
              setAiConfig(localConfig);
              if (setOpenSkyConfig) setOpenSkyConfig(localSky);
              if (setBasemapConfig) setBasemapConfig(localMap);
              onClose();
            }}
            style={{
              padding: '8px 20px', fontSize: '12px', fontWeight: 600,
              border: 'none', borderRadius: '8px', cursor: 'pointer',
              background: 'var(--agent, #3b82f6)', color: '#fff',
            }}
          >
            Save Settings
          </button>
        </div>
      </div>
    </div>
  );
}
