/* Tonix-Lab-LIVE control room. Talks to the hidden OBS engine over obs-websocket v5. */
(function () {
  'use strict';

  const obs = new OBSWebSocket();
  const ES = OBSWebSocket.EventSubscription;
  const $ = (id) => document.getElementById(id);

  const PLATFORMS = {
    youtube: { name: 'YouTube', server: 'rtmp://a.rtmp.youtube.com/live2', help: 'YouTube Studio › Go live › Stream › Stream key' },
    facebook: { name: 'Facebook', server: 'rtmps://live-api-s.facebook.com:443/rtmp/', help: 'Facebook Live Producer › Streaming software › Stream key' },
    twitch: { name: 'Twitch', server: 'rtmp://live.twitch.tv/app', help: 'Twitch Creator Dashboard › Settings › Stream › Primary stream key' },
    tiktok: { name: 'TikTok', server: '', help: 'TikTok LIVE Studio or LIVE Center gives you a server URL and stream key (only some accounts have this).' },
    custom: { name: 'My server / Custom RTMP', server: '', help: 'Paste the RTMP server URL and stream key for your own server or any other platform.' }
  };

  const KIND_LABEL = {
    game_capture: 'Game capture',
    monitor_capture: 'Screen',
    window_capture: 'Window',
    dshow_input: 'Camera / HDMI capture',
    wasapi_input_capture: 'Microphone',
    wasapi_output_capture: 'PC audio',
    image_source: 'Image',
    ffmpeg_source: 'Media',
    browser_source: 'Browser'
  };

  const state = {
    connected: false,
    info: null,
    settings: null,
    dest: null,
    scenes: [],
    pgm: null,
    pvw: null,
    transitions: [],
    transition: null,
    live: false,
    liveStartedAt: 0,
    startAttemptAt: 0,
    lastBytes: 0,
    lastBytesAt: 0,
    lagBase: null,
    lastLag: 0,
    kinds: [],
    base: { w: 1920, h: 1080 },
    channels: new Map(),
    meterQueue: null,
    tick: 0
  };

  // ---------- small DOM helper ----------
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid);
    return n;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = (req, data) => obs.call(req, data);

  // ---------- modal ----------
  let modalClose = null;
  function openModal(title, body, actions) {
    $('modalTitle').textContent = title;
    const b = $('modalBody');
    b.replaceChildren(...[].concat(body || []));
    const a = $('modalActions');
    a.replaceChildren(...actions.map((x) => el('button', {
      class: 'btn ' + (x.kind || ''), type: 'button', text: x.label,
      onClick: async () => { if (x.run) { const keep = await x.run(); if (keep === true) return; } closeModal(); }
    })));
    $('modal').classList.remove('hidden');
    const first = b.querySelector('input,select,button') || a.querySelector('button');
    if (first) first.focus();
    modalClose = () => $('modal').classList.add('hidden');
  }
  function closeModal() { if (modalClose) modalClose(); }
  function notice(title, text) { openModal(title, el('p', { text }), [{ label: 'OK', kind: 'primary' }]); }
  function askText(title, label, value) {
    return new Promise((resolve) => {
      const input = el('input', { type: 'text', value: value || '' });
      openModal(title, el('label', { class: 'field' }, label, input), [
        { label: 'Cancel', run: () => resolve(null) },
        { label: 'Save', kind: 'primary', run: () => resolve(input.value.trim() || null) }
      ]);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { resolve(input.value.trim() || null); closeModal(); } });
    });
  }
  function confirmBox(title, text, okLabel) {
    return new Promise((resolve) => {
      openModal(title, el('p', { text }), [
        { label: 'Cancel', run: () => resolve(false) },
        { label: okLabel || 'OK', kind: 'primary', run: () => resolve(true) }
      ]);
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('modal').classList.contains('hidden')) closeModal();
  });

  // ---------- overlay / connection ----------
  function overlay(msg, retry) {
    $('overlay').classList.remove('hidden');
    $('overlayMsg').textContent = msg;
    $('overlayRetry').classList.toggle('hidden', !retry);
  }
  function hideOverlay() { $('overlay').classList.add('hidden'); }

  let connecting = false;
  async function connectLoop() {
    if (connecting) return;
    connecting = true;
    state.info = await window.tonix.engineInfo();
    for (let i = 0; i < 90 && !state.connected; i++) {
      if (state.info.status === 'error') break;
      try {
        await obs.connect(`ws://127.0.0.1:${state.info.port}`, state.info.password, {
          eventSubscriptions: ES.All | ES.InputVolumeMeters
        });
        state.connected = true;
      } catch {
        await sleep(1000);
        state.info = await window.tonix.engineInfo();
      }
    }
    connecting = false;
    if (state.connected) {
      try { await init(); hideOverlay(); } catch (e) { overlay('Could not set up the studio: ' + (e.message || e), true); }
    } else if (state.info.status === 'error') {
      overlay(state.info.statusDetail || 'The engine could not start.', true);
    } else {
      overlay('The engine did not respond. Make sure nothing is blocking Tonix-Lab-LIVE, then try again.', true);
    }
  }

  window.tonix.onEngineStatus((s) => {
    if (s.status === 'error') overlay(s.detail, true);
    else if (s.status === 'starting' && !state.connected) overlay(s.detail || 'Starting the engine…');
    else if (s.status === 'running' && !state.connected) connectLoop();
  });

  obs.on('ConnectionClosed', () => {
    const was = state.connected;
    state.connected = false;
    if (was) { overlay('Reconnecting to the engine…'); setTimeout(connectLoop, 1500); }
  });

  $('overlayRetry').addEventListener('click', async () => {
    overlay('Restarting the engine…');
    state.info = await window.tonix.restartEngine();
    connectLoop();
  });

  // ---------- setup ----------
  function pickKind(prefix) {
    return state.kinds.find((k) => k === prefix) || state.kinds.find((k) => k.startsWith(prefix)) || null;
  }

  async function init() {
    state.settings = await window.tonix.getSettings();
    state.dest = await window.tonix.getDestination();
    state.lagBase = null;
    state.lastLag = 0;
    const v = await call('GetVideoSettings');
    state.base = { w: v.baseWidth, h: v.baseHeight };
    state.kinds = (await call('GetInputKindList', { unversioned: false })).inputKinds;
    await call('SetStudioModeEnabled', { studioModeEnabled: true });

    const list = await call('GetSceneList');
    const names = list.scenes.map((s) => s.sceneName);
    if (names.length <= 1 && (names[0] === 'Scene' || names.length === 0)) await seedScenes(names);

    setPerf(!!state.settings.perf, false);
    $('statEnc').textContent = state.info.encoderLabel;
    await refreshScenes();
    await refreshTransitions();
    const st = await call('GetStreamStatus');
    setLive(st.outputActive);
    renderDest();
    startLoops();
  }

  async function uniqueName(base) {
    const { inputs } = await call('GetInputList');
    const taken = new Set(inputs.map((i) => i.inputName));
    const sceneNames = new Set(state.scenes);
    if (!taken.has(base) && !sceneNames.has(base)) return base;
    for (let n = 2; ; n++) { const c = `${base} ${n}`; if (!taken.has(c) && !sceneNames.has(c)) return c; }
  }

  async function addInput(sceneName, inputName, inputKind, inputSettings) {
    const r = await call('CreateInput', { sceneName, inputName, inputKind, inputSettings: inputSettings || {}, sceneItemEnabled: true });
    return r.sceneItemId;
  }

  async function fitItem(sceneName, sceneItemId) {
    await call('SetSceneItemTransform', {
      sceneName, sceneItemId,
      sceneItemTransform: {
        positionX: 0, positionY: 0, alignment: 5,
        boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0,
        boundsWidth: state.base.w, boundsHeight: state.base.h
      }
    });
  }

  async function addText(sceneName, inputName, text) {
    const kind = pickKind('text_gdiplus');
    if (!kind) return;
    const id = await addInput(sceneName, inputName, kind, { text, font: { face: 'Arial', size: 120, style: 'Bold', flags: 1 } });
    await call('SetSceneItemTransform', { sceneName, sceneItemId: id, sceneItemTransform: { positionX: state.base.w / 2, positionY: state.base.h / 2, alignment: 0 } });
  }

  async function addBackground(sceneName, inputName) {
    const kind = pickKind('color_source');
    if (!kind) return;
    await addInput(sceneName, inputName, kind, { color: 0xFF120E0B, width: state.base.w, height: state.base.h });
  }

  async function listItems(inputName, prop) {
    try {
      const r = await call('GetInputPropertiesListPropertyItems', { inputName, propertyName: prop });
      return r.propertyItems.filter((i) => i.itemEnabled !== false && i.itemValue !== '' && i.itemValue != null)
        .map((i) => ({ name: i.itemName, value: i.itemValue }));
    } catch { return []; }
  }

  // First run: build a starter show the user can change.
  async function seedScenes(existing) {
    overlay('Setting up your starter scenes…');
    const tryStep = async (fn) => { try { await fn(); } catch (e) { console.warn(e); } };
    await tryStep(async () => {
      await call('CreateScene', { sceneName: 'Starting Soon' });
      await addBackground('Starting Soon', 'Starting Soon Background');
      await addText('Starting Soon', 'Starting Soon Title', 'STARTING SOON');
    });
    await tryStep(async () => {
      await call('CreateScene', { sceneName: 'Gameplay' });
      const id = await addInput('Gameplay', 'Game Capture', 'game_capture', { capture_mode: 'any_fullscreen' });
      await fitItem('Gameplay', id);
    });
    await tryStep(async () => {
      await call('CreateScene', { sceneName: 'Screen' });
      const id = await addInput('Screen', 'Main Screen', 'monitor_capture', {});
      await fitItem('Screen', id);
    });
    await tryStep(async () => {
      await call('CreateScene', { sceneName: 'Camera' });
      const id = await addInput('Camera', 'Camera 1', 'dshow_input', {});
      const devices = await listItems('Camera 1', 'video_device_id');
      if (devices.length) await call('SetInputSettings', { inputName: 'Camera 1', inputSettings: { video_device_id: devices[0].value } });
      await fitItem('Camera', id);
    });
    await tryStep(async () => {
      await call('CreateScene', { sceneName: 'Be Right Back' });
      await addBackground('Be Right Back', 'BRB Background');
      await addText('Be Right Back', 'BRB Title', 'BE RIGHT BACK');
    });
    await tryStep(async () => {
      await call('SetCurrentProgramScene', { sceneName: 'Starting Soon' });
      await call('SetCurrentPreviewScene', { sceneName: 'Gameplay' });
    });
    for (const n of existing) await tryStep(() => call('RemoveScene', { sceneName: n }));
    overlay('Starting the engine…');
  }

  // ---------- scenes / switcher ----------
  async function refreshScenes() {
    const r = await call('GetSceneList');
    state.scenes = r.scenes.slice().sort((a, b) => b.sceneIndex - a.sceneIndex).map((s) => s.sceneName);
    state.pgm = r.currentProgramSceneName;
    state.pvw = r.currentPreviewSceneName;
    renderScenes();
    refreshShot();
  }

  function renderScenes() {
    $('pgmName').textContent = state.pgm || '–';
    $('pvwName').textContent = state.pvw || '–';
    $('shotScene').textContent = state.pvw || '–';
    const mv = $('multiview');
    const keep = new Map([...mv.querySelectorAll('.tile')].map((t) => [t.dataset.scene, t.querySelector('img')]));
    mv.replaceChildren(...state.scenes.map((name, i) => {
      const isPgm = name === state.pgm, isPvw = name === state.pvw;
      const img = keep.get(name) || el('img', { alt: '' });
      return el('button', {
        class: 'tile' + (isPgm ? ' is-pgm' : isPvw ? ' is-pvw' : ''), type: 'button',
        'data-scene': name, 'aria-label': `Send ${name} to preview`,
        onClick: () => setPreview(name)
      },
      el('span', { class: 'tile-tag' }, el('span', { text: `${i + 1} · ${name}` }), el('span', { text: isPgm ? 'PGM' : isPvw ? 'PVW' : '' })),
      el('span', { class: 'tile-img' }, img));
    }));
    const row = (lit, fn, label) => state.scenes.map((name, i) => el('button', {
      class: 'key' + (name === state[lit] ? ' lit-' + lit : ''), type: 'button', title: name,
      'aria-label': `${label} ${name}`, onClick: () => fn(name)
    }, `${i + 1} ${name}`));
    $('pgmRow').replaceChildren(...row('pgm', setProgram, 'Cut to program:'));
    $('pvwRow').replaceChildren(...row('pvw', setPreview, 'Preview'));
  }

  async function setPreview(name) { try { await call('SetCurrentPreviewScene', { sceneName: name }); } catch (e) { console.warn(e); } }
  async function setProgram(name) { try { await call('SetCurrentProgramScene', { sceneName: name }); } catch (e) { console.warn(e); } }

  async function take() { try { await call('TriggerStudioModeTransition'); } catch (e) { console.warn(e); } }
  async function cut() {
    const hasCut = state.transitions.some((t) => t.transitionName === 'Cut');
    if (!hasCut || state.transition === 'Cut') return take();
    const prev = state.transition;
    try {
      await call('SetCurrentSceneTransition', { transitionName: 'Cut' });
      await call('TriggerStudioModeTransition');
    } finally {
      setTimeout(() => call('SetCurrentSceneTransition', { transitionName: prev }).catch(() => {}), 150);
    }
  }

  async function refreshTransitions() {
    const r = await call('GetSceneTransitionList');
    state.transitions = r.transitions;
    state.transition = r.currentSceneTransitionName;
    try {
      const cur = await call('GetCurrentSceneTransition');
      if (cur.transitionDuration) {
        const sel = $('durSel');
        const v = String(cur.transitionDuration);
        if (![...sel.options].some((o) => o.value === v)) sel.append(el('option', { value: v, text: (cur.transitionDuration / 1000) + ' s' }));
        sel.value = v;
      }
    } catch { /* fixed transitions have no duration */ }
    renderTransitions();
  }
  function renderTransitions() {
    $('fxRow').replaceChildren(...state.transitions.map((t) => el('button', {
      class: 'key' + (t.transitionName === state.transition ? ' lit-fx' : ''), type: 'button',
      onClick: () => call('SetCurrentSceneTransition', { transitionName: t.transitionName }).catch(() => {})
    }, t.transitionName)));
  }
  $('durSel').addEventListener('change', (e) => {
    call('SetCurrentSceneTransitionDuration', { transitionDuration: Number(e.target.value) }).catch(() => {});
  });

  $('takeBtn').addEventListener('click', take);
  $('cutBtn').addEventListener('click', cut);

  $('newSceneBtn').addEventListener('click', async () => {
    const name = await askText('New scene', 'Scene name', '');
    if (!name) return;
    try {
      await call('CreateScene', { sceneName: name });
      await setPreview(name);
    } catch (e) { notice('Could not create scene', e.message || String(e)); }
  });
  $('renameSceneBtn').addEventListener('click', async () => {
    const old = state.pvw;
    if (!old) return;
    const name = await askText('Rename scene', 'Scene name', old);
    if (!name || name === old) return;
    try { await call('SetSceneName', { sceneName: old, newSceneName: name }); } catch (e) { notice('Could not rename', e.message || String(e)); }
  });
  $('deleteSceneBtn').addEventListener('click', async () => {
    const name = state.pvw;
    if (!name) return;
    if (state.scenes.length <= 1) return notice('Keep one scene', 'You need at least one scene.');
    if (name === state.pgm) return notice('Scene is on air', 'Take a different scene to program before deleting this one.');
    if (!(await confirmBox('Delete scene', `Delete "${name}"? Its sources stay available to other scenes.`, 'Delete'))) return;
    try {
      const next = state.scenes.find((s) => s !== name && s !== state.pgm) || state.pgm;
      await setPreview(next);
      await call('RemoveScene', { sceneName: name });
    } catch (e) { notice('Could not delete', e.message || String(e)); }
  });

  // Keyboard: 1-9 preview a scene, Enter = TAKE, C = CUT.
  document.addEventListener('keydown', (e) => {
    if (!$('modal').classList.contains('hidden') || !state.connected) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (/^[1-9]$/.test(e.key)) { const s = state.scenes[Number(e.key) - 1]; if (s) setPreview(s); }
    else if (e.key === 'Enter' && t.tagName !== 'BUTTON') take();
    else if (e.key === 'c' || e.key === 'C') cut();
  });

  // ---------- next shot (sources in the preview scene) ----------
  async function refreshShot() {
    const box = $('shotItems');
    if (!state.pvw) { box.replaceChildren(); return; }
    let items = [];
    try { items = (await call('GetSceneItemList', { sceneName: state.pvw })).sceneItems; } catch { items = []; }
    items = items.slice().sort((a, b) => b.sceneItemIndex - a.sceneItemIndex);
    if (!items.length) {
      box.replaceChildren(el('div', { class: 'empty', text: 'No sources yet. Add a game, screen, camera or capture card.' }));
      return;
    }
    const scene = state.pvw;
    box.replaceChildren(...items.map((it) => el('div', { class: 'item' },
      el('button', {
        class: 'icon-btn', type: 'button', 'aria-pressed': String(it.sceneItemEnabled),
        'aria-label': (it.sceneItemEnabled ? 'Hide ' : 'Show ') + it.sourceName,
        onClick: () => call('SetSceneItemEnabled', { sceneName: scene, sceneItemId: it.sceneItemId, sceneItemEnabled: !it.sceneItemEnabled }).catch(() => {})
      }, it.sceneItemEnabled ? 'On' : 'Off'),
      el('div', { class: 'item-text' },
        el('span', { class: 'item-name', text: it.sourceName }),
        el('span', { class: 'muted small-t', text: KIND_LABEL[it.inputKind] || (it.isGroup ? 'Group' : (it.inputKind || 'Source')) })),
      el('button', { class: 'icon-btn', type: 'button', title: 'Fit to screen', onClick: () => fitItem(scene, it.sceneItemId).catch(() => {}) }, 'Fit'),
      el('button', {
        class: 'icon-btn', type: 'button', 'aria-label': 'Remove ' + it.sourceName,
        onClick: async () => {
          if (await confirmBox('Remove source', `Remove "${it.sourceName}" from ${scene}?`, 'Remove')) {
            call('RemoveSceneItem', { sceneName: scene, sceneItemId: it.sceneItemId }).catch(() => {});
          }
        }
      }, '✕')
    )));
  }

  const SOURCE_TYPES = [
    { id: 'game', label: 'Game capture', hint: 'Hooks into the game for smooth capture', kind: 'game_capture', base: 'Game Capture', settings: { capture_mode: 'any_fullscreen' }, fit: true },
    { id: 'camera', label: 'Camera / HDMI capture', hint: 'Webcam or capture card', kind: 'dshow_input', base: 'Camera', prop: 'video_device_id', fit: true },
    { id: 'screen', label: 'Screen', hint: 'A whole monitor', kind: 'monitor_capture', base: 'Screen', prop: ['monitor_id', 'monitor'], fit: true },
    { id: 'window', label: 'Window', hint: 'One app window', kind: 'window_capture', base: 'Window', prop: 'window', fit: true },
    { id: 'mic', label: 'Microphone', hint: 'A mic or audio interface', kind: 'wasapi_input_capture', base: 'Mic', prop: 'device_id' },
    { id: 'image', label: 'Image / logo', hint: 'PNG, JPG or GIF', kind: 'image_source', base: 'Image' },
    { id: 'text', label: 'Text', hint: 'Titles and lower thirds', kindPrefix: 'text_gdiplus', base: 'Text' },
    { id: 'color', label: 'Color background', hint: 'Solid full-screen color', kindPrefix: 'color_source', base: 'Background' }
  ];

  $('addSourceBtn').addEventListener('click', () => openAddSource());

  async function openAddSource() {
    const scene = state.pvw;
    if (!scene) return;
    let existing = [];
    try {
      const { inputs } = await call('GetInputList');
      const inScene = new Set((await call('GetSceneItemList', { sceneName: scene })).sceneItems.map((i) => i.sourceName));
      existing = inputs.filter((i) => !inScene.has(i.inputName) && KIND_LABEL[i.inputKind] && !/^wasapi/.test(i.inputKind));
    } catch { existing = []; }
    const body = [
      el('p', { text: `Adds to ${scene} (the scene in Preview).` }),
      el('div', { class: 'choice-grid' }, SOURCE_TYPES.map((t) => el('button', {
        class: 'choice', type: 'button', onClick: () => createSource(scene, t)
      }, el('b', { text: t.label }), el('span', { text: t.hint }))))
    ];
    if (existing.length) {
      body.push(el('p', { text: 'Or reuse a source you already have:' }));
      body.push(el('div', { class: 'choice-grid' }, existing.map((i) => el('button', {
        class: 'choice', type: 'button',
        onClick: async () => {
          closeModal();
          try {
            const r = await call('CreateSceneItem', { sceneName: scene, sourceName: i.inputName });
            if (['game_capture', 'dshow_input', 'monitor_capture', 'window_capture'].includes(i.inputKind)) await fitItem(scene, r.sceneItemId);
          } catch (e) { notice('Could not add', e.message || String(e)); }
        }
      }, el('b', { text: i.inputName }), el('span', { text: KIND_LABEL[i.inputKind] })))));
    }
    openModal('Add source', body, [{ label: 'Close' }]);
  }

  async function createSource(scene, t) {
    const kind = t.kind || pickKind(t.kindPrefix);
    if (!kind || (t.kind && !state.kinds.includes(t.kind))) return notice('Not available', `${t.label} is not available on this PC.`);
    let settings = Object.assign({}, t.settings || {});
    if (t.id === 'text') {
      const text = await askText('Add text', 'Text to show', '');
      if (!text) return;
      settings = { text, font: { face: 'Arial', size: 96, style: 'Bold', flags: 1 } };
    }
    if (t.id === 'color') settings = { color: 0xFF120E0B, width: state.base.w, height: state.base.h };
    if (t.id === 'image') {
      const file = await pickFile();
      if (!file) return;
      settings = { file };
    }
    closeModal();
    try {
      const name = await uniqueName(t.base);
      const id = await addInput(scene, name, kind, settings);
      if (t.fit) await fitItem(scene, id);
      if (t.id === 'text') await call('SetSceneItemTransform', { sceneName: scene, sceneItemId: id, sceneItemTransform: { positionX: state.base.w / 2, positionY: state.base.h * 0.85, alignment: 0 } });
      if (t.prop) await pickDevice(name, t, scene, id);
    } catch (e) { notice('Could not add source', e.message || String(e)); }
  }

  function pickFile() {
    return new Promise((resolve) => {
      const input = el('input', { type: 'file', accept: 'image/*' });
      input.addEventListener('change', () => resolve(input.files[0] ? window.tonix.filePath(input.files[0]) : null));
      input.addEventListener('cancel', () => resolve(null));
      input.click();
    });
  }

  async function pickDevice(inputName, t, scene, id) {
    const props = [].concat(t.prop);
    let prop = props[0];
    let items = [];
    for (const p of props) { items = await listItems(inputName, p); if (items.length) { prop = p; break; } }
    if (!items.length) {
      return notice('Nothing found', `No ${t.label.toLowerCase()} devices were found. Plug it in and add it again.`);
    }
    const sel = el('select', null, items.map((i) => el('option', { value: String(i.value), text: i.name })));
    openModal(`Choose: ${t.label}`, el('label', { class: 'field' }, 'Device', sel), [
      { label: 'Remove', run: () => call('RemoveInput', { inputName }).catch(() => {}) },
      {
        label: 'Use this', kind: 'primary',
        run: async () => {
          const chosen = items.find((i) => String(i.value) === sel.value);
          await call('SetInputSettings', { inputName, inputSettings: { [prop]: chosen ? chosen.value : sel.value } }).catch(() => {});
          if (t.fit) setTimeout(() => fitItem(scene, id).catch(() => {}), 800);
        }
      }
    ]);
  }

  // ---------- audio desk ----------
  function dbFromMul(m) { return m > 0 ? 20 * Math.log10(m) : -100; }
  function pctFromDb(db) { return Math.max(0, Math.min(100, ((db + 60) / 60) * 100)); }

  async function buildChannel(name) {
    const fill = el('i');
    const fader = el('input', { class: 'fader', type: 'range', min: '-60', max: '0', step: '1', value: '0', 'aria-label': name + ' volume' });
    const mute = el('button', { class: 'mute', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Mute ' + name, text: 'M' });
    const node = el('div', { class: 'ch' },
      el('div', { class: 'ch-strip' }, el('div', { class: 'meter' }, fill), fader),
      el('span', { class: 'ch-name', text: name, title: name }), mute);
    const ch = { node, fill, fader, mute };
    mute.addEventListener('click', () => call('ToggleInputMute', { inputName: name }).catch(() => {}));
    fader.addEventListener('input', () => call('SetInputVolume', { inputName: name, inputVolumeDb: Number(fader.value) }).catch(() => {}));
    try {
      const m = await call('GetInputMute', { inputName: name });
      mute.setAttribute('aria-pressed', String(m.inputMuted));
      const v = await call('GetInputVolume', { inputName: name });
      fader.value = String(Math.max(-60, Math.round(v.inputVolumeDb)));
    } catch { /* ignore */ }
    return ch;
  }

  obs.on('InputVolumeMeters', (data) => {
    state.meterQueue = data.inputs;
  });

  let rebuildingDesk = false;
  function drawMeters() {
    const inputs = state.meterQueue;
    state.meterQueue = null;
    if (inputs) {
      const names = inputs.map((i) => i.inputName);
      const known = [...state.channels.keys()];
      const changed = names.length !== known.length || names.some((n, i) => n !== known[i]);
      if (changed && !rebuildingDesk) {
        rebuildingDesk = true;
        const desk = $('audioDesk');
        Promise.all(names.map((n) => state.channels.get(n) || buildChannel(n))).then((chs) => {
          state.channels = new Map(names.map((n, i) => [n, chs[i]]));
          desk.replaceChildren(...chs.map((c) => c.node));
          if (!chs.length) desk.replaceChildren(el('p', { class: 'muted small-t', text: 'No audio sources.' }));
        }).finally(() => { rebuildingDesk = false; });
      }
      for (const inp of inputs) {
        const ch = state.channels.get(inp.inputName);
        if (!ch) continue;
        let peak = 0;
        for (const lv of inp.inputLevelsMul || []) peak = Math.max(peak, lv[1] || 0);
        const db = dbFromMul(peak);
        ch.fill.style.height = pctFromDb(db) + '%';
        ch.fill.className = db > -3 ? 'clip' : db > -12 ? 'hot' : '';
      }
    }
    requestAnimationFrame(drawMeters);
  }
  requestAnimationFrame(drawMeters);

  // ---------- output / go live ----------
  function renderDest() {
    const d = state.dest || {};
    const p = PLATFORMS[d.platform] || PLATFORMS.custom;
    const has = !!(state.settings && state.settings.hasKey && d.server);
    $('destName').textContent = has ? p.name : 'Not set up';
    $('destDetail').textContent = has ? `${state.info.qualityLabel} · ${state.info.encoderLabel}` : 'Add your stream key to go live';
    $('destLed').className = 'led' + (has ? (state.live ? ' live' : ' ready') : '');
    $('destStatus').textContent = has ? (state.live ? 'LIVE' : 'READY') : 'OFF';
  }

  $('destEdit').addEventListener('click', openDestination);

  async function openDestination() {
    const d = await window.tonix.getDestination();
    const plat = el('select', null, Object.entries(PLATFORMS).map(([k, v]) => el('option', { value: k, text: v.name })));
    plat.value = PLATFORMS[d.platform] ? d.platform : 'custom';
    const server = el('input', { type: 'text', value: d.server || '', placeholder: 'rtmp://…' });
    const key = el('input', { type: 'password', value: '', placeholder: d.key ? 'Saved (leave blank to keep)' : 'Paste your stream key', autocomplete: 'off' });
    const show = el('button', { class: 'btn small', type: 'button', text: 'Show' });
    show.addEventListener('click', () => { key.type = key.type === 'password' ? 'text' : 'password'; show.textContent = key.type === 'password' ? 'Show' : 'Hide'; });
    const help = el('small');
    const sync = () => {
      const p = PLATFORMS[plat.value];
      help.textContent = 'Where to find it: ' + p.help;
      if (p.server) { server.value = p.server; server.readOnly = true; } else { server.readOnly = false; }
    };
    plat.addEventListener('change', () => { if (!PLATFORMS[plat.value].server) server.value = ''; sync(); });
    sync();
    openModal('Stream destination', [
      el('label', { class: 'field' }, 'Platform', plat),
      el('label', { class: 'field' }, 'Server URL', server),
      el('label', { class: 'field' }, 'Stream key', el('div', { class: 'key-row' }, key, show), help),
      el('p', { class: 'small-t', text: 'Your key is stored encrypted on this PC and only sent to the platform you pick.' })
    ], [
      { label: 'Cancel' },
      {
        label: 'Save', kind: 'primary',
        run: async () => {
          if (!server.value.trim()) { server.focus(); return true; }
          state.settings = await window.tonix.saveDestination({ platform: plat.value, server: server.value.trim(), key: key.value.trim() });
          state.dest = await window.tonix.getDestination();
          renderDest();
        }
      }
    ]);
  }

  function setLive(live) {
    state.live = !!live;
    window.tonix.setLive(state.live);
    const btn = $('liveBtn');
    btn.textContent = state.live ? 'End stream' : 'Go live';
    btn.className = 'btn ' + (state.live ? 'end' : 'go');
    const pill = $('airPill');
    if (state.live) {
      pill.className = 'air on';
      pill.replaceChildren('ON AIR', el('span', { class: 'mono', id: 'airTime', text: '00:00:00' }));
    } else {
      pill.className = 'air off';
      pill.textContent = 'OFF AIR';
      $('statRate').textContent = '–';
    }
    renderDest();
  }

  $('liveBtn').addEventListener('click', async () => {
    if (state.live) {
      if (await confirmBox('End stream', 'End the live stream now?', 'End stream')) call('StopStream').catch(() => {});
      return;
    }
    const d = await window.tonix.getDestination();
    if (!d.key || !d.server) return openDestination();
    try {
      await call('SetStreamServiceSettings', { streamServiceType: 'rtmp_custom', streamServiceSettings: { server: d.server, key: d.key, use_auth: false } });
      state.startAttemptAt = Date.now();
      await call('StartStream');
    } catch (e) { encoderTrouble(e.message || String(e)); }
  });

  obs.on('StreamStateChanged', (e) => {
    if (e.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') { state.liveStartedAt = Date.now(); state.lastBytes = 0; setLive(true); }
    if (e.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
      const quick = state.startAttemptAt && Date.now() - state.startAttemptAt < 8000;
      setLive(false);
      if (quick) encoderTrouble('The stream stopped right after starting.');
      state.startAttemptAt = 0;
    }
  });

  function encoderTrouble(detail) {
    const usingCpu = state.info.encoder === 'x264';
    if (usingCpu) {
      return notice('Could not go live', detail + ' Check the stream key and server in Edit, and that your internet is connected.');
    }
    openModal('Could not go live', [
      el('p', { text: detail }),
      el('p', { text: `This is usually a wrong stream key, or the ${state.info.encoderLabel} encoder not working on this PC. Check your key first. If it is correct, switch to CPU encoding.` })
    ], [
      { label: 'Check stream key', run: () => { setTimeout(openDestination, 0); } },
      { label: 'Use CPU encoding', kind: 'primary', run: () => applySettings({ encoder: 'x264' }) }
    ]);
  }

  obs.on('CurrentProgramSceneChanged', (e) => { state.pgm = e.sceneName; renderScenes(); });
  obs.on('CurrentPreviewSceneChanged', (e) => { state.pvw = e.sceneName; renderScenes(); refreshShot(); });
  ['SceneCreated', 'SceneRemoved', 'SceneNameChanged', 'SceneListChanged'].forEach((ev) => obs.on(ev, () => refreshScenes().catch(() => {})));
  ['SceneItemCreated', 'SceneItemRemoved', 'SceneItemEnableStateChanged', 'SceneItemListReindexed'].forEach((ev) => obs.on(ev, (e) => { if (e.sceneName === state.pvw) refreshShot(); }));
  obs.on('InputNameChanged', () => refreshShot());
  obs.on('InputMuteStateChanged', (e) => { const c = state.channels.get(e.inputName); if (c) c.mute.setAttribute('aria-pressed', String(e.inputMuted)); });
  obs.on('InputVolumeChanged', (e) => { const c = state.channels.get(e.inputName); if (c && document.activeElement !== c.fader) c.fader.value = String(Math.max(-60, Math.round(e.inputVolumeDb))); });
  obs.on('CurrentSceneTransitionChanged', (e) => { state.transition = e.transitionName; renderTransitions(); });
  obs.on('StudioModeStateChanged', (e) => { if (!e.studioModeEnabled) call('SetStudioModeEnabled', { studioModeEnabled: true }).catch(() => {}); });

  // ---------- settings ----------
  $('settingsBtn').addEventListener('click', openSettings);

  async function openSettings() {
    const s = await window.tonix.getSettings();
    const info = state.info;
    const quality = el('select', null, Object.entries(info.qualities).map(([k, v]) => el('option', { value: k, text: v })));
    quality.value = s.quality;
    const encoder = el('select', null,
      el('option', { value: 'auto', text: `Automatic (${info.encoders[info.detectedEncoder]})` }),
      Object.entries(info.encoders).map(([k, v]) => el('option', { value: k, text: v })));
    encoder.value = s.encoder;
    const bitrate = el('input', { type: 'number', min: '0', max: '20000', step: '250', value: String(s.bitrate || 0) });
    openModal('Studio settings', [
      el('label', { class: 'field' }, 'Stream quality', quality, el('small', { text: 'Pick Performance on slower PCs or graphics cards for the smoothest game.' })),
      el('label', { class: 'field' }, 'Encoder', encoder, el('small', { text: `Detected: ${info.detectedGpu}. Hardware encoders keep the CPU free for your game.` })),
      el('label', { class: 'field' }, 'Video bitrate (kbps)', bitrate, el('small', { text: '0 uses the recommended bitrate for the quality you picked.' })),
      state.live ? el('p', { text: 'You are live. These changes apply after you end the stream.' }) : null
    ], [
      { label: 'Cancel' },
      { label: 'Save', kind: 'primary', run: () => applySettings({ quality: quality.value, encoder: encoder.value, bitrate: Number(bitrate.value) || 0 }) }
    ]);
  }

  async function applySettings(patch) {
    state.settings = await window.tonix.saveSettings(patch);
    if (state.live) return;
    overlay('Applying settings…');
    state.connected = false;
    try { await obs.disconnect(); } catch { /* ignore */ }
    state.info = await window.tonix.restartEngine();
    connectLoop();
  }

  // ---------- performance mode ----------
  function setPerf(on, save) {
    state.perf = on;
    $('perfBtn').setAttribute('aria-pressed', String(on));
    if (save) window.tonix.saveSettings({ perf: on }).then((s) => { state.settings = s; });
    if (on) document.querySelectorAll('.tile-img img').forEach((i) => i.removeAttribute('src'));
  }
  $('perfBtn').addEventListener('click', () => setPerf(!state.perf, true));

  // ---------- loops: preview pictures + stats ----------
  let loopsStarted = false;
  function startLoops() {
    if (loopsStarted) return;
    loopsStarted = true;
    previewLoop();
    statsLoop();
  }

  async function shot(sceneName, width) {
    const r = await call('GetSourceScreenshot', { sourceName: sceneName, imageFormat: 'jpg', imageWidth: width, imageCompressionQuality: 60 });
    return r.imageData;
  }

  async function previewLoop() {
    if (state.connected && !document.hidden) {
      try {
        const big = state.perf ? 480 : 960;
        if (state.pgm) $('pgmImg').src = await shot(state.pgm, big);
        if (state.pvw && (!state.perf || state.tick % 2 === 0)) $('pvwImg').src = await shot(state.pvw, big);
        if (!state.perf && state.scenes.length && state.tick % 2 === 0) {
          const name = state.scenes[(state.tick / 2) % state.scenes.length | 0];
          const tile = document.querySelector(`.tile[data-scene="${CSS.escape(name)}"] img`);
          if (tile) tile.src = await shot(name, 320);
        }
      } catch { /* scene may be mid-change */ }
      state.tick++;
    }
    setTimeout(previewLoop, state.perf ? 500 : 125);
  }

  function setChip(id, level) {
    const c = $(id);
    c.classList.toggle('warn', level === 1);
    c.classList.toggle('bad', level === 2);
  }

  async function statsLoop() {
    if (state.connected) {
      try {
        const s = await call('GetStats');
        $('statCpu').textContent = Math.round(s.cpuUsage) + '%';
        $('statFps').textContent = Math.round(s.activeFps);
        if (state.lagBase == null) state.lagBase = s.renderSkippedFrames;
        const lag = s.renderSkippedFrames - state.lagBase;
        $('statLag').textContent = lag;
        const newLag = lag - state.lastLag;
        state.lastLag = lag;
        setChip('chipLag', newLag > 10 ? 2 : newLag > 0 ? 1 : 0);
        let health = '';
        if (newLag > 10) health = 'Your PC is struggling to keep up. Turn on Performance mode or pick Performance quality in Settings.';
        if (state.live) {
          const st = await call('GetStreamStatus');
          if ($('airTime')) $('airTime').textContent = (st.outputTimecode || '00:00:00').slice(0, 8);
          $('statDrop').textContent = st.outputSkippedFrames;
          const now = Date.now();
          if (state.lastBytes && now > state.lastBytesAt) {
            const kbps = ((st.outputBytes - state.lastBytes) * 8) / (now - state.lastBytesAt);
            $('statRate').textContent = Math.max(0, Math.round(kbps));
          }
          state.lastBytes = st.outputBytes;
          state.lastBytesAt = now;
          const cong = st.outputCongestion || 0;
          setChip('chipDrop', st.outputSkippedFrames > 0 ? 1 : 0);
          setChip('chipRate', cong > 0.5 ? 2 : cong > 0.15 ? 1 : 0);
          if (cong > 0.5) health = 'Your internet upload is struggling. Lower the bitrate in Settings.';
        } else {
          $('statDrop').textContent = s.outputSkippedFrames;
        }
        const bar = $('healthBar');
        bar.textContent = health;
        bar.classList.toggle('hidden', !health);
      } catch { /* ignore */ }
    }
    setTimeout(statsLoop, 2000);
  }

  // ---------- go ----------
  overlay('Starting the engine…');
  connectLoop();
})();
