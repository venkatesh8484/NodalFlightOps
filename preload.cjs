// ═══════════════════════════════════════════════════════════════════════
// preload.cjs — the renderer's only door to the network
// ═══════════════════════════════════════════════════════════════════════
//
// The Console tab's live map needs the OpenSky Network REST API, which
// serves no CORS headers. In a packaged build there is no Vite dev server
// to proxy through, so the request has to be made by the main process,
// where the same-origin policy does not apply.
//
// contextIsolation stays on and nodeIntegration stays off. The renderer
// gets exactly one narrow function — it cannot name a host, only hand over
// a request that main.js will accept or refuse against its own allowlist.
//
// CommonJS (.cjs) on purpose: package.json declares "type": "module", and
// Electron preload scripts are loaded as CommonJS.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flightOpsNet', {
  /**
   * @param {{url: string, method?: string, headers?: object, body?: string}} req
   * @returns {Promise<{ok: boolean, status: number, body: string|null,
   *                    rateRemaining: string|null, error: string|null}>}
   */
  openSky: (req) => ipcRenderer.invoke('opensky:request', req),
});
