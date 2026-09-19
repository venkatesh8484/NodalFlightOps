#!/usr/bin/env python3
"""Patch SettingsModal.jsx to add an OpenSky Network credentials section,
and App.jsx to own + persist that config and pass it to the Console tab."""

import io, os, re, sys

ROOT = os.path.expanduser("~/mnt/FlightOps")
SM = os.path.join(ROOT, "src/components/SettingsModal.jsx")
APP = os.path.join(ROOT, "src/App.jsx")

# ── SettingsModal ────────────────────────────────────────────────────
sm = io.open(SM, encoding="utf-8").read()

sm = sm.replace(
    "import { Settings, Cpu, Key, X } from 'lucide-react';",
    "import { Settings, Cpu, Key, X, Radio } from 'lucide-react';",
)

sm = sm.replace(
    "export default function SettingsModal({ isOpen, onClose, aiConfig, setAiConfig }) {\n"
    "  const [localConfig, setLocalConfig] = useState(aiConfig);\n\n"
    "  useEffect(() => { setLocalConfig(aiConfig); }, [aiConfig]);",
    "export default function SettingsModal({\n"
    "  isOpen, onClose, aiConfig, setAiConfig,\n"
    "  openSkyConfig = { clientId: '', clientSecret: '' }, setOpenSkyConfig,\n"
    "}) {\n"
    "  const [localConfig, setLocalConfig] = useState(aiConfig);\n"
    "  const [localSky, setLocalSky] = useState(openSkyConfig);\n\n"
    "  useEffect(() => { setLocalConfig(aiConfig); }, [aiConfig]);\n"
    "  useEffect(() => { setLocalSky(openSkyConfig); }, [openSkyConfig]);",
)

# Widen the modal and make it scrollable, since it now carries two sections.
sm = sm.replace(
    "borderRadius: '12px', padding: '24px', width: '440px', maxWidth: '95vw',",
    "borderRadius: '12px', padding: '24px', width: '460px', maxWidth: '95vw',\n"
    "          maxHeight: '92vh', overflowY: 'auto',",
)

OPENSKY_SECTION = r"""
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
"""

# Insert the OpenSky block just before the Save / Cancel row.
anchor = "        {/* Save / Cancel */}"
assert anchor in sm, "Save/Cancel anchor not found in SettingsModal"
sm = sm.replace(anchor, OPENSKY_SECTION + "\n" + anchor, 1)

# Save button must persist both configs.
sm = sm.replace(
    "onClick={() => { setAiConfig(localConfig); onClose(); }}",
    "onClick={() => {\n"
    "              setAiConfig(localConfig);\n"
    "              if (setOpenSkyConfig) setOpenSkyConfig(localSky);\n"
    "              onClose();\n"
    "            }}",
)

io.open(SM, "w", encoding="utf-8").write(sm)
print("patched SettingsModal.jsx")

# ── App.jsx ──────────────────────────────────────────────────────────
app = io.open(APP, encoding="utf-8").read()

app = app.replace(
    "const AI_CONFIG_STORAGE_KEY = 'flightops.aiConfig';",
    "const AI_CONFIG_STORAGE_KEY = 'flightops.aiConfig';\n"
    "// OpenSky OAuth2 client credentials for the Console tab's live traffic\n"
    "// feed. Optional — the feed degrades to anonymous access without them.\n"
    "const OPENSKY_STORAGE_KEY = 'flightops.openSkyConfig';",
)

app = app.replace(
    "  const [settingsOpen, setSettingsOpen] = useState(false);",
    "  const [openSkyConfig, setOpenSkyConfig] = useState(() => {\n"
    "    const fallback = { clientId: '', clientSecret: '' };\n"
    "    try {\n"
    "      const saved = window.localStorage.getItem(OPENSKY_STORAGE_KEY);\n"
    "      if (saved) return { ...fallback, ...JSON.parse(saved) };\n"
    "    } catch {\n"
    "      // ignore malformed/unavailable storage\n"
    "    }\n"
    "    return fallback;\n"
    "  });\n"
    "  useEffect(() => {\n"
    "    try {\n"
    "      window.localStorage.setItem(OPENSKY_STORAGE_KEY, JSON.stringify(openSkyConfig));\n"
    "    } catch {\n"
    "      // ignore unavailable storage\n"
    "    }\n"
    "  }, [openSkyConfig]);\n\n"
    "  const [settingsOpen, setSettingsOpen] = useState(false);",
)

app = app.replace(
    "        {activeTab === 'console' && <ConsoleTab />}",
    "        {activeTab === 'console' && (\n"
    "          <ConsoleTab openSkyConfig={openSkyConfig} onOpenSettings={() => setSettingsOpen(true)} />\n"
    "        )}",
)

app = app.replace(
    "      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} aiConfig={aiConfig} setAiConfig={setAiConfig} />",
    "      <SettingsModal\n"
    "        isOpen={settingsOpen}\n"
    "        onClose={() => setSettingsOpen(false)}\n"
    "        aiConfig={aiConfig}\n"
    "        setAiConfig={setAiConfig}\n"
    "        openSkyConfig={openSkyConfig}\n"
    "        setOpenSkyConfig={setOpenSkyConfig}\n"
    "      />",
)

io.open(APP, "w", encoding="utf-8").write(app)
print("patched App.jsx")
