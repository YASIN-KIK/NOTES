const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, globalShortcut } = require('electron');
let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (e) { console.error('autoUpdater unavailable', e?.message); }
const path = require('path');

const isDev = !app.isPackaged;
let mainWindow = null;
let tray = null;
let trayHintShown = false;
app.isQuitting = false;

// Only one copy of the app may run. A second launch re-opens the existing window
// instead of starting a duplicate that fights over the same notes file.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    showWindow();
    const invite = (argv || []).find((a) => a.startsWith('notes://join/'));
    if (invite && mainWindow && !mainWindow.isDestroyed()) {
      const code = invite.slice('notes://join/'.length).toUpperCase();
      if (code) mainWindow.webContents.send('collab-join', code);
    }
  });
}
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (url.startsWith('notes://join/') && mainWindow && !mainWindow.isDestroyed()) {
    showWindow();
    mainWindow.webContents.send('collab-join', url.slice('notes://join/'.length).toUpperCase());
  }
});

async function callAI({ baseUrl, apiKey, model, messages }) {
  const url = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model: model || 'gpt-4o-mini', messages, temperature: 0.7 }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AI request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('No content returned from AI');
  return content;
}

function createTray() {
  try {
    const icon = nativeImage.createFromPath(process.execPath);
    const img = icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 });
    tray = new Tray(img);
    const menu = Menu.buildFromTemplate([
      { label: 'Show Notes', click: () => showWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ]);
    tray.setToolTip('Notes');
    tray.setContextMenu(menu);
    tray.on('double-click', () => showWindow());
    tray.on('click', () => showWindow());
  } catch (e) {
    console.error('tray failed:', e?.message || e);
  }
}

// Bring the existing window back, or build a new one if it was destroyed.
function showWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  createWindow();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 820,
    minHeight: 520,
    title: 'Notes',
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  mainWindow = win;
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });

  win.webContents.on('context-menu', (_event, params) => {
    const menuItems = [];
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 6)) {
        menuItems.push({ label: suggestion, click: () => win.webContents.replaceMisspelling(suggestion) });
      }
      if (params.dictionarySuggestions.length === 0) {
        menuItems.push({ label: 'No suggestions', enabled: false });
      }
      menuItems.push({ type: 'separator' });
      menuItems.push({ label: 'Add to dictionary', click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
      menuItems.push({ type: 'separator' });
    }
    menuItems.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    const menu = Menu.buildFromTemplate(menuItems);
    menu.popup({ window: win });
  });

  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
      // Tell the user once that the app is still alive in the tray.
      if (!trayHintShown && tray) {
        trayHintShown = true;
        try {
          tray.displayBalloon({
            title: 'Notes is still running',
            content: 'It lives in the tray. Click the tray icon to reopen, or use Quit to exit.',
          });
        } catch (err) { /* balloons not supported */ }
      }
    }
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

if (gotSingleInstanceLock) app.whenReady().then(() => {
  // Lets a host send notes://join/CODE links that open this app directly.
  try { app.setAsDefaultProtocolClient('notes'); } catch (e) { console.error('protocol registration failed', e?.message); }
  ipcMain.handle('app:setAutoLaunch', async (_event, enabled) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: false });
      return { ok: true };
    } catch (err) { return { ok: false, error: err?.message || String(err) }; }
  });
  ipcMain.handle('app:getAutoLaunch', async () => {
    try {
      const s = app.getLoginItemSettings();
      return { ok: true, enabled: !!s.openAtLogin };
    } catch (err) { return { ok: false, error: err?.message || String(err) }; }
  });
  ipcMain.handle('app:printToPDF', async (_event, html) => {
    try {
      const { BrowserWindow } = require('electron');
      const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      const data = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
      win.close();
      return { ok: true, data: Array.from(data) };
    } catch (err) { return { ok: false, error: err?.message || String(err) }; }
  });

  ipcMain.handle('app:setSpellCheckerLanguages', async (_event, langs) => {
    try {
      const { session } = require('electron');
      session.defaultSession.setSpellCheckerLanguages(Array.isArray(langs) ? langs : [langs]);
      return { ok: true };
    } catch (err) { return { ok: false, error: err?.message || String(err) }; }
  });

  ipcMain.handle('app:openExternal', async (_event, url) => {
    try { await shell.openExternal(url); return { ok: true }; }
    catch (err) { return { ok: false, error: err?.message || String(err) }; }
  });
  ipcMain.handle('ai:chat', async (_event, payload) => {
    try {
      const content = await callAI(payload);
      return { ok: true, content };
    } catch (err) { return { ok: false, error: err?.message || String(err) }; }
  });

  createWindow();
  createTray();
  try {
    globalShortcut.register('CommandOrControl+Shift+N', () => {
      showWindow();
      if (mainWindow) mainWindow.webContents.send('quick-capture');
    });
  } catch (e) { console.error('shortcut failed', e?.message); }

  if (autoUpdater && !isDev) {
    autoUpdater.autoDownload = false;
    autoUpdater.on('update-available', (info) => {
      if (mainWindow) mainWindow.webContents.send('update-available', info?.version);
    });
    autoUpdater.on('error', (err) => console.error('updater error', err?.message));
    autoUpdater.checkForUpdates().catch((e) => console.error('checkForUpdates failed', e?.message));
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on('window-all-closed', () => {
  // keep running in tray; quit only when explicitly quitting
  if (app.isQuitting || process.platform !== 'darwin') {
    // do not quit on last window close (tray keeps app alive)
  }
});

app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
