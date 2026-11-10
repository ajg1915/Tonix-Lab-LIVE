const { app, BrowserWindow, ipcMain, safeStorage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Engine, QUALITY, ENCODERS } = require('./obs-engine');

const ENGINE_PORT = 4466; // not 4455, so a normal OBS install never clashes

let win = null;
let engine = null;
let settings = null;
let detected = { encoder: 'x264', gpu: 'No supported graphics chip found' };
let isLive = false;
let quitting = false;

const DEFAULTS = {
  quality: 'balanced',
  encoder: 'auto',
  bitrate: 0,
  perf: false,
  destination: { platform: 'youtube', server: 'rtmp://a.rtmp.youtube.com/live2' },
  keyEnc: null,
  keyPlain: false,
  enginePassword: null
};

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { s = {}; }
  s = Object.assign({}, DEFAULTS, s);
  if (!s.enginePassword) s.enginePassword = crypto.randomBytes(18).toString('base64url');
  return s;
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

function publicSettings() {
  const { keyEnc, keyPlain, enginePassword, ...rest } = settings;
  return Object.assign(rest, { hasKey: !!keyEnc });
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

function engineOpts() {
  const encoder = settings.encoder === 'auto' ? detected.encoder : settings.encoder;
  return { quality: settings.quality, encoder, bitrate: settings.bitrate };
}

function engineInfo() {
  const opts = engineOpts();
  return {
    port: ENGINE_PORT,
    password: settings.enginePassword,
    status: engine ? engine.status : 'stopped',
    statusDetail: engine ? engine.detail : '',
    encoder: opts.encoder,
    encoderLabel: ENCODERS[opts.encoder],
    detectedEncoder: detected.encoder,
    detectedGpu: detected.gpu,
    qualityLabel: (QUALITY[settings.quality] || QUALITY.balanced).label,
    qualities: Object.fromEntries(Object.entries(QUALITY).map(([k, v]) => [k, v.label])),
    encoders: ENCODERS
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0B0E12',
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
      buttons: ['Keep streaming', 'End stream and quit'],
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
      const allowed = ['quality', 'encoder', 'bitrate', 'perf'];
      for (const k of allowed) if (patch && k in patch) settings[k] = patch[k];
      saveSettings();
      return publicSettings();
    });
    ipcMain.handle('dest:get', () => Object.assign({}, settings.destination, { key: decryptKey() }));
    ipcMain.handle('dest:save', (_e, d) => {
      settings.destination = { platform: String(d.platform || 'custom'), server: String(d.server || '') };
      if (typeof d.key === 'string' && d.key.length) encryptKey(d.key);
      saveSettings();
      return publicSettings();
    });
    ipcMain.on('state:live', (_e, live) => { isLive = !!live; });

    createWindow();
    engine.start(engineOpts());
  });

  app.on('before-quit', async (e) => {
    if (quitting) return;
    quitting = true;
    if (engine && engine.proc) {
      e.preventDefault();
      await engine.stop();
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
}
