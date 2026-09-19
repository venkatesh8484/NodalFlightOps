import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import flightOpsWritebackPlugin from './vite-plugin-flightops-writeback.js'

export default defineConfig({
  base: './',
  plugins: [react(), flightOpsWritebackPlugin()],

  // ── OpenSky proxy ──────────────────────────────────────────────────
  // The OpenSky Network's REST API sends no Access-Control-Allow-Origin
  // header, so a browser page served from localhost:5173 cannot call it
  // directly — the request dies as an opaque "Failed to fetch" before it
  // ever leaves Chrome. Proxying through the dev server makes the call
  // same-origin from the browser's point of view; the actual cross-origin
  // hop happens server-side, where CORS does not apply.
  //
  // The packaged Electron build has no dev server, so it takes the other
  // path: main.js exposes an IPC bridge and openSkyClient prefers that
  // whenever preload.cjs has installed it. See src/lib/openSkyClient.js.
  server: {
    proxy: {
      '/opensky-api': {
        target: 'https://opensky-network.org',
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/opensky-api/, '/api'),
      },
      '/opensky-auth': {
        target: 'https://auth.opensky-network.org',
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/opensky-auth/, ''),
      },
    },
  },
})
