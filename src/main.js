const { app, BrowserWindow, ipcMain, safeStorage, dialog, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Engine, ENCODERS } = require('./obs-engine');

const ENGINE_PORT = 4466; // not 4455, so a normal OBS install never clashes

let win = null;
let engine = null;
let settings = null;
let detected = { encoder: 'x264', gpu: 'No supported graphics chip found' };
let isLive = false;
let quitting = false;

// Phone (9:16) is the default canvas.
function defaults() {
  return {
    general: { confirmStart: true, confirmStop: true, autoRecord: false, snapping: true, safeZones: true, theme: 'dark', perf: false },
    video: { baseW: 1080, baseH: 1920, outW: 1080, outH: 1920, fps: 30, filter: 'bicubic' },
    output: { encoder: 'auto', bitrate: 4500, audioBitrate: 160, recPath: app.getPath('videos'), recQuality: 'Stream', recFormat: 'fragmented_mp4' },
    audio: { sampleRate: 48000, channels: 'Stereo' },
    advanced: { priority: 'AboveNormal', colorSpace: '709', colorRange: 'Partial', dynamicBitrate: false, netOptimize: false },
    access: { selColor: '#e5383b', hoverColor: '#ffffff' },
    hotkeys: {},
    destination: { platform: 'tiktok', server: '' },
    keyEnc: null,
    keyPlain: false,
    enginePassword: null,
    v: 2
  };
}
const SECTIONS = ['general', 'video', 'output', 'audio', 'advanced', 'access'];

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { s = {}; }
  const d = defaults();
  const out = Object.assign({}, d);
  for (const k of SECTIONS) out[k] = Object.assign({}, d[k], s[k] || {});
  out.hotkeys = s.hotkeys || {};
  if (s.destination) out.destination = s.destination;
  out.keyEnc = s.keyEnc || null;
  out.keyPlain = !!s.keyPlain;
  out.enginePassword = s.enginePassword || crypto.randomBytes(18).toString('base64url');
  if (s.perf != null && !s.general) out.general.perf = !!s.perf; // from the first version
  return out;
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

function publicSettings() {
  const { keyEnc, keyPlain, enginePassword, ...rest } = settings;
  return JSON.parse(JSON.stringify(Object.assign(rest, { hasKey: !!keyEnc })));
}

function encryptKey(key) {
  if (safeStorage.isEncryptionAvailable()) {
    settings.keyEnc = safeStorage.encryptString(key).toString('base64');
    settings.keyPlain = false;
  } else {
    settings.keyEnc = Buffer.from(key, 'utf8').toString('base64');
    settings.keyPlain = true;
  }
}

function decryptKey() {
  if (!settings.keyEnc) return '';
  const buf = Buffer.from(settings.keyEnc, 'base64');
  try {
    return settings.keyPlain ? buf.toString('utf8') : safeStorage.decryptString(buf);
  } catch {
    return '';
  }
}

// Pick the hardware encoder from the graphics chips Windows reports.
async function detectEncoder() {
  try {
    const info = await app.getGPUInfo('basic');
    const ids = (info.gpuDevice || []).map((d) => d.vendorId);
    if (ids.includes(0x10de)) return { encoder: 'nvenc', gpu: 'NVIDIA graphics' };
    if (ids.includes(0x1002)) return { encoder: 'amd', gpu: 'AMD graphics' };
    if (ids.includes(0x8086)) return { encoder: 'qsv', gpu: 'Intel graphics' };
  } catch { /* fall through */ }
  return { encoder: 'x264', gpu: 'No supported graphics chip found' };
}

const activeEncoder = () => (settings.output.encoder === 'auto' ? detected.encoder : settings.output.encoder);

function engineOpts() {
  return { video: settings.video, output: settings.output, audio: settings.audio, advanced: settings.advanced, encoder: activeEncoder() };
}

function engineInfo() {
  const enc = activeEncoder();
  return {
    port: ENGINE_PORT,
    password: settings.enginePassword,
    status: engine ? engine.status : 'stopped',
    statusDetail: engine ? engine.detail : '',
    encoder: enc,
    encoderLabel: ENCODERS[enc],
    detectedEncoder: detected.encoder,
    detectedGpu: detected.gpu,
    encoders: ENCODERS,
    videoLabel: `${settings.video.outW}x${settings.video.outH} · ${settings.video.fps} fps`
  };
}

// ---- global hotkeys (work while a game has focus) ----
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const failed = [];
  for (const [action, accel] of Object.entries(settings.hotkeys || {})) {
    if (!accel) continue;
    try {
      const ok = globalShortcut.register(accel, () => {
        if (win && !win.isDestroyed()) win.webContents.send('hotkey', action);
      });
      if (!ok) failed.push(accel);
    } catch {
      failed.push(accel);
    }
  }
  return failed;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#17181e',
    autoHideMenuBar: true,
    title: 'Tonix-Lab-LIVE',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    if (quitting || !isLive) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Keep streaming', 'Stop stream and quit'],
      defaultId: 0,
      cancelId: 0,
      title: 'You are live',
      message: 'You are still live. Quitting will end your stream.'
    });
    if (choice === 0) e.preventDefault();
  });
}

function sendStatus(s) {
  if (win && !win.isDestroyed()) win.webContents.send('engine:status', s);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    settings = loadSettings();
    saveSettings();
    detected = await detectEncoder();

    const obsDir = app.isPackaged
      ? path.join(process.resourcesPath, 'obs')
      : path.join(__dirname, '..', 'obs');
    engine = new Engine({
      obsDir,
      configRoot: path.join(app.getPath('userData'), 'engine-config'),
      port: ENGINE_PORT,
      password: settings.enginePassword,
      onStatus: sendStatus
    });

    ipcMain.handle('engine:info', () => engineInfo());
    ipcMain.handle('engine:restart', async () => {
      await engine.restart(engineOpts());
      return engineInfo();
    });
    ipcMain.handle('settings:get', () => publicSettings());
    ipcMain.handle('settings:save', (_e, patch) => {
      for (const k of SECTIONS) {
        if (patch && patch[k] && typeof patch[k] === 'object') settings[k] = Object.assign({}, settings[k], patch[k]);
      }
      saveSettings();
      return publicSettings();
    });
    ipcMain.handle('hotkeys:save', (_e, map) => {
      settings.hotkeys = {};
      for (const [k, v] of Object.entries(map || {})) if (typeof v === 'string' && v) settings.hotkeys[String(k)] = v;
      saveSettings();
      return registerHotkeys();
    });
    ipcMain.handle('dest:get', () => Object.assign({}, settings.destination, { key: decryptKey() }));
    ipcMain.handle('dest:save', (_e, d) => {
      settings.destination = { platform: String(d.platform || 'custom'), server: String(d.server || '') };
      if (typeof d.key === 'string' && d.key.length) encryptKey(d.key);
      saveSettings();
      return publicSettings();
    });
    ipcMain.handle('dialog:folder', async (_e, current) => {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: current || app.getPath('videos') });
      return r.canceled ? null : r.filePaths[0];
    });
    ipcMain.on('state:live', (_e, live) => { isLive = !!live; });

    createWindow();
    registerHotkeys();
    engine.start(engineOpts());
  });

  app.on('before-quit', async (e) => {
    if (quitting) return;
    quitting = true;
    globalShortcut.unregisterAll();
    if (engine && engine.proc) {
      e.preventDefault();
      await engine.stop();
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
}
