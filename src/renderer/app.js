/* Tonix-Lab-LIVE — a lightweight OBS-style studio. Talks to the hidden OBS engine over obs-websocket v5. */
(function () {
  'use strict';

  const obs = new OBSWebSocket();
  const ES = OBSWebSocket.EventSubscription;
  const $ = (id) => document.getElementById(id);

  const PLATFORMS = {
    tiktok: { name: 'TikTok', server: '', help: 'TikTok LIVE Center gives you a server URL and stream key (only some accounts have this).' },
    youtube: { name: 'YouTube - RTMP', server: 'rtmp://a.rtmp.youtube.com/live2', help: 'YouTube Studio › Go live › Stream › Stream key. Vertical streams show as Shorts live.' },
    facebook: { name: 'Facebook Live', server: 'rtmps://live-api-s.facebook.com:443/rtmp/', help: 'Facebook Live Producer › Streaming software › Stream key' },
    instagram: { name: 'Instagram', server: '', help: 'Instagram Live Producer (on instagram.com, on a computer) gives a server URL and stream key.' },
    twitch: { name: 'Twitch', server: 'rtmp://live.twitch.tv/app', help: 'Twitch Creator Dashboard › Settings › Stream › Primary stream key' },
    custom: { name: 'Custom...', server: '', help: 'Paste the RTMP server URL and stream key for your own server or any other platform.' }
  };

  const KIND_LABEL = {
    browser_source: 'Browser',
    image_source: 'Image',
    ffmpeg_source: 'Media',
    game_capture: 'Game Capture',
    monitor_capture: 'Display Capture',
    window_capture: 'Window Capture',
    dshow_input: 'Video Capture Device',
    wasapi_input_capture: 'Audio Input',
    wasapi_output_capture: 'Audio Output',
    wasapi_process_output_capture: 'App Audio'
  };
  function kindLabel(k) {
    if (!k) return 'Source';
    if (KIND_LABEL[k]) return KIND_LABEL[k];
    if (k.startsWith('text_')) return 'Text';
    if (k.startsWith('color_source')) return 'Color';
    if (k.startsWith('slideshow')) return 'Image Slide Show';
    if (k === 'scene') return 'Scene';
    return k;
  }

  const state = {
    connected: false,
    info: null,
    settings: null,
    scenes: [],
    pgm: null,
    pvw: null,
    studio: false,
    transitions: [],
    transition: null,
    live: false,
    rec: false,
    startAttemptAt: 0,
    lastBytes: 0,
    lastBytesAt: 0,
    lagBase: null,
    lastLag: 0,
    kinds: [],
    base: { w: 1920, h: 1080 },
    items: [],
    itemsScene: null,
    selected: null,
    hover: null,
    drag: null,
    channels: new Map(),
    meterQueue: null,
    perf: false,
    tick: 0
  };
  const editScene = () => (state.studio ? state.pvw : state.pgm);

  // ---------- helpers ----------
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'value') n.value = v;
        else if (k === 'checked') n.checked = !!v;
        else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
    return n;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = (req, data) => obs.call(req, data);
  const errText = (e) => (e && e.message) || String(e);

  function hexToObs(hex) {
    const v = parseInt(hex.replace('#', ''), 16);
    const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    return (0xFF000000 + (b << 16) + (g << 8) + r) >>> 0;
  }
  function obsToHex(n) {
    n = Number(n) >>> 0;
    const r = n & 255, g = (n >> 8) & 255, b = (n >> 16) & 255;
    return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  // ---------- modal ----------
  function openModal(title, body, actions) {
    hideCtx();
    $('modalBox').classList.remove('wide');
    $('modalTitle').textContent = title;
    $('modalBody').replaceChildren(...[].concat(body || []).filter(Boolean));
    $('modalActions').replaceChildren(...actions.map((x) => el('button', {
      class: 'btn ' + (x.kind || ''), type: 'button', text: x.label,
      onClick: async () => {
        if (x.run) { const keep = await x.run(); if (keep === true) return; }
        closeModal();
      }
    })));
    $('modal').classList.remove('hidden');
    const first = $('modalBody').querySelector('input,select,textarea,button') || $('modalActions').querySelector('button');
    if (first) first.focus();
  }
  function closeModal() { $('modal').classList.add('hidden'); }
  const modalOpen = () => !$('modal').classList.contains('hidden');
  function notice(title, text) { openModal(title, el('p', { text }), [{ label: 'OK', kind: 'primary' }]); }
  function askText(title, label, value) {
    return new Promise((resolve) => {
      const input = el('input', { type: 'text', value: value || '' });
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      openModal(title, el('label', { class: 'field' }, label, input), [
        { label: 'Cancel', run: () => finish(null) },
        { label: 'OK', kind: 'primary', run: () => finish(input.value.trim() || null) }
      ]);
      input.select();
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { finish(input.value.trim() || null); closeModal(); } });
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
  function pickFiles(accept) {
    return new Promise((resolve) => {
      const input = el('input', { type: 'file', accept: accept || '', multiple: true });
      input.addEventListener('change', () => resolve([...input.files].map((f) => window.tonix.filePath(f))));
      input.addEventListener('cancel', () => resolve([]));
      input.click();
    });
  }
  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = el('input', { type: 'file', accept: accept || '' });
      input.addEventListener('change', () => resolve(input.files[0] ? window.tonix.filePath(input.files[0]) : null));
      input.addEventListener('cancel', () => resolve(null));
      input.click();
    });
  }

  // ---------- context menu ----------
  function showCtx(x, y, entries) {
    const m = $('ctxMenu');
    m.replaceChildren(...entries.map((e) => e === '-' ? el('hr') : el('button', {
      type: 'button', role: 'menuitem', text: e.label,
      onClick: () => { hideCtx(); e.run(); }
    })));
    m.classList.remove('hidden');
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
    m.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';
  }
  function hideCtx() { $('ctxMenu').classList.add('hidden'); }
  document.addEventListener('mousedown', (e) => { if (!$('ctxMenu').contains(e.target)) hideCtx(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideCtx(); if (modalOpen()) closeModal(); }
  });

  // ---------- connection ----------
  function overlay(msg, retry) {
    $('overlay').classList.remove('hidden');
    $('overlayMsg').textContent = msg;
    $('overlayRetry').classList.toggle('hidden', !retry);
  }
  const hideOverlay = () => $('overlay').classList.add('hidden');

  let connecting = false;
  async function connectLoop() {
    if (connecting) return;
    connecting = true;
    state.info = await window.tonix.engineInfo();
    for (let i = 0; i < 90 && !state.connected; i++) {
      if (state.info.status === 'error') break;
      try {
        await obs.connect(`ws://127.0.0.1:${state.info.port}`, state.info.password, {
          eventSubscriptions: ES.All | ES.InputVolumeMeters | ES.SceneItemTransformChanged
        });
        state.connected = true;
      } catch {
        await sleep(1000);
        state.info = await window.tonix.engineInfo();
      }
    }
    connecting = false;
    if (state.connected) {
      try { await init(); hideOverlay(); } catch (e) { overlay('Could not set up the studio: ' + errText(e), true); }
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
    state.lagBase = null;
    state.lastLag = 0;
    const v = await call('GetVideoSettings');
    state.base = { w: v.baseWidth, h: v.baseHeight };
    fitAll();
    state.kinds = (await call('GetInputKindList', { unversioned: false })).inputKinds;

    const list = await call('GetSceneList');
    const names = list.scenes.map((s) => s.sceneName);
    if (names.length === 0 || (names.length === 1 && names[0] === 'Scene')) {
      let empty = true;
      if (names.length) { try { empty = !(await call('GetSceneItemList', { sceneName: 'Scene' })).sceneItems.length; } catch { empty = true; } }
      if (empty) await seedScenes(names);
    }

    state.studio = (await call('GetStudioModeEnabled')).studioModeEnabled;
    setPerf(!!state.settings.general.perf, false);
    $('statEnc').textContent = state.info.encoderLabel;
    applyLook();
    renderTemplates();
    applyStudioLayout();
    await refreshScenes();
    await refreshTransitions();
    const st = await call('GetStreamStatus');
    setLive(st.outputActive);
    try { setRec((await call('GetRecordStatus')).outputActive); } catch { setRec(false); }
    renderDest();
    startLoops();
  }

  async function uniqueName(base) {
    const { inputs } = await call('GetInputList');
    const taken = new Set(inputs.map((i) => i.inputName).concat(state.scenes));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) { const c = `${base} ${n}`; if (!taken.has(c)) return c; }
  }

  async function addInput(sceneName, inputName, inputKind, inputSettings) {
    const r = await call('CreateInput', { sceneName, inputName, inputKind, inputSettings: inputSettings || {}, sceneItemEnabled: true });
    return r.sceneItemId;
  }

  // mode: 'inner' = fit inside, 'outer' = fill and crop (best for game/camera on a phone canvas), 'stretch'
  async function fitItem(sceneName, sceneItemId, mode) {
    const types = { inner: 'OBS_BOUNDS_SCALE_INNER', outer: 'OBS_BOUNDS_SCALE_OUTER', stretch: 'OBS_BOUNDS_STRETCH' };
    await call('SetSceneItemTransform', {
      sceneName, sceneItemId,
      sceneItemTransform: {
        positionX: 0, positionY: 0, alignment: 5, rotation: 0,
        boundsType: types[mode] || types.inner, boundsAlignment: 0,
        boundsWidth: state.base.w, boundsHeight: state.base.h
      }
    });
    if (mode === 'outer') {
      try { await call('SetSceneItemTransform', { sceneName, sceneItemId, sceneItemTransform: { cropToBounds: true } }); } catch { /* older engine */ }
    }
  }

  async function centerItem(sceneName, sceneItemId, posY) {
    await call('SetSceneItemTransform', {
      sceneName, sceneItemId,
      sceneItemTransform: { positionX: state.base.w / 2, positionY: posY == null ? state.base.h / 2 : posY, alignment: 0 }
    });
  }

  async function listItems(inputName, prop) {
    try {
      const r = await call('GetInputPropertiesListPropertyItems', { inputName, propertyName: prop });
      return r.propertyItems.filter((i) => i.itemEnabled !== false && i.itemValue !== '' && i.itemValue != null)
        .map((i) => ({ name: i.itemName, value: i.itemValue }));
    } catch { return []; }
  }

  async function seedScenes(existing) {
    overlay('Setting up your starter scenes…');
    const step = async (fn) => { try { await fn(); } catch (e) { console.warn(e); } };
    const colorKind = pickKind('color_source');
    const textKind = pickKind('text_gdiplus');
    const titleScene = async (scene, bg, title, text) => {
      await call('CreateScene', { sceneName: scene });
      if (colorKind) await addInput(scene, bg, colorKind, { color: 0xFF1E1A17, width: state.base.w, height: state.base.h });
      if (textKind) {
        const id = await addInput(scene, title, textKind, { text, font: { face: 'Arial', size: 120, style: 'Bold', flags: 1 } });
        await centerItem(scene, id);
      }
    };
    await step(() => titleScene('Starting Soon', 'Starting Soon Background', 'Starting Soon Title', 'STARTING SOON'));
    await step(async () => {
      await call('CreateScene', { sceneName: 'Gameplay' });
      await fitItem('Gameplay', await addInput('Gameplay', 'Game Capture', 'game_capture', { capture_mode: 'any_fullscreen' }), 'outer');
    });
    await step(async () => {
      await call('CreateScene', { sceneName: 'Camera' });
      const id = await addInput('Camera', 'Video Capture Device', 'dshow_input', {});
      const devices = await listItems('Video Capture Device', 'video_device_id');
      if (devices.length) await call('SetInputSettings', { inputName: 'Video Capture Device', inputSettings: { video_device_id: devices[0].value } });
      await fitItem('Camera', id, 'outer');
    });
    await step(() => titleScene('Be Right Back', 'BRB Background', 'BRB Title', 'BE RIGHT BACK'));
    await step(() => call('SetCurrentProgramScene', { sceneName: 'Starting Soon' }));
    for (const n of existing) await step(() => call('RemoveScene', { sceneName: n }));
    overlay('Starting the engine…');
  }

  // ---------- scenes dock ----------
  async function refreshScenes() {
    const r = await call('GetSceneList');
    state.scenes = r.scenes.slice().sort((a, b) => b.sceneIndex - a.sceneIndex).map((s) => s.sceneName);
    state.pgm = r.currentProgramSceneName;
    state.pvw = r.currentPreviewSceneName || null;
    renderScenes();
    await refreshItems();
  }

  function renderScenes() {
    const cur = editScene();
    $('sceneList').replaceChildren(...state.scenes.map((name) => el('li', {
      class: name === cur ? 'on' : '', tabindex: '0', role: 'option', 'aria-selected': String(name === cur),
      onClick: () => selectScene(name),
      onDblclick: () => renameScene(name),
      onKeydown: (e) => { if (e.key === 'Enter') selectScene(name); }
    },
    state.studio && name === state.pgm ? el('span', { class: 'live-dot', title: 'On program' }) : null,
    state.studio && name === state.pvw && name !== state.pgm ? el('span', { class: 'pv-dot', title: 'In preview' }) : null,
    el('span', { class: 'name', text: name }))));
  }

  async function selectScene(name) {
    try {
      if (state.studio) await call('SetCurrentPreviewScene', { sceneName: name });
      else await call('SetCurrentProgramScene', { sceneName: name });
    } catch (e) { console.warn(e); }
  }

  async function renameScene(old) {
    const name = await askText('Rename scene', 'Scene name', old);
    if (!name || name === old) return;
    try { await call('SetSceneName', { sceneName: old, newSceneName: name }); } catch (e) { notice('Could not rename', errText(e)); }
  }

  $('sceneAdd').addEventListener('click', async () => {
    const name = await askText('Add scene', 'Please enter the name of the scene', await uniqueName('Scene'));
    if (!name) return;
    try { await call('CreateScene', { sceneName: name }); await selectScene(name); } catch (e) { notice('Could not add scene', errText(e)); }
  });
  $('sceneRemove').addEventListener('click', async () => {
    const name = editScene();
    if (!name) return;
    if (state.scenes.length <= 1) return notice('Keep one scene', 'You need at least one scene.');
    if (!(await confirmBox('Remove scene', `Are you sure you want to remove "${name}"?`, 'Remove'))) return;
    try { await call('RemoveScene', { sceneName: name }); } catch (e) { notice('Could not remove', errText(e)); }
  });
  $('sceneRename').addEventListener('click', () => { if (editScene()) renameScene(editScene()); });

  // ---------- sources dock ----------
  async function refreshItems() {
    const scene = editScene();
    if (!scene) { state.items = []; renderSources(); renderBoxes(); return; }
    let raw = [];
    try { raw = (await call('GetSceneItemList', { sceneName: scene })).sceneItems; } catch { raw = []; }
    if (state.drag) return; // don't fight an active drag
    const items = [];
    for (const it of raw) {
      let t = it.sceneItemTransform;
      if (!t) { try { t = (await call('GetSceneItemTransform', { sceneName: scene, sceneItemId: it.sceneItemId })).sceneItemTransform; } catch { t = null; } }
      items.push({
        id: it.sceneItemId, name: it.sourceName, kind: it.inputKind || (it.isGroup ? 'group' : 'scene'),
        enabled: it.sceneItemEnabled, locked: !!it.sceneItemLocked, index: it.sceneItemIndex, t: t || {}
      });
    }
    items.sort((a, b) => b.index - a.index); // top layer first, like OBS
    const sig = scene + '|' + items.map((i) => [i.id, i.name, i.enabled, i.locked, i.index].join(':')).join(',');
    state.items = items;
    state.itemsScene = scene;
    if (state.selected != null && !items.some((i) => i.id === state.selected)) state.selected = null;
    if (sig !== state.itemsSig) { state.itemsSig = sig; renderSources(); }
    renderBoxes();
  }

  const selItem = () => state.items.find((i) => i.id === state.selected) || null;

  function renderSources() {
    const list = $('sourceList');
    if (!state.items.length) {
      list.replaceChildren(el('li', { class: 'empty-li', text: 'No sources. Click + or right-click the canvas to add one.' }));
      return;
    }
    list.replaceChildren(...state.items.map((it) => el('li', {
      class: (it.id === state.selected ? 'on' : '') + (it.enabled ? '' : ' dim'),
      tabindex: '0', role: 'option', 'aria-selected': String(it.id === state.selected), title: kindLabel(it.kind),
      onClick: () => { state.selected = it.id; renderSources(); renderBoxes(); },
      onDblclick: () => openProps(it),
      onContextmenu: (e) => { e.preventDefault(); state.selected = it.id; renderSources(); renderBoxes(); itemMenu(e.clientX, e.clientY, it); }
    },
    el('span', { class: 'name', text: it.name }),
    el('button', {
      class: 'ico' + (it.enabled ? '' : ' off'), type: 'button', title: it.enabled ? 'Hide' : 'Show',
      'aria-label': (it.enabled ? 'Hide ' : 'Show ') + it.name, text: '👁',
      onClick: (e) => { e.stopPropagation(); setEnabled(it, !it.enabled); }
    }),
    el('button', {
      class: 'ico' + (it.locked ? '' : ' off'), type: 'button', title: it.locked ? 'Unlock' : 'Lock',
      'aria-label': (it.locked ? 'Unlock ' : 'Lock ') + it.name, text: it.locked ? '🔒' : '🔓',
      onClick: (e) => { e.stopPropagation(); setLocked(it, !it.locked); }
    }))));
  }

  const setEnabled = (it, on) => call('SetSceneItemEnabled', { sceneName: state.itemsScene, sceneItemId: it.id, sceneItemEnabled: on }).catch(() => {});
  const setLocked = (it, on) => call('SetSceneItemLocked', { sceneName: state.itemsScene, sceneItemId: it.id, sceneItemLocked: on }).then(refreshItems).catch(() => {});

  async function moveOrder(it, where) {
    const top = state.items.length - 1;
    const idx = { top, bottom: 0, up: Math.min(top, it.index + 1), down: Math.max(0, it.index - 1) }[where];
    try { await call('SetSceneItemIndex', { sceneName: state.itemsScene, sceneItemId: it.id, sceneItemIndex: idx }); } catch (e) { console.warn(e); }
  }

  async function removeItem(it) {
    if (!(await confirmBox('Remove source', `Are you sure you want to remove "${it.name}"?`, 'Remove'))) return;
    try { await call('RemoveSceneItem', { sceneName: state.itemsScene, sceneItemId: it.id }); } catch (e) { notice('Could not remove', errText(e)); }
  }

  async function renameItem(it) {
    const name = await askText('Rename source', 'Name', it.name);
    if (!name || name === it.name) return;
    try { await call('SetInputName', { inputName: it.name, newInputName: name }); } catch (e) { notice('Could not rename', errText(e)); }
  }

  $('srcAdd').addEventListener('click', () => openAddSource());
  $('srcRemove').addEventListener('click', () => { const it = selItem(); if (it) removeItem(it); });
  $('srcProps').addEventListener('click', () => { const it = selItem(); if (it) openProps(it); });
  $('srcUp').addEventListener('click', () => { const it = selItem(); if (it) moveOrder(it, 'up'); });
  $('srcDown').addEventListener('click', () => { const it = selItem(); if (it) moveOrder(it, 'down'); });

  function itemMenu(x, y, it) {
    const s = state.itemsScene;
    showCtx(x, y, [
      { label: 'Properties', run: () => openProps(it) },
      { label: 'Rename', run: () => renameItem(it) },
      '-',
      { label: 'Fit to screen', run: () => fitItem(s, it.id, 'inner').catch(() => {}) },
      { label: 'Fill screen (crop)', run: () => fitItem(s, it.id, 'outer').catch(() => {}) },
      { label: 'Stretch to screen', run: () => fitItem(s, it.id, 'stretch').catch(() => {}) },
      { label: 'Center to screen', run: () => centerBox(it) },
      { label: 'Reset transform', run: () => resetItem(it) },
      '-',
      { label: 'Move to top', run: () => moveOrder(it, 'top') },
      { label: 'Move up', run: () => moveOrder(it, 'up') },
      { label: 'Move down', run: () => moveOrder(it, 'down') },
      { label: 'Move to bottom', run: () => moveOrder(it, 'bottom') },
      '-',
      { label: it.enabled ? 'Hide' : 'Show', run: () => setEnabled(it, !it.enabled) },
      { label: it.locked ? 'Unlock' : 'Lock', run: () => setLocked(it, !it.locked) },
      { label: 'Remove', run: () => removeItem(it) }
    ]);
  }

  function resetItem(it) {
    call('SetSceneItemTransform', {
      sceneName: state.itemsScene, sceneItemId: it.id,
      sceneItemTransform: {
        positionX: 0, positionY: 0, alignment: 5, rotation: 0, scaleX: 1, scaleY: 1,
        boundsType: 'OBS_BOUNDS_NONE', cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0
      }
    }).catch(() => {});
  }

  function centerBox(it) {
    const b = boxOf(it.t);
    sendTransform(state.itemsScene, it.id, { alignment: 5, positionX: (state.base.w - b.w) / 2, positionY: (state.base.h - b.h) / 2 });
  }

  // ---------- canvas editing ----------
  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const bounded = (t) => t.boundsType && t.boundsType !== 'OBS_BOUNDS_NONE';

  function boxOf(t) {
    const w = bounded(t) ? t.boundsWidth : t.width;
    const h = bounded(t) ? t.boundsHeight : t.height;
    const a = t.alignment == null ? 5 : t.alignment;
    const x = t.positionX - ((a & 1) ? 0 : (a & 2) ? w : w / 2);
    const y = t.positionY - ((a & 4) ? 0 : (a & 8) ? h : h / 2);
    return { x, y, w: w || 0, h: h || 0 };
  }

  function canvasScale() {
    const r = $('editCanvas').getBoundingClientRect();
    return { r, s: r.width / state.base.w };
  }
  function toCanvas(e) {
    const { r, s } = canvasScale();
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
  }
  function hitTest(p) {
    for (const it of state.items) {
      if (!it.enabled) continue;
      const b = boxOf(it.t);
      if (b.w <= 0 || b.h <= 0) continue;
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return it;
    }
    return null;
  }

  function placeBox(node, b, s) {
    node.style.left = b.x * s + 'px';
    node.style.top = b.y * s + 'px';
    node.style.width = Math.max(1, b.w * s) + 'px';
    node.style.height = Math.max(1, b.h * s) + 'px';
  }

  function renderBoxes(guides) {
    const layer = $('selLayer');
    const { s } = canvasScale();
    const kids = [];
    const hov = state.items.find((i) => i.id === state.hover);
    if (hov && hov.id !== state.selected && hov.enabled) {
      const n = el('div', { class: 'box hover' });
      placeBox(n, boxOf(hov.t), s);
      kids.push(n);
    }
    const sel = selItem();
    if (sel) {
      const n = el('div', { class: 'box sel' + (sel.locked ? ' locked' : '') });
      placeBox(n, boxOf(sel.t), s);
      if (!sel.locked) for (const h of HANDLES) n.append(el('span', { class: 'handle h-' + h, 'data-h': h }));
      kids.push(n);
    }
    for (const g of guides || []) {
      const n = el('div', { class: 'guide' });
      if (g.v != null) { n.style.left = g.v * s + 'px'; n.style.top = '0'; n.style.width = '1px'; n.style.height = '100%'; }
      else { n.style.top = g.h * s + 'px'; n.style.left = '0'; n.style.height = '1px'; n.style.width = '100%'; }
      kids.push(n);
    }
    layer.replaceChildren(...kids);
    renderTransform();
  }
  // Keep each canvas at the 16:9 base shape, as large as its box allows.
  function fitCanvas(box, canvas) {
    const r = box.getBoundingClientRect();
    const ratio = state.base.w / state.base.h;
    let w = r.width - 2, h = w / ratio;
    if (h > r.height - 2) { h = r.height - 2; w = h * ratio; }
    canvas.style.width = Math.max(0, w) + 'px';
    canvas.style.height = Math.max(0, h) + 'px';
  }
  function fitAll() {
    fitCanvas($('editBox'), $('editCanvas'));
    fitCanvas($('pgmCanvas').parentElement, $('pgmCanvas'));
    renderBoxes();
  }
  new ResizeObserver(fitAll).observe($('editBox'));
  new ResizeObserver(fitAll).observe($('pgmCanvas').parentElement);

  // Send transform updates without flooding the engine: one request in flight, latest wins.
  let pendingTr = null;
  let trInFlight = false;
  function sendTransform(sceneName, id, tr) {
    if (pendingTr && pendingTr.id === id && pendingTr.sceneName === sceneName) Object.assign(pendingTr.tr, tr);
    else pendingTr = { sceneName, id, tr: Object.assign({}, tr) };
    flushTransform();
  }
  async function flushTransform() {
    if (trInFlight || !pendingTr) return;
    const p = pendingTr;
    pendingTr = null;
    trInFlight = true;
    try { await call('SetSceneItemTransform', { sceneName: p.sceneName, sceneItemId: p.id, sceneItemTransform: p.tr }); } catch { /* ignore */ }
    trInFlight = false;
    if (pendingTr) flushTransform();
  }

  function normalize(it) {
    // Switch to a top-left anchor so moving and resizing map 1:1 to the box.
    const b = boxOf(it.t);
    if (it.t.alignment !== 5) {
      it.t.alignment = 5;
      it.t.positionX = b.x;
      it.t.positionY = b.y;
      sendTransform(state.itemsScene, it.id, { alignment: 5, positionX: b.x, positionY: b.y });
    }
    return b;
  }

  function snap(b, s) {
    const tol = 8 / s;
    const W = state.base.w, H = state.base.h;
    const guides = [];
    const xs = [[b.x, 0], [b.x + b.w, W], [b.x + b.w / 2, W / 2]];
    for (const [edge, target] of xs) if (Math.abs(edge - target) < tol) { b.x += target - edge; guides.push({ v: target }); break; }
    const ys = [[b.y, 0], [b.y + b.h, H], [b.y + b.h / 2, H / 2]];
    for (const [edge, target] of ys) if (Math.abs(edge - target) < tol) { b.y += target - edge; guides.push({ h: target }); break; }
    return guides;
  }

  const layer = $('selLayer');
  layer.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    hideCtx();
    const p = toCanvas(e);
    const handle = e.target.dataset && e.target.dataset.h;
    let it = handle ? selItem() : hitTest(p);
    if (!handle && it == null) { state.selected = null; renderSources(); renderBoxes(); return; }
    state.selected = it.id;
    renderSources();
    if (it.locked) { renderBoxes(); return; }
    const b = normalize(it);
    state.drag = { it, handle, start: p, orig: Object.assign({}, b), t0: Object.assign({}, it.t), scene: state.itemsScene };
    renderBoxes();
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    const d = state.drag;
    if (!d) {
      if (e.target === layer || layer.contains(e.target)) {
        const it = hitTest(toCanvas(e));
        const id = it ? it.id : null;
        if (id !== state.hover) { state.hover = id; renderBoxes(); }
      }
      return;
    }
    const { s } = canvasScale();
    const p = toCanvas(e);
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    const t = d.it.t;
    let guides = [];
    if (!d.handle) {
      const b = { x: d.orig.x + dx, y: d.orig.y + dy, w: d.orig.w, h: d.orig.h };
      if (!e.altKey && state.settings.general.snapping) guides = snap(b, s);
      t.positionX = b.x; t.positionY = b.y;
      sendTransform(d.scene, d.it.id, { positionX: b.x, positionY: b.y });
    } else {
      const o = d.orig;
      let left = o.x, top = o.y, right = o.x + o.w, bottom = o.y + o.h;
      const hnd = d.handle;
      if (hnd.includes('w')) left = Math.min(p.x, right - 8);
      if (hnd.includes('e')) right = Math.max(p.x, left + 8);
      if (hnd.includes('n')) top = Math.min(p.y, bottom - 8);
      if (hnd.includes('s')) bottom = Math.max(p.y, top + 8);
      let w = right - left, h = bottom - top;
      if (hnd.length === 2 && !e.shiftKey && o.w > 0 && o.h > 0) {
        const ratio = o.w / o.h;
        if (w / o.w > h / o.h) h = w / ratio; else w = h * ratio;
        if (hnd.includes('w')) left = right - w; else right = left + w;
        if (hnd.includes('n')) top = bottom - h; else bottom = top + h;
      }
      const tr = { positionX: left, positionY: top };
      t.positionX = left; t.positionY = top;
      if (bounded(t)) {
        t.boundsWidth = w; t.boundsHeight = h;
        tr.boundsWidth = w; tr.boundsHeight = h;
      } else {
        const srcW = (d.t0.sourceWidth || 0) - (d.t0.cropLeft || 0) - (d.t0.cropRight || 0);
        const srcH = (d.t0.sourceHeight || 0) - (d.t0.cropTop || 0) - (d.t0.cropBottom || 0);
        if (srcW > 0 && srcH > 0) {
          t.scaleX = w / srcW; t.scaleY = h / srcH; t.width = w; t.height = h;
          tr.scaleX = t.scaleX; tr.scaleY = t.scaleY;
        } else {
          t.boundsType = 'OBS_BOUNDS_STRETCH'; t.boundsWidth = w; t.boundsHeight = h;
          Object.assign(tr, { boundsType: 'OBS_BOUNDS_STRETCH', boundsWidth: w, boundsHeight: h, boundsAlignment: 0 });
        }
      }
      sendTransform(d.scene, d.it.id, tr);
    }
    renderBoxes(guides);
  });

  window.addEventListener('mouseup', () => {
    if (!state.drag) return;
    state.drag = null;
    renderBoxes();
  });

  layer.addEventListener('mouseleave', () => { if (!state.drag && state.hover != null) { state.hover = null; renderBoxes(); } });

  layer.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const it = hitTest(toCanvas(e));
    if (it) {
      state.selected = it.id; renderSources(); renderBoxes();
      itemMenu(e.clientX, e.clientY, it);
    } else {
      showCtx(e.clientX, e.clientY, [{ label: 'Add source…', run: () => openAddSource() }]);
    }
  });

  layer.addEventListener('dblclick', (e) => { const it = hitTest(toCanvas(e)); if (it) openProps(it); });

  // Arrow keys nudge the selected source; Delete removes it.
  document.addEventListener('keydown', (e) => {
    if (modalOpen() || !state.connected) return;
    const tg = e.target;
    if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'SELECT' || tg.tagName === 'TEXTAREA')) return;
    const it = selItem();
    if (!it) return;
    const step = e.shiftKey ? 10 : 1;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key] && !it.locked) {
      e.preventDefault();
      normalize(it);
      it.t.positionX += moves[e.key][0];
      it.t.positionY += moves[e.key][1];
      sendTransform(state.itemsScene, it.id, { positionX: it.t.positionX, positionY: it.t.positionY });
      renderBoxes();
    } else if (e.key === 'Delete') {
      removeItem(it);
    }
  });

  obs.on('SceneItemTransformChanged', (e) => {
    if (e.sceneName !== state.itemsScene) return;
    const it = state.items.find((i) => i.id === e.sceneItemId);
    if (!it || (state.drag && state.drag.it.id === it.id)) return;
    it.t = e.sceneItemTransform;
    renderBoxes();
  });

  // ---------- add source ----------
  const SOURCE_TYPES = [
    { label: 'Browser', hint: 'HTML overlay: web page, local HTML file, alerts, chat', kind: 'browser_source', base: 'Browser', settings: () => ({ url: '', width: state.base.w, height: state.base.h }) },
    { label: 'Image', hint: 'PNG overlay, logo, frame, lower third', kind: 'image_source', base: 'Image' },
    { label: 'Image Slide Show', hint: 'Rotating pictures', kindPrefix: 'slideshow', base: 'Image Slide Show', settings: () => ({ slide_time: 5000, loop: true, transition: 'fade' }) },
    { label: 'Text', hint: 'Titles and labels', kindPrefix: 'text_gdiplus', base: 'Text', settings: () => ({ text: 'New text', font: { face: 'Arial', size: 96, style: 'Bold', flags: 1 } }), center: true },
    { label: 'Color Source', hint: 'Solid color background', kindPrefix: 'color_source', base: 'Color', settings: () => ({ color: 0xFF1E1A17, width: state.base.w, height: state.base.h }) },
    { label: 'Game Capture', hint: 'Hooks into the game for smooth capture', kind: 'game_capture', base: 'Game Capture', settings: () => ({ capture_mode: 'any_fullscreen' }), fit: 'outer' },
    { label: 'Display Capture', hint: 'A whole monitor', kind: 'monitor_capture', base: 'Display Capture', fit: true },
    { label: 'Window Capture', hint: 'One app window', kind: 'window_capture', base: 'Window Capture', fit: true },
    { label: 'Video Capture Device', hint: 'Webcam or HDMI capture card', kind: 'dshow_input', base: 'Video Capture Device', auto: 'video_device_id', fit: 'outer' },
    { label: 'Scene', hint: 'Put another scene inside this one', scene: true },
    { label: 'Media Source', hint: 'Video or audio file', kind: 'ffmpeg_source', base: 'Media Source', settings: () => ({ is_local_file: true, looping: true }), fit: true },
    { label: 'Audio Input Capture', hint: 'Microphone or audio interface', kind: 'wasapi_input_capture', base: 'Audio Input Capture' },
    { label: 'Audio Output Capture', hint: 'PC / desktop sound', kind: 'wasapi_output_capture', base: 'Audio Output Capture' }
  ];

  async function openAddSource() {
    const scene = editScene();
    if (!scene) return;
    let existing = [];
    try {
      const { inputs } = await call('GetInputList');
      const inScene = new Set(state.items.map((i) => i.name));
      existing = inputs.filter((i) => !inScene.has(i.inputName) && !/^wasapi/.test(i.inputKind));
    } catch { existing = []; }
    const types = SOURCE_TYPES.filter((t) => t.scene || (t.kind ? state.kinds.includes(t.kind) : !!pickKind(t.kindPrefix)));
    const body = [
      el('ul', { class: 'src-types' }, types.map((t) => el('li', null, el('button', {
        type: 'button', onClick: () => createSource(scene, t)
      }, el('span', { text: t.label }), el('small', { text: t.hint })))))
    ];
    if (existing.length) {
      body.push(el('p', { text: 'Add an existing source:' }));
      body.push(el('ul', { class: 'src-types' }, existing.map((i) => el('li', null, el('button', {
        type: 'button',
        onClick: async () => {
          closeModal();
          try { await call('CreateSceneItem', { sceneName: scene, sourceName: i.inputName }); } catch (e) { notice('Could not add', errText(e)); }
        }
      }, el('span', { text: i.inputName }), el('small', { text: kindLabel(i.inputKind) }))))));
    }
    openModal(`Add source to "${scene}"`, body, [{ label: 'Cancel' }]);
  }

  async function createSource(scene, t) {
    if (t.scene) {
      const others = state.scenes.filter((n) => n !== scene);
      if (!others.length) return notice('No other scenes', 'Create another scene first, then add it here.');
      const pick = el('select', null, others.map((n) => el('option', { value: n, text: n })));
      openModal('Add scene as a source', field('Scene', pick), [
        { label: 'Cancel' },
        { label: 'OK', kind: 'primary', run: async () => { try { await call('CreateSceneItem', { sceneName: scene, sourceName: pick.value }); } catch (e) { notice('Could not add', errText(e)); } } }
      ]);
      return;
    }
    const kind = t.kind || pickKind(t.kindPrefix);
    const name = await askText('Create new source', 'Name', await uniqueName(t.base));
    if (!name) return;
    try {
      const id = await addInput(scene, name, kind, t.settings ? t.settings() : {});
      if (t.auto) {
        const items = await listItems(name, t.auto);
        if (items.length) await call('SetInputSettings', { inputName: name, inputSettings: { [t.auto]: items[0].value } });
      }
      if (t.fit) await fitItem(scene, id, t.fit === 'outer' ? 'outer' : 'inner');
      if (t.center) await centerItem(scene, id);
      await refreshItems();
      state.selected = id;
      renderSources();
      renderBoxes();
      await openProps({ id, name, kind });
    } catch (e) { notice('Could not add source', errText(e)); }
  }

  // ---------- properties ----------
  function field(label, input, help) { return el('label', { class: 'field' }, el('span', { text: label }), input, help ? el('small', { text: help }) : null); }
  function check(label, on) { const c = el('input', { type: 'checkbox', checked: on }); return { node: el('label', { class: 'check' }, c, label), input: c }; }
  function fileField(label, value, accept) {
    const input = el('input', { type: 'text', value: value || '' });
    const browse = el('button', { class: 'btn', type: 'button', text: 'Browse…', onClick: async () => { const f = await pickFile(accept); if (f) input.value = f; } });
    return { node: el('label', { class: 'field' }, el('span', { text: label }), el('div', { class: 'file-row' }, input, browse)), input };
  }
  async function deviceSelect(inputName, prop, current) {
    const items = await listItems(inputName, prop);
    const sel = el('select', null, items.length ? items.map((i) => el('option', { value: String(i.value), text: i.name })) : el('option', { value: '', text: 'Nothing found' }));
    if (current != null && items.some((i) => String(i.value) === String(current))) sel.value = String(current);
    return { sel, items };
  }

  async function openProps(it) {
    const name = it.name;
    const kind = it.kind || '';
    let s = {};
    try { s = (await call('GetInputSettings', { inputName: name })).inputSettings || {}; } catch { s = {}; }
    const body = [];
    let collect = null;
    const extra = [];

    if (kind === 'browser_source') {
      const local = check('Local file', !!s.is_local_file);
      const url = el('input', { type: 'text', value: s.url || '', placeholder: 'https://…' });
      const file = fileField('Local file', s.local_file, '.html,.htm');
      const w = el('input', { type: 'number', min: '1', max: '8192', value: String(s.width || 800) });
      const h = el('input', { type: 'number', min: '1', max: '8192', value: String(s.height || 600) });
      const css = el('textarea', { spellcheck: 'false' }); css.value = s.css != null ? s.css : 'body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }';
      const shutdown = check('Shutdown source when not visible', !!s.shutdown);
      const restart = check('Refresh browser when scene becomes active', !!s.restart_when_active);
      const audio = check('Control audio via the mixer', !!s.reroute_audio);
      const urlField = field('URL', url);
      const sync = () => { urlField.classList.toggle('hidden', local.input.checked); file.node.classList.toggle('hidden', !local.input.checked); };
      local.input.addEventListener('change', sync);
      sync();
      body.push(local.node, urlField, file.node, el('div', { class: 'row2' }, field('Width', w), field('Height', h)), field('Custom CSS', css), shutdown.node, restart.node, audio.node);
      collect = () => ({ is_local_file: local.input.checked, url: url.value.trim(), local_file: file.input.value.trim(), width: Number(w.value) || 800, height: Number(h.value) || 600, css: css.value, shutdown: shutdown.input.checked, restart_when_active: restart.input.checked, reroute_audio: audio.input.checked });
      extra.push({ label: 'Refresh page', run: async () => { await call('PressInputPropertiesButton', { inputName: name, propertyName: 'refreshnocache' }).catch(() => {}); return true; } });
    } else if (kind.startsWith('slideshow')) {
      const files = (s.files || []).map((f) => f.value).filter(Boolean);
      const listBox = el('div', { class: 'items' });
      const draw = () => listBox.replaceChildren(...(files.length ? files.map((f, i) => el('div', { class: 'file-row' },
        el('input', { type: 'text', value: f, readonly: true }),
        el('button', { class: 'btn', type: 'button', text: 'Remove', onClick: () => { files.splice(i, 1); draw(); } }))) : [el('p', { class: 'muted small', text: 'No images yet.' })]));
      draw();
      const addBtn = el('button', { class: 'btn', type: 'button', text: '+ Add images', onClick: async () => { const fs2 = await pickFiles('image/*'); files.push(...fs2); draw(); } });
      const time = el('input', { type: 'number', min: '500', step: '500', value: String(s.slide_time || 5000) });
      const trans = el('select', null, [['fade', 'Fade'], ['cut', 'Cut'], ['swipe', 'Swipe'], ['slide', 'Slide']].map(([v2, t2]) => el('option', { value: v2, text: t2 })));
      trans.value = s.transition || 'fade';
      const loop = check('Loop', s.loop !== false);
      const rand = check('Randomize playback', !!s.randomize);
      body.push(field('Images', listBox), addBtn, el('div', { class: 'row2' }, field('Time between slides (ms)', time), field('Transition', trans)), loop.node, rand.node);
      collect = () => ({ files: files.map((f) => ({ value: f, hidden: false, selected: false })), slide_time: Number(time.value) || 5000, transition: trans.value, loop: loop.input.checked, randomize: rand.input.checked });
    } else if (kind === 'image_source') {
      const file = fileField('Image file', s.file, 'image/*');
      body.push(file.node);
      collect = () => ({ file: file.input.value.trim() });
    } else if (kind === 'ffmpeg_source') {
      const file = fileField('Media file', s.local_file, 'video/*,audio/*');
      const loop = check('Loop', s.looping !== false);
      const restart = check('Restart playback when source becomes active', s.restart_on_activate !== false);
      body.push(file.node, loop.node, restart.node);
      collect = () => ({ is_local_file: true, local_file: file.input.value.trim(), looping: loop.input.checked, restart_on_activate: restart.input.checked });
    } else if (kind.startsWith('text_')) {
      const font = s.font || { face: 'Arial', size: 96, style: 'Bold', flags: 1 };
      const text = el('textarea'); text.value = s.text || '';
      const face = el('input', { type: 'text', value: font.face || 'Arial' });
      const size = el('input', { type: 'number', min: '8', max: '1000', value: String(font.size || 96) });
      const color = el('input', { type: 'color', value: s.color != null ? obsToHex(s.color) : '#ffffff' });
      const bold = check('Bold', ((font.flags || 0) & 1) === 1);
      const outline = check('Outline', !!s.outline);
      body.push(field('Text', text), el('div', { class: 'row2' }, field('Font', face), field('Size', size)), field('Color', color), bold.node, outline.node);
      collect = () => {
        const flags = (bold.input.checked ? 1 : 0) | ((font.flags || 0) & 2);
        return { text: text.value, color: hexToObs(color.value), outline: outline.input.checked, font: { face: face.value || 'Arial', size: Number(size.value) || 96, style: bold.input.checked ? 'Bold' : 'Regular', flags } };
      };
    } else if (kind.startsWith('color_source')) {
      const color = el('input', { type: 'color', value: s.color != null ? obsToHex(s.color) : '#171a1e' });
      const w = el('input', { type: 'number', min: '1', max: '8192', value: String(s.width || state.base.w) });
      const h = el('input', { type: 'number', min: '1', max: '8192', value: String(s.height || state.base.h) });
      body.push(field('Color', color), el('div', { class: 'row2' }, field('Width', w), field('Height', h)));
      collect = () => ({ color: hexToObs(color.value), width: Number(w.value) || state.base.w, height: Number(h.value) || state.base.h });
    } else if (kind === 'dshow_input') {
      const d = await deviceSelect(name, 'video_device_id', s.video_device_id);
      body.push(field('Device', d.sel, 'Webcams and HDMI capture cards show here.'));
      collect = () => ({ video_device_id: d.sel.value });
    } else if (kind === 'monitor_capture') {
      let d = await deviceSelect(name, 'monitor_id', s.monitor_id);
      let prop = 'monitor_id';
      if (!d.items.length) { d = await deviceSelect(name, 'monitor', s.monitor); prop = 'monitor'; }
      const cursor = check('Capture cursor', s.capture_cursor !== false);
      body.push(field('Display', d.sel), cursor.node);
      collect = () => ({ [prop]: d.items.length && typeof d.items[0].value === 'number' ? Number(d.sel.value) : d.sel.value, capture_cursor: cursor.input.checked });
    } else if (kind === 'window_capture') {
      const d = await deviceSelect(name, 'window', s.window);
      const cursor = check('Capture cursor', s.cursor !== false);
      body.push(field('Window', d.sel), cursor.node);
      collect = () => ({ window: d.sel.value, cursor: cursor.input.checked });
    } else if (kind === 'game_capture') {
      const mode = el('select', null,
        el('option', { value: 'any_fullscreen', text: 'Capture any fullscreen application' }),
        el('option', { value: 'window', text: 'Capture specific window' }));
      mode.value = s.capture_mode === 'window' ? 'window' : 'any_fullscreen';
      const d = await deviceSelect(name, 'window', s.window);
      const winField = field('Window', d.sel, 'Start the game first so it shows in this list.');
      const cursor = check('Capture cursor', s.capture_cursor !== false);
      const sync = () => winField.classList.toggle('hidden', mode.value !== 'window');
      mode.addEventListener('change', sync);
      sync();
      body.push(field('Mode', mode), winField, cursor.node);
      collect = () => {
        const o = { capture_mode: mode.value, capture_cursor: cursor.input.checked };
        if (mode.value === 'window') o.window = d.sel.value;
        return o;
      };
    } else if (kind.startsWith('wasapi')) {
      const d = await deviceSelect(name, 'device_id', s.device_id);
      body.push(field('Device', d.sel));
      collect = () => ({ device_id: d.sel.value });
    } else {
      body.push(el('p', { text: 'This source has no settings to change here.' }));
    }

    openModal(`Properties for "${name}"`, body, extra.concat([
      { label: 'Cancel' },
      {
        label: 'OK', kind: 'primary',
        run: async () => {
          if (!collect) return;
          try { await call('SetInputSettings', { inputName: name, inputSettings: collect(), overlay: true }); } catch (e) { notice('Could not save', errText(e)); return true; }
          setTimeout(refreshItems, 600);
        }
      }
    ]));
  }

  // ---------- transitions / studio mode ----------
  async function refreshTransitions() {
    const r = await call('GetSceneTransitionList');
    state.transitions = r.transitions;
    state.transition = r.currentSceneTransitionName;
    const sel = $('transSel');
    sel.replaceChildren(...r.transitions.map((t) => el('option', { value: t.transitionName, text: t.transitionName })));
    sel.value = state.transition;
    try {
      const cur = await call('GetCurrentSceneTransition');
      $('durInput').value = String(cur.transitionDuration || 300);
      $('durInput').disabled = !!cur.transitionFixed;
    } catch { /* ignore */ }
  }
  $('transSel').addEventListener('change', (e) => call('SetCurrentSceneTransition', { transitionName: e.target.value }).catch(() => {}));
  $('durInput').addEventListener('change', (e) => call('SetCurrentSceneTransitionDuration', { transitionDuration: Math.max(50, Number(e.target.value) || 300) }).catch(() => {}));
  obs.on('CurrentSceneTransitionChanged', () => refreshTransitions().catch(() => {}));

  async function take() { try { await call('TriggerStudioModeTransition'); } catch (e) { console.warn(e); } }
  async function cut() {
    const prev = state.transition;
    if (!state.transitions.some((t) => t.transitionName === 'Cut') || prev === 'Cut') return take();
    try {
      await call('SetCurrentSceneTransition', { transitionName: 'Cut' });
      await call('TriggerStudioModeTransition');
    } finally {
      setTimeout(() => call('SetCurrentSceneTransition', { transitionName: prev }).catch(() => {}), 150);
    }
  }
  $('takeBtn').addEventListener('click', take);
  $('cutBtn').addEventListener('click', cut);

  function applyStudioLayout() {
    $('transCol').classList.toggle('hidden', !state.studio);
    $('programView').classList.toggle('hidden', !state.studio);
    $('previewLabel').classList.toggle('hidden', !state.studio);
    $('studioBtn').setAttribute('aria-pressed', String(state.studio));
    requestAnimationFrame(fitAll);
  }
  $('studioBtn').addEventListener('click', () => call('SetStudioModeEnabled', { studioModeEnabled: !state.studio }).catch(() => {}));
  obs.on('StudioModeStateChanged', async (e) => {
    state.studio = e.studioModeEnabled;
    applyStudioLayout();
    await refreshScenes().catch(() => {});
  });

  obs.on('CurrentProgramSceneChanged', (e) => {
    state.pgm = e.sceneName;
    renderScenes();
    if (!state.studio) { state.selected = null; refreshItems(); }
  });
  obs.on('CurrentPreviewSceneChanged', (e) => {
    state.pvw = e.sceneName;
    renderScenes();
    if (state.studio) { state.selected = null; refreshItems(); }
  });
  ['SceneCreated', 'SceneRemoved', 'SceneNameChanged', 'SceneListChanged'].forEach((ev) => obs.on(ev, () => refreshScenes().catch(() => {})));
  ['SceneItemCreated', 'SceneItemRemoved', 'SceneItemEnableStateChanged', 'SceneItemLockStateChanged', 'SceneItemListReindexed'].forEach((ev) => obs.on(ev, (e) => {
    if (e.sceneName === state.itemsScene) refreshItems();
  }));
  obs.on('InputNameChanged', () => refreshItems());

  // ---------- audio mixer ----------
  const dbFromMul = (m) => (m > 0 ? 20 * Math.log10(m) : -100);
  const pctFromDb = (db) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));

  async function buildChannel(name) {
    const fill = el('i');
    const db = el('span', { class: 'mx-db', text: '0.0 dB' });
    const fader = el('input', { type: 'range', min: '-60', max: '0', step: '0.1', value: '0', 'aria-label': name + ' volume' });
    const mute = el('button', { class: 'mx-mute', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Mute ' + name, title: 'Mute', text: '🔊' });
    const node = el('div', { class: 'mx' },
      el('span', { class: 'mx-name', text: name, title: name }), db,
      el('div', { class: 'mx-meter' }, fill),
      el('div', { class: 'mx-row' }, fader, mute));
    const ch = { node, fill, fader, mute, db };
    const showDb = () => { db.textContent = Number(fader.value) <= -60 ? '-inf dB' : Number(fader.value).toFixed(1) + ' dB'; };
    ch.showDb = showDb;
    mute.addEventListener('click', () => call('ToggleInputMute', { inputName: name }).catch(() => {}));
    fader.addEventListener('input', () => { showDb(); call('SetInputVolume', { inputName: name, inputVolumeDb: Number(fader.value) <= -60 ? -100 : Number(fader.value) }).catch(() => {}); });
    try {
      const m = await call('GetInputMute', { inputName: name });
      setMuteUi(ch, m.inputMuted);
      const v = await call('GetInputVolume', { inputName: name });
      fader.value = String(Math.max(-60, v.inputVolumeDb));
      showDb();
    } catch { /* ignore */ }
    return ch;
  }
  function setMuteUi(ch, muted) { ch.mute.setAttribute('aria-pressed', String(muted)); ch.mute.textContent = muted ? '🔇' : '🔊'; }

  obs.on('InputVolumeMeters', (data) => { state.meterQueue = data.inputs; });
  let rebuildingMixer = false;
  function drawMeters() {
    const inputs = state.meterQueue;
    state.meterQueue = null;
    if (inputs) {
      const names = inputs.map((i) => i.inputName);
      const known = [...state.channels.keys()];
      const changed = names.length !== known.length || names.some((n, i) => n !== known[i]);
      if (changed && !rebuildingMixer) {
        rebuildingMixer = true;
        Promise.all(names.map((n) => state.channels.get(n) || buildChannel(n))).then((chs) => {
          state.channels = new Map(names.map((n, i) => [n, chs[i]]));
          $('mixer').replaceChildren(...(chs.length ? chs.map((c) => c.node) : [el('p', { class: 'muted pad', text: 'No audio sources.' })]));
        }).finally(() => { rebuildingMixer = false; });
      }
      for (const inp of inputs) {
        const ch = state.channels.get(inp.inputName);
        if (!ch) continue;
        let peak = 0;
        for (const lv of inp.inputLevelsMul || []) peak = Math.max(peak, lv[1] || 0);
        const d = dbFromMul(peak);
        ch.fill.style.width = pctFromDb(d) + '%';
        ch.fill.className = d > -3 ? 'clip' : d > -12 ? 'hot' : '';
      }
    }
    requestAnimationFrame(drawMeters);
  }
  requestAnimationFrame(drawMeters);
  obs.on('InputMuteStateChanged', (e) => { const c = state.channels.get(e.inputName); if (c) setMuteUi(c, e.inputMuted); });
  obs.on('InputVolumeChanged', (e) => {
    const c = state.channels.get(e.inputName);
    if (c && document.activeElement !== c.fader) { c.fader.value = String(Math.max(-60, e.inputVolumeDb)); c.showDb(); }
  });

  // ---------- streaming ----------
  async function renderDest() {
    const d = await window.tonix.getDestination();
    const p = PLATFORMS[d.platform] || PLATFORMS.custom;
    $('destLabel').textContent = d.key && d.server ? p.name : 'not set — open Settings › Stream';
  }

  function setLive(live) {
    state.live = !!live;
    window.tonix.setLive(state.live);
    const b = $('liveBtn');
    b.textContent = state.live ? 'Stop Streaming' : 'Start Streaming';
    b.classList.toggle('is-live', state.live);
    const st = $('liveStatus');
    st.classList.toggle('on', state.live);
    if (!state.live) { st.textContent = '○ LIVE: 00:00:00'; $('statRate').textContent = '0'; }
  }

  $('liveBtn').addEventListener('click', async () => {
    if (state.live) {
      if (!state.settings.general.confirmStop || await confirmBox('Stop streaming', 'Are you sure you want to stop streaming?', 'Stop Streaming')) call('StopStream').catch(() => {});
      return;
    }
    startStreaming(false);
  });

  async function startStreaming(skipConfirm) {
    const d = await window.tonix.getDestination();
    if (!d.key || !d.server) return openSettings('Stream');
    if (!skipConfirm && state.settings.general.confirmStart && !(await confirmBox('Start streaming', 'Are you sure you want to start streaming?', 'Start Streaming'))) return;
    try {
      await call('SetStreamServiceSettings', { streamServiceType: 'rtmp_custom', streamServiceSettings: { server: d.server, key: d.key, use_auth: false } });
      state.startAttemptAt = Date.now();
      await call('StartStream');
    } catch (e) { encoderTrouble(errText(e)); }
  }

  obs.on('StreamStateChanged', (e) => {
    if (e.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') { state.lastBytes = 0; setLive(true); if (state.settings.general.autoRecord && !state.rec) toggleRec(true); }
    if (e.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
      const quick = state.startAttemptAt && Date.now() - state.startAttemptAt < 8000;
      setLive(false);
      if (state.settings.general.autoRecord && state.rec) toggleRec(false);
      if (quick) encoderTrouble('The stream stopped right after starting.');
      state.startAttemptAt = 0;
    }
  });

  function encoderTrouble(detail) {
    if (state.info.encoder === 'x264') {
      return notice('Could not start streaming', detail + ' Check the stream key and server in Settings › Stream, and your internet connection.');
    }
    openModal('Could not start streaming', [
      el('p', { text: detail }),
      el('p', { text: `This is usually a wrong stream key, or the ${state.info.encoderLabel} encoder not working on this PC. Check your key first. If it is correct, switch to CPU encoding.` })
    ], [
      { label: 'Check stream key', run: () => { setTimeout(() => openSettings('Stream'), 0); } },
      { label: 'Use CPU encoding', kind: 'primary', run: () => applySettings({ output: { encoder: 'x264' } }) }
    ]);
  }

  // ---------- recording ----------
  function setRec(on) {
    state.rec = !!on;
    const b = $('recBtn');
    b.textContent = state.rec ? 'Stop Recording' : 'Start Recording';
    b.classList.toggle('is-live', state.rec);
    $('recStatus').classList.toggle('on', state.rec);
    if (!state.rec) $('recStatus').textContent = '○ REC: 00:00:00';
  }
  async function toggleRec(want) {
    const on = want == null ? !state.rec : want;
    try { await call(on ? 'StartRecord' : 'StopRecord'); } catch (e) { if (want == null) notice('Recording', errText(e)); }
  }
  $('recBtn').addEventListener('click', () => toggleRec());
  obs.on('RecordStateChanged', (e) => {
    if (e.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') setRec(true);
    if (e.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
      setRec(false);
      if (e.outputPath) { $('healthBar').textContent = 'Recording saved: ' + e.outputPath; $('healthBar').classList.remove('hidden'); }
    }
  });

  // ---------- look: theme, selection colors, safe zones ----------
  function applyLook() {
    const g = state.settings.general, a = state.settings.access;
    document.body.classList.toggle('theme-grey', g.theme === 'grey');
    document.documentElement.style.setProperty('--sel', a.selColor || '#e5383b');
    document.documentElement.style.setProperty('--hov', a.hoverColor || '#ffffff');
    const portrait = state.base.h > state.base.w;
    $('safeBtn').classList.toggle('hidden', !portrait);
    $('safeBtn').setAttribute('aria-pressed', String(!!g.safeZones));
    $('safeLayer').classList.toggle('hidden', !(portrait && g.safeZones));
    $('canvasChip').textContent = `${portrait ? 'Vertical' : 'Landscape'} canvas · ${state.base.w} × ${state.base.h}`;
    $('canvasHint').textContent = portrait ? 'Made for TikTok, YouTube Shorts, Instagram and Facebook Reels' : 'Landscape: switch to 1080x1920 in Settings › Video for phones';
    $('outLabel').textContent = state.info.videoLabel;
  }
  async function saveSection(section, patch) {
    state.settings = await window.tonix.saveSettings({ [section]: patch });
    return state.settings;
  }
  $('safeBtn').addEventListener('click', async () => { await saveSection('general', { safeZones: !state.settings.general.safeZones }); applyLook(); });

  // ---------- phone layout templates ----------
  const COLORS = { game: '#2a3f63', cam: '#3d2f55', cam2: '#523046', browser: '#1f4a3c', title: '#f0a020', logo: '#7a2e30', slides: '#5a4a1c', bg: '#26282f' };
  const FILL_ROLES = new Set(['game', 'cam', 'cam2', 'bg']);
  const TEMPLATES = [
    { id: 'starting', name: 'Starting soon', hint: 'Title card with slides', create: ['bg', 'slides', 'title'],
      r: { bg: [0, 0, 100, 100], slides: [8, 22, 84, 30], title: [10, 58, 80, 8], logo: [36, 8, 28, 9] } },
    { id: 'split', name: 'Game + cam split', hint: 'Game on top, you below', create: ['game', 'cam', 'title'],
      r: { game: [0, 0, 100, 46], cam: [0, 46, 100, 54], browser: [4, 56, 58, 20], title: [4, 41, 66, 6], logo: [72, 2, 25, 6] } },
    { id: 'full', name: 'Full-screen game', hint: 'Game fills the phone, cam bubble', create: ['game', 'cam', 'title'],
      r: { game: [0, 0, 100, 100], cam: [52, 9, 42, 20], browser: [6, 30, 60, 10], title: [4, 74, 70, 6], logo: [4, 9, 25, 6] } },
    { id: 'chatting', name: 'Just chatting', hint: 'Camera full screen with chat', create: ['cam', 'title'],
      r: { cam: [0, 0, 100, 100], browser: [4, 50, 62, 26], title: [4, 40, 70, 6], logo: [4, 9, 25, 6] } },
    { id: 'podcast', name: 'Podcast duo', hint: 'Two cameras stacked', create: ['cam', 'cam2', 'title'],
      r: { cam: [0, 0, 100, 50], cam2: [0, 50, 100, 50], title: [10, 47, 80, 6], logo: [72, 2, 25, 6] } }
  ];
  const ROLE_ORDER = ['bg', 'game', 'cam', 'cam2', 'slides', 'browser', 'logo', 'title'];

  function renderTemplates() {
    $('templates').replaceChildren(...TEMPLATES.map((t) => {
      const thumb = el('span', { class: 'tpl-thumb' });
      for (const [role, r] of Object.entries(t.r)) {
        const b = el('i');
        b.style.left = r[0] + '%'; b.style.top = r[1] + '%'; b.style.width = r[2] + '%'; b.style.height = r[3] + '%';
        b.style.background = COLORS[role];
        thumb.append(b);
      }
      return el('button', { class: 'tpl', type: 'button', onClick: () => applyTemplate(t) },
        thumb, el('span', { class: 'tpl-text' }, el('b', { text: t.name }), el('span', { text: t.hint })));
    }));
  }

  function rolesIn(items) {
    const roles = {};
    const cams = items.filter((i) => i.kind === 'dshow_input');
    const first = (pred) => items.find(pred) || null;
    roles.game = first((i) => i.kind === 'game_capture');
    roles.cam = cams[0] || null;
    roles.cam2 = cams[1] || null;
    roles.title = first((i) => (i.kind || '').startsWith('text_'));
    roles.slides = first((i) => (i.kind || '').startsWith('slideshow'));
    roles.bg = first((i) => (i.kind || '').startsWith('color_source'));
    roles.browser = first((i) => i.kind === 'browser_source');
    roles.logo = first((i) => i.kind === 'image_source');
    return roles;
  }

  async function reuseOrCreate(scene, role) {
    const { inputs } = await call('GetInputList');
    const used = new Set(state.items.map((i) => i.name));
    const reuse = (kindTest) => inputs.find((i) => kindTest(i.inputKind) && !used.has(i.inputName));
    if (role === 'game') {
      const ex = reuse((k) => k === 'game_capture');
      if (ex) return call('CreateSceneItem', { sceneName: scene, sourceName: ex.inputName });
      return call('CreateInput', { sceneName: scene, inputName: await uniqueName('Game Capture'), inputKind: 'game_capture', inputSettings: { capture_mode: 'any_fullscreen' } });
    }
    if (role === 'cam' || role === 'cam2') {
      const ex = reuse((k) => k === 'dshow_input');
      if (ex) return call('CreateSceneItem', { sceneName: scene, sourceName: ex.inputName });
      const name = await uniqueName('Video Capture Device');
      const r = await call('CreateInput', { sceneName: scene, inputName: name, inputKind: 'dshow_input', inputSettings: {} });
      const devs = await listItems(name, 'video_device_id');
      const pick = devs[role === 'cam2' ? 1 : 0] || devs[0];
      if (pick) await call('SetInputSettings', { inputName: name, inputSettings: { video_device_id: pick.value } });
      return r;
    }
    if (role === 'title') {
      const k = pickKind('text_gdiplus');
      if (!k) return null;
      return call('CreateInput', { sceneName: scene, inputName: await uniqueName('Title'), inputKind: k, inputSettings: { text: 'YOUR TITLE', font: { face: 'Arial', size: 96, style: 'Bold', flags: 1 } } });
    }
    if (role === 'bg') {
      const k = pickKind('color_source');
      if (!k) return null;
      return call('CreateInput', { sceneName: scene, inputName: await uniqueName('Background'), inputKind: k, inputSettings: { color: 0xFF1E1A17, width: state.base.w, height: state.base.h } });
    }
    if (role === 'slides') {
      const k = pickKind('slideshow');
      if (!k) return null;
      return call('CreateInput', { sceneName: scene, inputName: await uniqueName('Image Slide Show'), inputKind: k, inputSettings: { slide_time: 5000, loop: true, transition: 'fade' } });
    }
    return null;
  }

  async function placeRect(scene, id, rect, mode) {
    const W = state.base.w, H = state.base.h;
    const tr = {
      positionX: (rect[0] / 100) * W, positionY: (rect[1] / 100) * H, alignment: 5, rotation: 0,
      boundsType: mode === 'outer' ? 'OBS_BOUNDS_SCALE_OUTER' : 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0,
      boundsWidth: (rect[2] / 100) * W, boundsHeight: (rect[3] / 100) * H
    };
    await call('SetSceneItemTransform', { sceneName: scene, sceneItemId: id, sceneItemTransform: tr });
    if (mode === 'outer') {
      try { await call('SetSceneItemTransform', { sceneName: scene, sceneItemId: id, sceneItemTransform: { cropToBounds: true } }); } catch { /* older engine */ }
    }
  }

  async function applyTemplate(t) {
    const scene = editScene();
    if (!scene) return;
    if (!(await confirmBox('Apply layout', `Arrange "${scene}" as "${t.name}"? Missing sources will be added.`, 'Apply'))) return;
    try {
      await refreshItems();
      let roles = rolesIn(state.items);
      for (const role of t.create) if (!roles[role]) await reuseOrCreate(scene, role);
      await refreshItems();
      roles = rolesIn(state.items);
      for (const [role, rect] of Object.entries(t.r)) {
        const it = roles[role];
        if (it) await placeRect(scene, it.id, rect, FILL_ROLES.has(role) ? 'outer' : 'inner');
      }
      const ordered = ROLE_ORDER.map((r) => roles[r]).filter((it) => it && t.r[ROLE_ORDER.find((x) => roles[x] === it)]);
      const top = state.items.length - 1;
      for (let i = ordered.length - 1, idx = top; i >= 0; i--, idx--) {
        await call('SetSceneItemIndex', { sceneName: scene, sceneItemId: ordered[i].id, sceneItemIndex: Math.max(0, idx) }).catch(() => {});
      }
      await refreshItems();
    } catch (e) { notice('Could not apply layout', errText(e)); }
  }

  // ---------- transform panel ----------
  function renderTransform() {
    const it = selItem();
    $('tfEmpty').classList.toggle('hidden', !!it);
    $('tfBody').classList.toggle('hidden', !it);
    if (!it) return;
    $('tfName').textContent = it.name;
    $('tfKind').textContent = kindLabel(it.kind);
    const b = boxOf(it.t);
    const vals = { tfX: b.x, tfY: b.y, tfW: b.w, tfH: b.h, tfR: it.t.rotation || 0 };
    for (const [id, v] of Object.entries(vals)) if (document.activeElement !== $(id)) $(id).value = String(Math.round(v));
    for (const id of ['tfX', 'tfY', 'tfW', 'tfH', 'tfR']) $(id).disabled = it.locked;
  }

  function sizeTransform(it, w, h) {
    const t = it.t;
    if (bounded(t)) { t.boundsWidth = w; t.boundsHeight = h; return { boundsWidth: w, boundsHeight: h }; }
    const srcW = (t.sourceWidth || 0) - (t.cropLeft || 0) - (t.cropRight || 0);
    const srcH = (t.sourceHeight || 0) - (t.cropTop || 0) - (t.cropBottom || 0);
    if (srcW > 0 && srcH > 0) {
      t.scaleX = w / srcW; t.scaleY = h / srcH; t.width = w; t.height = h;
      return { scaleX: t.scaleX, scaleY: t.scaleY };
    }
    t.boundsType = 'OBS_BOUNDS_STRETCH'; t.boundsWidth = w; t.boundsHeight = h;
    return { boundsType: 'OBS_BOUNDS_STRETCH', boundsWidth: w, boundsHeight: h, boundsAlignment: 0 };
  }

  for (const id of ['tfX', 'tfY', 'tfW', 'tfH', 'tfR']) {
    $(id).addEventListener('change', () => {
      const it = selItem();
      if (!it || it.locked) return;
      normalize(it);
      const x = Number($('tfX').value) || 0, y = Number($('tfY').value) || 0;
      const w = Math.max(1, Number($('tfW').value) || 1), h = Math.max(1, Number($('tfH').value) || 1);
      it.t.positionX = x; it.t.positionY = y;
      const tr = Object.assign({ positionX: x, positionY: y }, sizeTransform(it, w, h));
      if (id === 'tfR') { it.t.rotation = Number($('tfR').value) || 0; tr.rotation = it.t.rotation; }
      sendTransform(state.itemsScene, it.id, tr);
      renderBoxes();
    });
  }
  $('tfFit').addEventListener('click', () => { const it = selItem(); if (it) fitItem(state.itemsScene, it.id, 'inner').catch(() => {}); });
  $('tfFill').addEventListener('click', () => { const it = selItem(); if (it) fitItem(state.itemsScene, it.id, 'outer').catch(() => {}); });
  $('tfCenter').addEventListener('click', () => { const it = selItem(); if (it) centerBox(it); });
  $('tfTop').addEventListener('click', () => { const it = selItem(); if (it) moveOrder(it, 'top'); });

  // ---------- settings window (OBS layout) ----------
  $('settingsBtn').addEventListener('click', () => openSettings('General'));
  $('settingsTop').addEventListener('click', () => openSettings('General'));

  const CATS = ['General', 'Stream', 'Output', 'Audio', 'Video', 'Hotkeys', 'Accessibility', 'Advanced'];
  const RESOLUTIONS = [
    { v: '1080x1920', label: '1080x1920 (Phone · 9:16)' },
    { v: '720x1280', label: '720x1280 (Phone · 9:16)' },
    { v: '1920x1080', label: '1920x1080 (Landscape · 16:9)' },
    { v: '1280x720', label: '1280x720 (Landscape · 16:9)' }
  ];
  const opt = (v, text) => el('option', { value: String(v), text });
  function sel(options, value) { const s = el('select', null, options.map(([v, t]) => opt(v, t))); s.value = String(value); return s; }
  function row(label, control) { return el('div', { class: 'frow' }, el('span', { text: label }), control); }
  function grp(title, ...kids) { return el('fieldset', { class: 'grp' }, el('legend', { text: title }), kids); }
  function cb(label, on) { const c = el('input', { type: 'checkbox', checked: on }); return { node: el('label', { class: 'check' }, c, label), input: c }; }

  function acceleratorFrom(e) {
    const k = e.key;
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return null;
    let key = null;
    if (/^F\d{1,2}$/.test(k)) key = k;
    else if (/^[a-z0-9]$/i.test(k)) key = k.toUpperCase();
    else if (k === ' ') key = 'Space';
    else if (/^Numpad\d$/.test(e.code)) key = 'num' + e.code.slice(6);
    else if (['Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Up', 'Down', 'Left', 'Right'].includes(k.replace('Arrow', ''))) key = k.replace('Arrow', '');
    if (!key) return null;
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    return mods.concat(key).join('+');
  }

  async function openSettings(startCat) {
    const s = await window.tonix.getSettings();
    const d = await window.tonix.getDestination();
    const info = state.info;
    const g = s.general, v = s.video, o = s.output, a = s.audio, adv = s.advanced, acc = s.access;
    const pages = {};
    const collect = [];

    // General
    const theme = sel([['dark', 'Yami (Dark)'], ['grey', 'Grey']], g.theme);
    const cStart = cb('Show confirmation dialog when starting streams', g.confirmStart);
    const cStop = cb('Show confirmation dialog when stopping streams', g.confirmStop);
    const cAuto = cb('Automatically record when streaming', g.autoRecord);
    const cSnap = cb('Enable snapping', g.snapping);
    const cSafe = cb('Show phone safe zones', g.safeZones);
    const cPerf = cb('Performance Mode (slower preview pictures, lighter on the PC)', g.perf);
    pages.General = [
      grp('General', row('Language', sel([['en', 'English']], 'en')), row('Theme', theme)),
      grp('Output', cStart.node, cStop.node, cAuto.node),
      grp('Preview', cSnap.node, cSafe.node, cPerf.node)
    ];
    collect.push(() => ({ general: { theme: theme.value, confirmStart: cStart.input.checked, confirmStop: cStop.input.checked, autoRecord: cAuto.input.checked, snapping: cSnap.input.checked, safeZones: cSafe.input.checked, perf: cPerf.input.checked } }));

    // Stream
    const plat = sel(Object.entries(PLATFORMS).map(([k, p]) => [k, p.name]), PLATFORMS[d.platform] ? d.platform : 'custom');
    const server = el('input', { type: 'text', value: d.server || '', placeholder: 'rtmp://…' });
    const key = el('input', { type: 'password', value: '', placeholder: d.key ? 'Saved (leave blank to keep)' : 'Paste your stream key', autocomplete: 'off' });
    const show = el('button', { class: 'btn', type: 'button', text: 'Show' });
    show.addEventListener('click', () => { key.type = key.type === 'password' ? 'text' : 'password'; show.textContent = key.type === 'password' ? 'Show' : 'Hide'; });
    const help = el('p', { class: 'muted small' });
    const syncPlat = () => {
      const p = PLATFORMS[plat.value];
      help.textContent = 'Where to find it: ' + p.help;
      server.readOnly = !!p.server;
      if (p.server) server.value = p.server;
    };
    plat.addEventListener('change', () => { if (!PLATFORMS[plat.value].server) server.value = ''; syncPlat(); });
    syncPlat();
    pages.Stream = [
      grp('Stream', row('Service', plat), row('Server', server), row('Stream Key', el('div', { class: 'file-row' }, key, show)), help,
        el('p', { class: 'muted small', text: 'Your key is stored encrypted on this PC and only sent to the service you pick.' })),
      grp('Multistream', el('p', { class: 'muted small', text: 'Going live on several services at once (encoded once, sent to each) arrives in the multistream update.' }),
        el('button', { class: 'btn', type: 'button', text: '+ Add service', disabled: true }))
    ];

    // Output
    const encSel = sel([['auto', `Automatic (${info.encoders[info.detectedEncoder]})`]].concat(Object.entries(info.encoders).map(([k, n]) => [k, n.startsWith('CPU') ? 'Software (x264)' : 'Hardware (' + n + ')'])), o.encoder);
    const vb = el('input', { type: 'number', min: '500', max: '20000', step: '250', value: String(o.bitrate) });
    const ab = sel([[96, '96'], [128, '128'], [160, '160'], [192, '192'], [256, '256'], [320, '320']], o.audioBitrate);
    const recPath = el('input', { type: 'text', value: o.recPath || '' });
    const browse = el('button', { class: 'btn', type: 'button', text: 'Browse', onClick: async () => { const f = await window.tonix.pickFolder(recPath.value); if (f) recPath.value = f; } });
    const recQ = sel([['Stream', 'Same as stream'], ['Small', 'High Quality, Medium File Size'], ['HQ', 'Indistinguishable Quality, Large File Size']], o.recQuality);
    const recF = sel([['fragmented_mp4', 'Fragmented MP4 (.mp4)'], ['mkv', 'Matroska Video (.mkv)'], ['mp4', 'MPEG-4 (.mp4)'], ['mov', 'QuickTime (.mov)']], o.recFormat);
    pages.Output = [
      row('Output Mode', sel([['Simple', 'Simple']], 'Simple')),
      grp('Streaming', row('Video Bitrate (Kbps)', vb), row('Video Encoder', encSel), row('Audio Bitrate', ab),
        el('p', { class: 'muted small', text: `Detected: ${info.detectedGpu}. Hardware encoders keep the CPU free for your game.` })),
      grp('Recording', row('Recording Path', el('div', { class: 'file-row' }, recPath, browse)), row('Recording Quality', recQ), row('Recording Format', recF))
    ];
    collect.push(() => ({ output: { encoder: encSel.value, bitrate: Number(vb.value) || 4500, audioBitrate: Number(ab.value), recPath: recPath.value.trim(), recQuality: recQ.value, recFormat: recF.value } }));

    // Audio
    const sr = sel([[48000, '48 kHz'], [44100, '44.1 kHz']], a.sampleRate);
    const ch = sel([['Stereo', 'Stereo'], ['Mono', 'Mono']], a.channels);
    const devRows = [];
    const devChanges = [];
    let special = {};
    try { special = await call('GetSpecialInputs'); } catch { special = {}; }
    const devDefs = [['desktop1', 'Desktop Audio'], ['desktop2', 'Desktop Audio 2'], ['mic1', 'Mic/Auxiliary Audio'], ['mic2', 'Mic/Auxiliary Audio 2']];
    for (const [k, label] of devDefs) {
      const name = special[k];
      if (!name) { devRows.push(row(label, el('span', { class: 'muted', text: 'Disabled' }))); continue; }
      const items = await listItems(name, 'device_id');
      let cur = 'default';
      try { cur = (await call('GetInputSettings', { inputName: name })).inputSettings.device_id || 'default'; } catch { /* default */ }
      const s1 = sel(items.length ? items.map((i) => [i.value, i.name]) : [['default', 'Default']], cur);
      devRows.push(row(label, s1));
      devChanges.push(() => (s1.value !== String(cur) ? call('SetInputSettings', { inputName: name, inputSettings: { device_id: s1.value } }).catch(() => {}) : null));
    }
    pages.Audio = [
      grp('General', row('Sample Rate', sr), row('Channels', ch)),
      grp('Global Audio Devices', devRows),
      grp('Advanced', row('Monitoring Device', sel([['default', 'Default']], 'default')))
    ];
    collect.push(() => ({ audio: { sampleRate: Number(sr.value), channels: ch.value } }));

    // Video
    const baseSel = sel(RESOLUTIONS.map((r) => [r.v, r.label]), `${v.baseW}x${v.baseH}`);
    const outSel = el('select');
    const syncOut = () => {
      const [bw, bh] = baseSel.value.split('x').map(Number);
      const choices = RESOLUTIONS.filter((r) => { const [w, h] = r.v.split('x').map(Number); return (w > h) === (bw > bh) && w <= bw; });
      const cur = outSel.value || `${v.outW}x${v.outH}`;
      outSel.replaceChildren(...choices.map((r) => opt(r.v, r.v)));
      outSel.value = choices.some((r) => r.v === cur) ? cur : choices[0].v;
    };
    baseSel.addEventListener('change', syncOut);
    syncOut();
    const filt = sel([['bilinear', 'Bilinear (Fastest)'], ['area', 'Area'], ['bicubic', 'Bicubic (Sharpened scaling, 16 samples)'], ['lanczos', 'Lanczos (Sharpened scaling, 36 samples)']], v.filter);
    const fps = sel([[24, '24'], [30, '30'], [60, '60']], v.fps);
    pages.Video = [
      el('div', { class: 'note-box', text: 'Phone layout: pick 1080x1920 (9:16) so your stream fills the whole phone screen. Use 720x1280 or 30 fps on slower PCs.' }),
      row('Base (Canvas) Resolution', baseSel), row('Output (Scaled) Resolution', outSel), row('Downscale Filter', filt), row('Common FPS Values', fps)
    ];
    collect.push(() => {
      const [bw, bh] = baseSel.value.split('x').map(Number);
      const [ow, oh] = outSel.value.split('x').map(Number);
      return { video: { baseW: bw, baseH: bh, outW: ow, outH: oh, filter: filt.value, fps: Number(fps.value) } };
    });

    // Hotkeys
    const actions = [['startStream', 'Start Streaming'], ['stopStream', 'Stop Streaming'], ['startRec', 'Start Recording'], ['stopRec', 'Stop Recording'], ['transition', 'Transition (Studio Mode)'], ['muteMic', 'Mute / unmute Mic/Aux']]
      .concat(state.scenes.map((n) => ['scene:' + n, 'Switch to scene: ' + n]));
    const hk = Object.assign({}, s.hotkeys || {});
    const filter = el('input', { type: 'text', placeholder: 'Filter', 'aria-label': 'Filter hotkeys' });
    const hkRows = actions.map(([id, label]) => {
      const input = el('input', { type: 'text', readonly: true, class: 'hk', value: hk[id] || '', placeholder: 'Click, then press keys', 'aria-label': label + ' hotkey' });
      input.addEventListener('keydown', (e) => {
        e.preventDefault();
        if (e.key === 'Backspace' || e.key === 'Escape') { if (e.key === 'Backspace') { input.value = ''; hk[id] = ''; } return; }
        const acc2 = acceleratorFrom(e);
        if (acc2) { input.value = acc2; hk[id] = acc2; }
      });
      const clear = el('button', { class: 'btn', type: 'button', text: 'Clear', onClick: () => { input.value = ''; hk[id] = ''; } });
      const r = el('div', { class: 'frow' }, el('span', { text: label }), el('div', { class: 'file-row' }, input, clear));
      r.dataset.label = label.toLowerCase();
      return r;
    });
    filter.addEventListener('input', () => { const q = filter.value.toLowerCase(); hkRows.forEach((r) => r.classList.toggle('hidden', !!q && !r.dataset.label.includes(q))); });
    pages.Hotkeys = [filter, el('p', { class: 'muted small', text: 'Hotkeys work even while a game has focus. Backspace clears one.' })].concat(hkRows);

    // Accessibility
    const selC = el('input', { type: 'color', value: acc.selColor });
    const hovC = el('input', { type: 'color', value: acc.hoverColor });
    pages.Accessibility = [grp('Color Options', row('Selected Source', selC), row('Hovered Source', hovC))];
    collect.push(() => ({ access: { selColor: selC.value, hoverColor: hovC.value } }));

    // Advanced
    const pri = sel([['High', 'High'], ['AboveNormal', 'Above Normal'], ['Normal', 'Normal']], adv.priority);
    const cs = sel([['709', 'Rec. 709'], ['601', 'Rec. 601'], ['sRGB', 'sRGB']], adv.colorSpace);
    const cr = sel([['Partial', 'Limited'], ['Full', 'Full']], adv.colorRange);
    const dyn = cb('Dynamically change bitrate to manage congestion', adv.dynamicBitrate);
    const net = cb('Enable network optimizations', adv.netOptimize);
    pages.Advanced = [
      grp('General', row('Process Priority', pri)),
      grp('Video', row('Renderer', sel([['d3d11', 'Direct3D 11']], 'd3d11')), row('Color Format', sel([['NV12', 'NV12 (8-bit, 4:2:0, 2 planes)']], 'NV12')), row('Color Space', cs), row('Color Range', cr)),
      grp('Network', dyn.node, net.node)
    ];
    collect.push(() => ({ advanced: { priority: pri.value, colorSpace: cs.value, colorRange: cr.value, dynamicBitrate: dyn.input.checked, netOptimize: net.input.checked } }));

    // Layout: sidebar + page
    const nav = el('nav', { class: 'set-nav', 'aria-label': 'Settings categories' });
    const page = el('div', { class: 'set-page' });
    const showCat = (c) => {
      page.replaceChildren(...pages[c]);
      nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.cat === c));
    };
    for (const c of CATS) nav.append(el('button', { type: 'button', 'data-cat': c, text: c, onClick: () => showCat(c) }));

    const apply = async () => {
      if (server.value.trim() || key.value.trim()) await window.tonix.saveDestination({ platform: plat.value, server: server.value.trim(), key: key.value.trim() });
      const patch = Object.assign({}, ...collect.map((f) => f()));
      const engineKeys = ['video', 'output', 'audio', 'advanced'];
      const engineChanged = engineKeys.some((k) => JSON.stringify(Object.assign({}, s[k], patch[k])) !== JSON.stringify(s[k]));
      state.settings = await window.tonix.saveSettings(patch);
      const failed = await window.tonix.saveHotkeys(hk);
      for (const f of devChanges) await f();
      setPerf(!!state.settings.general.perf, false);
      applyLook();
      renderDest();
      if (failed && failed.length) notice('Some hotkeys are taken', 'These keys are already used by another app: ' + failed.join(', '));
      if (engineChanged) {
        if (state.live || state.rec) notice('Settings saved', 'Video and output changes apply after you stop streaming and recording.');
        else await restartEngine('Applying settings…');
      }
      Object.assign(s, JSON.parse(JSON.stringify(state.settings)));
    };

    openModal('Settings', el('div', { class: 'settings' }, nav, page), [
      { label: 'OK', kind: 'primary', run: async () => { await apply(); } },
      { label: 'Cancel' },
      { label: 'Apply', run: async () => { await apply(); return true; } }
    ]);
    $('modalBox').classList.add('wide');
    showCat(CATS.includes(startCat) ? startCat : 'General');
  }

  async function restartEngine(msg) {
    overlay(msg || 'Restarting the engine…');
    state.connected = false;
    try { await obs.disconnect(); } catch { /* ignore */ }
    state.info = await window.tonix.restartEngine();
    connectLoop();
  }

  async function applySettings(patch) {
    state.settings = await window.tonix.saveSettings(patch);
    if (state.live) return;
    await restartEngine('Applying settings…');
  }

  // ---------- performance mode ----------
  function setPerf(on, save) {
    state.perf = on;
    $('perfBtn').setAttribute('aria-pressed', String(on));
    if (save) saveSection('general', { perf: on });
  }
  $('perfBtn').addEventListener('click', () => setPerf(!state.perf, true));

  // ---------- global hotkeys ----------
  window.tonix.onHotkey(async (action) => {
    if (!state.connected) return;
    try {
      if (action === 'startStream' && !state.live) startStreaming(true);
      else if (action === 'stopStream' && state.live) call('StopStream');
      else if (action === 'startRec' && !state.rec) toggleRec(true);
      else if (action === 'stopRec' && state.rec) toggleRec(false);
      else if (action === 'transition' && state.studio) take();
      else if (action === 'muteMic') { const sp = await call('GetSpecialInputs'); if (sp.mic1) call('ToggleInputMute', { inputName: sp.mic1 }); }
      else if (action.startsWith('scene:')) selectScene(action.slice(6));
    } catch (e) { console.warn(e); }
  });

  // ---------- loops ----------
  let loopsStarted = false;
  function startLoops() {
    if (loopsStarted) return;
    loopsStarted = true;
    previewLoop();
    statsLoop();
  }

  async function shot(sceneName, width) {
    const r = await call('GetSourceScreenshot', { sourceName: sceneName, imageFormat: 'jpg', imageWidth: width, imageCompressionQuality: 70 });
    return r.imageData;
  }

  async function previewLoop() {
    if (state.connected && !document.hidden) {
      try {
        const w = state.perf ? 640 : 1280;
        const scene = editScene();
        if (scene) $('editImg').src = await shot(scene, w);
        if (state.studio && state.pgm && (!state.perf || state.tick % 2 === 0)) $('pgmImg').src = await shot(state.pgm, state.perf ? 480 : 960);
      } catch { /* scene may be mid-change */ }
      state.tick++;
    }
    setTimeout(previewLoop, state.perf ? 400 : (state.drag ? 60 : 100));
  }

  function mark(id, level) {
    const n = $(id);
    n.classList.toggle('warn', level === 1);
    n.classList.toggle('bad', level === 2);
  }

  async function statsLoop() {
    if (state.connected) {
      try {
        const s = await call('GetStats');
        $('statCpu').textContent = s.cpuUsage.toFixed(1) + '%';
        $('statFps').textContent = s.activeFps.toFixed(2);
        if (state.lagBase == null) state.lagBase = s.renderSkippedFrames;
        const lag = s.renderSkippedFrames - state.lagBase;
        const newLag = lag - state.lastLag;
        state.lastLag = lag;
        $('statLag').textContent = lag;
        mark('stLag', newLag > 10 ? 2 : newLag > 0 ? 1 : 0);
        let health = '';
        if (newLag > 10) health = 'Your PC is struggling to keep up. Turn on Performance Mode or pick Performance quality in Settings › Output.';
        if (state.live) {
          const st = await call('GetStreamStatus');
          $('liveStatus').textContent = '● LIVE: ' + (st.outputTimecode || '00:00:00').slice(0, 8);
          $('statDrop').textContent = `${st.outputSkippedFrames} (${st.outputTotalFrames ? ((st.outputSkippedFrames / st.outputTotalFrames) * 100).toFixed(1) : '0.0'}%)`;
          const now = Date.now();
          if (state.lastBytes && now > state.lastBytesAt) $('statRate').textContent = Math.max(0, Math.round(((st.outputBytes - state.lastBytes) * 8) / (now - state.lastBytesAt)));
          state.lastBytes = st.outputBytes;
          state.lastBytesAt = now;
          const cong = st.outputCongestion || 0;
          mark('stDrop', st.outputSkippedFrames > 0 ? 1 : 0);
          mark('stRate', cong > 0.5 ? 2 : cong > 0.15 ? 1 : 0);
          if (cong > 0.5) health = 'Your internet upload is struggling. Lower the bitrate in Settings › Output.';
        } else {
          $('statDrop').textContent = s.outputSkippedFrames;
        }
        if (state.rec) {
          try { const r = await call('GetRecordStatus'); $('recStatus').textContent = '● REC: ' + (r.outputTimecode || '00:00:00').slice(0, 8); } catch { /* ignore */ }
        }
        if (health || !/^Recording saved/.test($('healthBar').textContent)) {
          $('healthBar').textContent = health;
          $('healthBar').classList.toggle('hidden', !health);
        }
        if (!state.drag) refreshItems().catch(() => {});
      } catch { /* ignore */ }
    }
    setTimeout(statsLoop, 2000);
  }

  overlay('Starting the engine…');
  connectLoop();
})();
