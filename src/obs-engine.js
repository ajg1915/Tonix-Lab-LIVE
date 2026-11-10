// Runs the OBS engine (libobs, capture, hardware encoders) hidden in the
// background. Tonix-Lab-LIVE is the only interface the user sees; it talks to
// the engine over a local, password-protected websocket.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROFILE = 'TonixLabLive';
const COLLECTION = 'TonixLabLive';

// Output size, frame rate and default bitrate for each quality preset.
// The canvas is always 1920x1080 so scenes look the same at every preset.
const QUALITY = {
  performance: { label: 'Performance · 720p30', w: 1280, h: 720, fps: 30, bitrate: 3000 },
  balanced: { label: 'Balanced · 720p60', w: 1280, h: 720, fps: 60, bitrate: 4500 },
  high: { label: 'High · 1080p60', w: 1920, h: 1080, fps: 60, bitrate: 6000 }
};

const ENCODERS = {
  nvenc: 'NVIDIA NVENC',
  amd: 'AMD AMF',
  qsv: 'Intel Quick Sync',
  x264: 'CPU (x264)'
};

// ---- tiny INI helpers (merge our keys into whatever OBS already saved) ----
function readIni(file) {
  const out = {};
  let section = null;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { section = sec[1]; out[section] = out[section] || {}; continue; }
    const eq = line.indexOf('=');
    if (eq > 0 && section) out[section][line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function writeIni(file, patch) {
  const data = readIni(file);
  for (const [sec, kv] of Object.entries(patch)) {
    data[sec] = Object.assign(data[sec] || {}, kv);
  }
  const lines = [];
  for (const [sec, kv] of Object.entries(data)) {
    lines.push(`[${sec}]`);
    for (const [k, v] of Object.entries(kv)) lines.push(`${k}=${v}`);
    lines.push('');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
}

class Engine {
  constructor({ obsDir, configRoot, port, password, onStatus }) {
    this.obsDir = obsDir;
    this.configRoot = configRoot;
    this.port = port;
    this.password = password;
    this.onStatus = onStatus || (() => {});
    this.proc = null;
    this.status = 'stopped';
    this.restarts = 0;
    this.stopping = false;
  }

  get exe() {
    return path.join(this.obsDir, 'bin', '64bit', 'obs64.exe');
  }

  setStatus(status, detail) {
    this.status = status;
    this.detail = detail || '';
    this.onStatus({ status, detail: detail || '' });
  }

  // OBS in portable mode keeps its settings in <obs>/config. We point that
  // folder at the app's own data folder so settings survive app updates and
  // never touch a normal OBS install on the same PC.
  linkConfigDir() {
    fs.mkdirSync(this.configRoot, { recursive: true });
    const link = path.join(this.obsDir, 'config');
    let st = null;
    try { st = fs.lstatSync(link); } catch { st = null; }
    if (st && st.isSymbolicLink()) {
      let same = false;
      try { same = fs.realpathSync(link) === fs.realpathSync(this.configRoot); } catch { same = false; }
      if (same) return this.configRoot;
      fs.unlinkSync(link);
    } else if (st) {
      return link; // a real folder already exists: use it as-is
    }
    fs.symlinkSync(this.configRoot, link, 'junction');
    return this.configRoot;
  }

  writeConfig({ quality, encoder, bitrate }) {
    const root = path.join(this.linkConfigDir(), 'obs-studio');
    const q = QUALITY[quality] || QUALITY.balanced;
    const appIni = {
      General: {
        FirstRun: 'true',
        EnableAutoUpdates: 'false',
        ProcessPriority: 'AboveNormal',
        WarnBeforeStartingStream: 'false',
        WarnBeforeStoppingStream: 'false'
      },
      BasicWindow: {
        SysTrayEnabled: 'true',
        SysTrayWhenStarted: 'true',
        SysTrayMinimizeToTray: 'true',
        PreviewEnabled: 'false'
      },
      Basic: {
        Profile: PROFILE,
        ProfileDir: PROFILE,
        SceneCollection: COLLECTION,
        SceneCollectionFile: COLLECTION
      }
    };
    // Newer OBS splits app and user settings across two files; write both.
    writeIni(path.join(root, 'global.ini'), appIni);
    writeIni(path.join(root, 'user.ini'), appIni);

    const enc = ENCODERS[encoder] ? encoder : 'x264';
    writeIni(path.join(root, 'basic', 'profiles', PROFILE, 'basic.ini'), {
      General: { Name: PROFILE },
      Video: {
        BaseCX: '1920',
        BaseCY: '1080',
        OutputCX: String(q.w),
        OutputCY: String(q.h),
        FPSType: '0',
        FPSCommon: String(q.fps),
        ScaleType: quality === 'performance' ? 'bilinear' : 'bicubic',
        ColorFormat: 'NV12'
      },
      Output: { Mode: 'Simple' },
      SimpleOutput: {
        StreamEncoder: enc,
        VBitrate: String(bitrate || q.bitrate),
        ABitrate: '160',
        UseAdvanced: 'false',
        Preset: quality === 'performance' ? 'superfast' : 'veryfast'
      },
      Audio: { SampleRate: '48000', ChannelSetup: 'Stereo' }
    });

    const wsDir = path.join(root, 'plugin_config', 'obs-websocket');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'config.json'), JSON.stringify({
      alerts_enabled: false,
      auth_required: true,
      first_load: false,
      server_enabled: true,
      server_password: this.password,
      server_port: this.port
    }, null, 2));
  }

  start(opts) {
    if (process.platform !== 'win32') {
      this.setStatus('error', 'The streaming engine only runs on Windows.');
      return;
    }
    if (!fs.existsSync(this.exe)) {
      this.setStatus('error', 'The streaming engine is missing. Reinstall Tonix-Lab-LIVE.');
      return;
    }
    try {
      this.writeConfig(opts);
    } catch (e) {
      this.setStatus('error', 'Could not write engine settings: ' + e.message);
      return;
    }
    this.stopping = false;
    this.setStatus('starting');
    const args = [
      '--portable', '--multi', '--minimize-to-tray',
      '--disable-shutdown-check', '--disable-updater', '--disable-missing-files-check',
      '--profile', PROFILE, '--collection', COLLECTION
    ];
    this.proc = spawn(this.exe, args, { cwd: path.dirname(this.exe), stdio: 'ignore' });
    this.proc.on('error', (e) => this.setStatus('error', 'Engine failed to start: ' + e.message));
    this.proc.on('exit', () => {
      this.proc = null;
      if (this.stopping) { this.setStatus('stopped'); return; }
      if (this.restarts < 3) {
        this.restarts += 1;
        this.setStatus('starting', 'Engine closed unexpectedly, restarting…');
        setTimeout(() => this.start(opts), 1500);
      } else {
        this.setStatus('error', 'The engine keeps closing. Try Settings › Encoder › CPU (x264).');
      }
    });
    this.setStatus('running');
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.proc) return resolve();
      this.stopping = true;
      const pid = this.proc.pid;
      const proc = this.proc;
      const done = () => resolve();
      proc.once('exit', done);
      execFile('taskkill', ['/PID', String(pid), '/T'], () => {});
      setTimeout(() => {
        if (this.proc === proc) execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {});
        setTimeout(done, 1000);
      }, 4000);
    });
  }

  async restart(opts) {
    this.restarts = 0;
    await this.stop();
    this.start(opts);
  }
}

module.exports = { Engine, QUALITY, ENCODERS };
