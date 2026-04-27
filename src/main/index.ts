import { app, BrowserWindow, ipcMain, session, shell as electronShell } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import type { IncomingHttpHeaders } from 'http';

const TBA_ENGINE = process.env.TBA_ENGINE_URL || 'https://engine.takawasi-social.com';
const NOVELFORGE_URL = process.env.NOVELFORGE_URL || 'https://novelforge.takawasi-social.com';
const CREDITGATE_URL = 'https://creditgate.takawasi-social.com';
const CG_SESSION_COOKIE = 'cg_session';
const PARTITION = 'persist:takawasi';
// NovelForge 特化アプリ: service は "novelforge" で固定
const TBA_SERVICE = 'novelforge';

let mainWin: BrowserWindow | null = null;
let authWin: BrowserWindow | null = null;

interface HttpTextResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function appSession(): Electron.Session {
  return session.fromPartition(PARTITION);
}

function sendToRenderer(sender: Electron.WebContents, channel: string, payload?: unknown): void {
  if (!sender.isDestroyed()) {
    sender.send(channel, payload);
  }
}

function openHttpExternal(url: string): { ok: boolean; error?: string } {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false, error: 'unsupported URL scheme' };
    }
    electronShell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function cgCookieHeaderFor(url: string): Promise<string> {
  const cookies = await appSession().cookies.get({ url, name: CG_SESSION_COOKIE });
  return cookies.map((c: Electron.Cookie) => `${c.name}=${c.value}`).join('; ');
}

function requestText(
  urlString: string,
  opts: { method?: string; headers?: Record<string, string | number>; body?: string | Buffer } = {},
): Promise<HttpTextResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const payload = opts.body;
    const headers: Record<string, string | number> = { ...(opts.headers || {}) };
    if (payload !== undefined && headers['Content-Length'] === undefined) {
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port ? Number(u.port) : undefined,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function callCreditGateLogout(): Promise<void> {
  const cookieHeader = await cgCookieHeaderFor(CREDITGATE_URL);
  const redirect = encodeURIComponent('https://takawasi-social.com');
  await requestText(`${CREDITGATE_URL}/auth/logout?redirect=${redirect}`, {
    method: 'GET',
    headers: cookieHeader ? { Cookie: cookieHeader } : {},
  });
}

function createMainWindow(): void {
  mainWin = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Takawasi NovelForge',
    backgroundColor: '#0f0f1a',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      session: appSession(),
    },
  });

  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    openHttpExternal(url);
    return { action: 'deny' };
  });

  mainWin.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWin.on('closed', () => {
    mainWin = null;
    app.quit();
  });
}

async function openAuthWindow(): Promise<void> {
  if (authWin) { authWin.focus(); return; }

  authWin = new BrowserWindow({
    width: 520,
    height: 700,
    title: 'ログイン — Takawasi',
    parent: mainWin || undefined,
    modal: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: appSession(),
    },
  });

  authWin.webContents.setWindowOpenHandler(({ url }) => {
    openHttpExternal(url);
    return { action: 'deny' };
  });

  authWin.loadURL(`${CREDITGATE_URL}/auth/login`);

  const checkCookieInterval = setInterval(async () => {
    const cookies = await appSession().cookies.get({
      url: CREDITGATE_URL,
      name: CG_SESSION_COOKIE,
    });
    if (cookies.length > 0) {
      clearInterval(checkCookieInterval);
      mainWin?.webContents.send('auth:completed', { loggedIn: true });
      authWin?.close();
    }
  }, 1000);

  authWin.on('closed', () => {
    clearInterval(checkCookieInterval);
    authWin = null;
  });
}

// IPC: auth
ipcMain.handle('auth:check', async () => {
  const cookies = await appSession().cookies.get({
    url: CREDITGATE_URL,
    name: CG_SESSION_COOKIE,
  });
  return { loggedIn: cookies.length > 0 };
});

ipcMain.handle('auth:login', async () => {
  await openAuthWindow();
  return { ok: true };
});

ipcMain.handle('auth:logout', async () => {
  let remoteError = '';
  try {
    await callCreditGateLogout();
  } catch (err) {
    remoteError = err instanceof Error ? err.message : String(err);
  }
  await appSession().clearStorageData({ storages: ['cookies'] });
  mainWin?.webContents.send('auth:completed', { loggedIn: false });
  return { ok: true, remoteError };
});

// IPC: TBA stream. Main process owns the HTTP request so renderer avoids CORS
// and browser-forbidden Cookie headers.
const tbaStreams = new Map<string, http.ClientRequest>();

ipcMain.handle('tba:start', async (event, { id, message }: { id: string; message: string }) => {
  if (!id || !message.trim()) return { ok: false, error: 'message is empty' };

  const sender = event.sender;
  const payload = JSON.stringify({ message, service: TBA_SERVICE });
  const cookieHeader = await cgCookieHeaderFor(TBA_ENGINE);
  const u = new URL(`${TBA_ENGINE}/api/tba/chat/stream`);
  const headers: Record<string, string | number> = {
    'Accept': 'text/event-stream',
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  };
  if (cookieHeader) headers.Cookie = cookieHeader;

  const lib = u.protocol === 'https:' ? https : http;
  const req = lib.request({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    path: u.pathname + u.search,
    method: 'POST',
    headers,
  }, (res) => {
    if ((res.statusCode || 0) >= 400) {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on('end', () => {
        tbaStreams.delete(id);
        sendToRenderer(sender, `tba:error:${id}`, {
          status: res.statusCode || 0,
          message: Buffer.concat(chunks).toString('utf8') || `HTTP ${res.statusCode || 0}`,
        });
        sendToRenderer(sender, `tba:end:${id}`);
      });
      return;
    }

    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      sendToRenderer(sender, `tba:chunk:${id}`, chunk);
    });
    res.on('end', () => {
      tbaStreams.delete(id);
      sendToRenderer(sender, `tba:end:${id}`);
    });
  });

  req.on('error', (err) => {
    tbaStreams.delete(id);
    sendToRenderer(sender, `tba:error:${id}`, { message: err.message });
    sendToRenderer(sender, `tba:end:${id}`);
  });

  tbaStreams.set(id, req);
  req.write(payload);
  req.end();
  return { ok: true };
});

