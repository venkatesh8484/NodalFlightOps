import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;

// ═══════════════════════════════════════════════════════════════════════
// OpenSky network bridge
// ═══════════════════════════════════════════════════════════════════════
// The OpenSky REST API sends no Access-Control-Allow-Origin header, so the
// renderer cannot call it directly. In `npm run dev` the Vite proxy handles
// this (see vite.config.js); in a packaged build there is no dev server, so
// the main process makes the call instead — no CORS here.
//
// The renderer hands over a URL but does not get to choose the host: only
// the two OpenSky hosts below are honoured, over HTTPS. That keeps this
// from becoming a general-purpose request forwarder if anything untrusted
// ever ends up rendered in the window.
const OPENSKY_HOSTS = new Set(['opensky-network.org', 'auth.opensky-network.org']);

ipcMain.handle('opensky:request', async (_event, req = {}) => {
  const { url, method = 'GET', headers = {}, body = null } = req;

  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, status: 0, body: null, rateRemaining: null, error: 'Malformed URL.' };
  }
  if (parsed.protocol !== 'https:' || !OPENSKY_HOSTS.has(parsed.hostname)) {
    return {
      ok: false, status: 0, body: null, rateRemaining: null,
      error: `Refused: ${parsed.hostname} is not an OpenSky host.`,
    };
  }

  try {
    const res = await fetch(parsed.toString(), { method, headers, body });
    return {
      ok: res.ok,
      status: res.status,
      body: await res.text(),
      rateRemaining: res.headers.get('x-rate-limit-remaining'),
      error: null,
    };
  } catch (err) {
    return { ok: false, status: 0, body: null, rateRemaining: null, error: err.message };
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    title: "Nodal Flight Operations Recovery",
    titleBarStyle: 'default',
  });

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