ipcMain.handle('tba:cancel', (_e, { id }: { id: string }) => {
  const req = tbaStreams.get(id);
  if (req) {
    req.destroy();
    tbaStreams.delete(id);
  }
  return { ok: true };
});

// IPC: terminal
let pty: typeof import('node-pty') | null = null;
try { pty = require('node-pty'); } catch (e) { console.error('node-pty unavailable:', e); }

const ptySessions = new Map<string, import('node-pty').IPty>();

ipcMain.handle('terminal:create', async (event, { id }: { id: string }) => {
  if (!pty) return { ok: false, error: 'node-pty not available' };
  const systemShell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
  const cliDir = app.isPackaged
    ? path.join(process.resourcesPath, 'cli')
    : path.join(app.getAppPath(), 'dist', 'cli');
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${cliDir}${path.delimiter}${process.env.PATH || ''}`,
    TERM: 'xterm-256color',
  };
  const ptyProcess = pty.spawn(systemShell, [], {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: os.homedir(), env,
  });
  ptySessions.set(id, ptyProcess);
  ptyProcess.onData((data: string) => event.sender.send(`terminal:data:${id}`, data));
  ptyProcess.onExit(() => { ptySessions.delete(id); event.sender.send(`terminal:exit:${id}`); });
  return { ok: true };
});

ipcMain.handle('terminal:write', (_e, { id, data }: { id: string; data: string }) => {
  ptySessions.get(id)?.write(data); return { ok: true };
});

ipcMain.handle('terminal:resize', (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
  ptySessions.get(id)?.resize(cols, rows); return { ok: true };
});

ipcMain.handle('terminal:destroy', (_e, { id }: { id: string }) => {
  const p = ptySessions.get(id);
  if (p) { p.kill(); ptySessions.delete(id); }
  return { ok: true };
});

// IPC: NovelForge API. Main process proxies all NovelForge API calls to avoid CORS/Cookie issues.
// All requests carry the cg_session cookie from the shared session.

async function novelforgeGet(path: string): Promise<{ status: number; body: string }> {
  const cookieHeader = await cgCookieHeaderFor(NOVELFORGE_URL);
  const headers: Record<string, string | number> = { 'Accept': 'application/json' };
  if (cookieHeader) headers.Cookie = cookieHeader;
  const res = await requestText(`${NOVELFORGE_URL}${path}`, { method: 'GET', headers });
  return { status: res.status, body: res.body };
}

async function novelforgePost(path: string, bodyObj: unknown): Promise<{ status: number; body: string }> {
  const cookieHeader = await cgCookieHeaderFor(NOVELFORGE_URL);
  const payload = JSON.stringify(bodyObj);
  const headers: Record<string, string | number> = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  };
  if (cookieHeader) headers.Cookie = cookieHeader;
  const res = await requestText(`${NOVELFORGE_URL}${path}`, { method: 'POST', headers, body: payload });
  return { status: res.status, body: res.body };
}

// 小説一覧
ipcMain.handle('nf:listDocs', async () => {
  try {
    const res = await novelforgeGet('/api/goal-spec/list');
    if (res.status === 401) return { ok: false, error: 'ログインが必要です', status: 401 };
    if (res.status >= 400) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    return { ok: true, data: JSON.parse(res.body) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// シリーズ一覧
ipcMain.handle('nf:listSeries', async () => {
  try {
    const res = await novelforgeGet('/api/goal-spec/series/list');
    if (res.status === 401) return { ok: false, error: 'ログインが必要です', status: 401 };
    if (res.status >= 400) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    return { ok: true, data: JSON.parse(res.body) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// シリーズ作成
ipcMain.handle('nf:createSeries', async (_e, { title }: { title: string }) => {
  try {
    const res = await novelforgePost('/api/goal-spec/series/create', { title });
    if (res.status === 401) return { ok: false, error: 'ログインが必要です', status: 401 };
    if (res.status >= 400) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    return { ok: true, data: JSON.parse(res.body) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// シリーズ配下ドキュメント
ipcMain.handle('nf:listBySeries', async (_e, { seriesId }: { seriesId: string }) => {
  try {
    const res = await novelforgeGet(`/api/goal-spec/series/${encodeURIComponent(seriesId)}/docs`);
    if (res.status === 401) return { ok: false, error: 'ログインが必要です', status: 401 };
    if (res.status >= 400) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    return { ok: true, data: JSON.parse(res.body) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// 新規ドキュメント作成
ipcMain.handle('nf:newDoc', async (_e, { title }: { title: string }) => {
  try {
    const res = await novelforgePost('/api/goal-spec/new', { title });
    if (res.status === 401) return { ok: false, error: 'ログインが必要です', status: 401 };
    if (res.status >= 400) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    return { ok: true, data: JSON.parse(res.body) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// IPC: open external
ipcMain.handle('shell:openExternal', (_e, { url }: { url: string }) => {
  return openHttpExternal(url);
});

// Lifecycle
app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});
app.on('window-all-closed', () => { app.quit(); });
