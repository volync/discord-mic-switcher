/*!
 * Mic Switcher for Discord  v1.2.5
 * Copyright (c) 2026 volync. All rights reserved.
 *
 * SOURCE-AVAILABLE, NOT OPEN SOURCE. Personal, non-commercial use only.
 * Redistribution, resale, rebranding, publishing modified versions and removing
 * this notice or the "made by volync" credit are prohibited without written
 * permission. Full terms: LICENSE file, or
 * https://github.com/volync/discord-mic-switcher/blob/main/LICENSE
 * Official source: https://github.com/volync/discord-mic-switcher
 * Unofficial project - not affiliated with or endorsed by Discord Inc.
 *
 * SPDX-License-Identifier: LicenseRef-MicSwitcher-SAL-1.0
 * -------------------------------------------------------------
 * Paste this whole file into Discord's DevTools console
 * (Ctrl+Shift+I -> Console) and press Enter.
 *
 * How it switches the mic (verified against Discord build web.f25377cf5b911919):
 *   - Reads devices from Discord's internal MediaEngineStore
 *     (getInputDevices / getInputDeviceId).
 *   - Switches with Discord's own AudioActionCreators.setInputDevice(id),
 *     which dispatches AUDIO_SET_INPUT_DEVICE. MediaEngineStore then saves the
 *     setting and hot-swaps the device on every active voice connection
 *     (no reconnect). Fallback: dispatch AUDIO_SET_INPUT_DEVICE directly.
 *   - After every switch it reads the device back from the store, so the UI
 *     always shows what Discord is REALLY using.
 *   - Optional global hotkeys use Discord's native keybind API
 *     (discord_utils.inputEventRegister), the same one push-to-talk uses.
 *
 * Re-pasting is safe: the previous instance is destroyed first.
 * Console API: MicSwitcher.toggle(), MicSwitcher.switchTo(0|1),
 *              MicSwitcher.show(), MicSwitcher.diagnose(), MicSwitcher.destroy()
 */
(() => {
  'use strict';

  // Set by the autostart loader (install-autostart.ps1): Discord's modules load a
  // few seconds after the page, so wait for them instead of failing immediately.
  const AUTOLOAD = window.__MIC_SWITCHER_AUTOLOAD__ === true;
  const retryable = (msg) => Object.assign(new Error(msg), { retryable: true });

  function main() {
    if (!document.body) throw retryable('document.body not ready');
    const VERSION = '1.2.5';
    const STORE_KEY = 'micSwitcher.settings.v1';
    const ACCENTS = ['#5865F2', '#23A55A'];        // Mic 1 = blurple, Mic 2 = green
    const ACTIONS = ['slot0', 'slot1', 'toggle'];  // hotkey actions
    const ACTION_LABEL = { slot0: 'Mic 1', slot1: 'Mic 2', toggle: 'Toggle' };
    const NATIVE_ID_BASE = 4960000;                 // ids for native keybinds (far above Discord's own)

    try { window.__micSwitcher?.destroy?.(); } catch (_) { /* old instance already gone */ }

    const log = (...a) => console.log('%c[MicSwitcher]', 'color:#5865F2;font-weight:700', ...a);
    const warn = (...a) => console.warn('[MicSwitcher]', ...a);
    const isFn = (f) => typeof f === 'function';
    const cleanups = [];   // run on destroy()

    /* =========================================================
     * 1. Discord internals (webpack module cache)
     * ======================================================= */
    // Discord loads SEVERAL webpack runtimes (fast-connect, sentry, web) that share
    // the one webpackChunkdiscord_app array. Each wraps push(), so this callback is
    // called once per runtime. Keep every require and search the biggest first
    // (the main "web" runtime holds the stores).
    const moduleCount = (r) => { try { return Object.keys(r.c || {}).length; } catch (_) { return 0; } };
    function getWebpackRequires() {
      const chunk = window.webpackChunkdiscord_app;
      if (!chunk || !isFn(chunk.push)) {
        throw retryable('webpackChunkdiscord_app not found. Run this in the Discord client console (top frame, not an iframe).');
      }
      const reqs = [];
      const ret = chunk.push([[Symbol('micsw')], {}, (r) => { if (r && !reqs.includes(r)) reqs.push(r); return r; }]);
      chunk.pop();
      if (ret && isFn(ret) && !reqs.includes(ret)) reqs.push(ret);
      const list = reqs.filter((r) => r && r.c).sort((a, b) => moduleCount(b) - moduleCount(a));
      if (!list.length) throw retryable('Could not access the webpack module cache.');
      return list;
    }

    // Match on method names, not on minified export names (Z / ZP / A / Ay /
    // default ...), which change between builds.
    function looksLike(v, pred) {
      if (!v || (typeof v !== 'object' && !isFn(v)) || v === window || v === document) return false;
      try {
        if (isFn(v.__micsw_probe_that_never_exists__)) return false; // reject catch-all Proxies
        return !!pred(v);
      } catch (_) { return false; }
    }
    function scanExports(exp, pred) {
      if (!exp) return null;
      if (looksLike(exp, pred)) return exp;
      let keys;
      try { keys = Object.keys(exp); } catch (_) { return null; }
      for (const k of keys) {
        let v;
        try { v = exp[k]; } catch (_) { continue; }
        if (looksLike(v, pred)) return v;
      }
      return null;
    }
    // 1) scan loaded modules of every runtime; 2) fallback: find the module by a
    //    string in its source code and require it directly.
    function findExport(reqs, pred, sourceMarker) {
      for (const wp of reqs) {
        for (const id in wp.c) {
          let exp;
          try { exp = wp.c[id] && wp.c[id].exports; } catch (_) { continue; }
          const hit = scanExports(exp, pred);
          if (hit) return hit;
        }
      }
      if (!sourceMarker) return null;
      for (const wp of reqs) {
        if (!wp.m) continue;
        for (const id in wp.m) {
          let src = '';
          try { src = Function.prototype.toString.call(wp.m[id]); } catch (_) { continue; }
          if (!src.includes(sourceMarker)) continue;
          let exp;
          try { exp = wp(id); } catch (_) { continue; }
          const hit = scanExports(exp, pred);
          if (hit) return hit;
        }
      }
      return null;
    }

    const reqs = getWebpackRequires();
    const isStore = (m) => isFn(m.getInputDeviceId) && isFn(m.getInputDevices) && isFn(m.getOutputDevices) && isFn(m.addChangeListener);
    const isActions = (m) => isFn(m.setInputDevice) && isFn(m.setOutputDevice) && isFn(m.toggleSelfMute);
    const isDispatcher = (m) => isFn(m.dispatch) && isFn(m.subscribe) && isFn(m.flushWaitQueue);

    // At autostart, never force-load Discord modules early (could disturb its boot
    // order): only use modules Discord already loaded, and retry until they exist.
    const marker = (m) => (AUTOLOAD ? undefined : m);
    const MediaEngineStore = findExport(reqs, isStore, marker('displayName="MediaEngineStore"'));
    let AudioActions = findExport(reqs, isActions, marker('"AudioActionCreators"'));
    const Dispatcher = (MediaEngineStore && looksLike(MediaEngineStore._dispatcher, isDispatcher))
      ? MediaEngineStore._dispatcher             // every Flux store keeps a reference to the dispatcher
      : findExport(reqs, isDispatcher);

    if (!MediaEngineStore) {
      throw retryable('[MicSwitcher] MediaEngineStore not found - Discord internals changed. Nothing was installed. ' +
        `(webpack runtimes: ${reqs.length}, modules: ${reqs.map(moduleCount).join(' / ')})`);
    }
    if (!AudioActions && !Dispatcher) {
      throw retryable('[MicSwitcher] Neither AudioActionCreators nor FluxDispatcher found - cannot switch devices. Nothing was installed.');
    }

    /* =========================================================
     * 2. Persistent storage
     *    Discord hides window.localStorage from page scripts, so fall back to a
     *    hidden iframe's localStorage (same origin -> same storage).
     * ======================================================= */
    const storage = (() => {
      let ls = null;
      try { ls = window.localStorage; ls.getItem('__micsw'); } catch (_) { ls = null; }
      if (!ls) {
        try {
          const frame = document.createElement('iframe');
          frame.style.display = 'none';
          frame.setAttribute('aria-hidden', 'true');
          document.body.appendChild(frame);
          ls = frame.contentWindow.localStorage;
          ls.getItem('__micsw');
          cleanups.push(() => frame.remove());
        } catch (_) { ls = null; }
      }
      if (!ls) warn('localStorage unavailable - settings will only last until reload.');
      const mem = {};
      return {
        persistent: !!ls,
        get(k) { try { return ls ? ls.getItem(k) : (mem[k] ?? null); } catch (_) { return null; } },
        set(k, v) { try { ls ? ls.setItem(k, v) : (mem[k] = v); } catch (e) { warn('save failed', e); } },
      };
    })();

    const DEFAULTS = {
      enabled: true,
      slots: [{ id: null, name: '' }, { id: null, name: '' }],
      hotkeys: { slot0: null, slot1: null, toggle: null },
      global: false,     // native hotkeys that also work when Discord is not focused
      sound: true,       // play Discord's switch "ding" (uses the official action creator)
      collapsed: false,
      dock: true,        // live in Discord's title bar (next to inbox / help) instead of floating
      pos: null,         // {x, y}  (floating mode only)
    };

    function loadSettings() {
      let saved = {};
      try { saved = JSON.parse(storage.get(STORE_KEY) || '{}') || {}; } catch (_) { saved = {}; }
      const s = { ...DEFAULTS, ...saved };
      s.slots = [0, 1].map((i) => ({ ...DEFAULTS.slots[i], ...((saved.slots || [])[i] || {}) }));
      s.hotkeys = { ...DEFAULTS.hotkeys, ...(saved.hotkeys || {}) };
      return s;
    }
    const S = loadSettings();
    const save = () => storage.set(STORE_KEY, JSON.stringify(S));

    /* =========================================================
     * 3. Devices & switching
     * ======================================================= */
    function listDevices() {
      let raw = {};
      try { raw = MediaEngineStore.getInputDevices() || {}; } catch (_) { raw = {}; }
      return Object.entries(raw)
        .map(([key, d]) => ({
          id: String(d && d.id != null ? d.id : key),
          name: String((d && d.name) || key),
          disabled: !!(d && d.disabled),
          index: d && typeof d.index === 'number' ? d.index : 0,
        }))
        .sort((a, b) => a.index - b.index);
    }

    function currentDeviceId() {
      try { return MediaEngineStore.getInputDeviceId(); } catch (_) { return null; }
    }

    // Find the live device for a slot: exact id first, then same name
    // (handles re-plugged USB mics that came back with a new id).
    function resolveSlot(i) {
      const slot = S.slots[i];
      if (!slot || !slot.id) return null;
      const devs = listDevices();
      return devs.find((d) => d.id === slot.id) || (slot.name && devs.find((d) => d.name === slot.name)) || null;
    }

    function activeSlot() {
      const cur = currentDeviceId();
      for (const i of [0, 1]) {
        const d = resolveSlot(i);
        if (d && d.id === cur) return i;
      }
      return -1;
    }

    function deviceName(id) {
      const d = listDevices().find((x) => x.id === id);
      return d ? d.name : (id || 'none');
    }

    function applyDevice(id) {
      const before = currentDeviceId();
      let via = '';
      if (S.sound && !AudioActions) AudioActions = findExport(reqs, isActions); // may load after us at autostart
      if (S.sound && AudioActions) {
        AudioActions.setInputDevice(id);            // official path (plays Discord's confirmation sound)
        via = 'AudioActionCreators.setInputDevice';
      }
      if (currentDeviceId() !== id && Dispatcher) {  // silent mode, or the action creator ignored us
        Dispatcher.dispatch({ type: 'AUDIO_SET_INPUT_DEVICE', id, oldId: before });
        via = 'Dispatcher(AUDIO_SET_INPUT_DEVICE)';
      }
      return { ok: currentDeviceId() === id, via };
    }

    function switchTo(i, source = 'manual') {
      const n = i + 1;
      const slot = S.slots[i];
      if (!slot || !slot.id) { toast(`Mic ${n} is not selected yet`, 'warn'); return false; }
      const dev = resolveSlot(i);
      if (!dev) { toast(`Mic ${n} "${slot.name || slot.id}" is disconnected`, 'err'); render(); return false; }
      if (dev.id !== slot.id || dev.name !== slot.name) { slot.id = dev.id; slot.name = dev.name; save(); }
      if (currentDeviceId() === dev.id) { toast(`Mic ${n} already active: ${dev.name}`, 'info', i); return true; }
      let res;
      try { res = applyDevice(dev.id); } catch (e) { warn('switch failed', e); res = { ok: false, via: String(e) }; }
      if (res.ok) {
        toast(`Mic ${n}: ${dev.name}`, 'ok', i);
        log(`Switched to Mic ${n} "${dev.name}" via ${res.via} (${source})`);
      } else {
        toast(`Discord did not accept Mic ${n}. Still on: ${deviceName(currentDeviceId())}`, 'err');
        warn('Switch not applied. Wanted', dev, 'Discord reports', currentDeviceId());
      }
      render();
      return res.ok;
    }

    function toggleMic(source = 'manual') {
      const a = activeSlot();
      return switchTo(a === 0 ? 1 : a === 1 ? 0 : (S.slots[0].id ? 0 : 1), source);
    }

    /* =========================================================
     * 4. Hotkeys
     *    combo = { code, vk, ctrl, alt, shift, meta, modVk:[...], label }
     *    `code` (KeyboardEvent.code) is layout-independent, so binds work the
     *    same on EN / RU layouts. `vk`/`modVk` are Windows virtual-key codes
     *    for the native (global) keybind API.
     * ======================================================= */
    const MODS = {
      ControlLeft: ['ctrl', 162], ControlRight: ['ctrl', 163],
      ShiftLeft: ['shift', 160], ShiftRight: ['shift', 161],
      AltLeft: ['alt', 164], AltRight: ['alt', 165],
      MetaLeft: ['meta', 91], MetaRight: ['meta', 92],
    };
    const LEFT_VK = { ctrl: 162, shift: 160, alt: 164, meta: 91 };
    const VK = {
      Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39,
      ArrowDown: 40, PrintScreen: 44, Insert: 45, Delete: 46, Pause: 19, ScrollLock: 145, CapsLock: 20,
      NumLock: 144, ContextMenu: 93, Backquote: 192, Minus: 189, Equal: 187, BracketLeft: 219,
      BracketRight: 221, Backslash: 220, Semicolon: 186, Quote: 222, Comma: 188, Period: 190, Slash: 191,
      NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110, NumpadDivide: 111,
      NumpadEnter: 13, Enter: 13, Tab: 9, Backspace: 8, Escape: 27,
      MediaPlayPause: 179, MediaTrackNext: 176, MediaTrackPrevious: 177, MediaStop: 178,
      AudioVolumeMute: 173, AudioVolumeDown: 174, AudioVolumeUp: 175,
    };
    const ARROWS = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };

    function codeToVk(code, keyCode) {
      let m;
      if ((m = /^Key([A-Z])$/.exec(code))) return m[1].charCodeAt(0);
      if ((m = /^Digit(\d)$/.exec(code))) return 48 + +m[1];
      if ((m = /^Numpad(\d)$/.exec(code))) return 96 + +m[1];
      if ((m = /^F(\d{1,2})$/.exec(code))) return 111 + +m[1];
      return VK[code] || keyCode || 0;
    }

    function codeLabel(code) {
      let m;
      if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
      if ((m = /^Digit(\d)$/.exec(code))) return m[1];
      if ((m = /^Numpad(.+)$/.exec(code))) {
        const t = { Multiply: '*', Add: '+', Subtract: '-', Decimal: '.', Divide: '/', Enter: 'Enter' }[m[1]] || m[1];
        return 'Num ' + t;
      }
      return ARROWS[code] || { Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
        Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/' }[code] || code;
    }

    function makeCombo(e, heldMods) {
      const combo = { code: e.code, vk: codeToVk(e.code, e.keyCode),
        ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, modVk: [] };
      for (const mod of ['ctrl', 'alt', 'shift', 'meta']) {
        if (!combo[mod]) continue;
        const held = Object.keys(MODS).find((c) => heldMods.has(c) && MODS[c][0] === mod);
        combo.modVk.push(held ? MODS[held][1] : LEFT_VK[mod]);
      }
      combo.label = [combo.ctrl && 'Ctrl', combo.alt && 'Alt', combo.shift && 'Shift', combo.meta && 'Win',
        codeLabel(combo.code)].filter(Boolean).join('+');
      return combo;
    }

    const sameCombo = (a, b) => !!a && !!b && a.code === b.code && a.ctrl === b.ctrl &&
      a.alt === b.alt && a.shift === b.shift && a.meta === b.meta;
    const eventMatches = (e, c) => !!c && e.code === c.code && e.ctrlKey === c.ctrl &&
      e.altKey === c.alt && e.shiftKey === c.shift && e.metaKey === c.meta;

    // Plain printable keys (no Ctrl/Alt/Win) must not fire while typing a message.
    const isPrintable = (c) => !c.ctrl && !c.alt && !c.meta &&
      /^(Key[A-Z]|Digit\d|Numpad\d|Numpad(Add|Subtract|Multiply|Divide|Decimal)|Space|Backquote|Minus|Equal|Bracket(Left|Right)|Backslash|Semicolon|Quote|Comma|Period|Slash)$/.test(c.code);
    function isEditable(el) {
      if (!el) return false;
      return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ||
        !!(el.closest && el.closest('[contenteditable="true"],[role="textbox"]'));
    }

    const BLOCKED = new Set(['Escape', 'Tab', 'Enter', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A', 'Ctrl+Z', 'Ctrl+Y']);
    const DISCORD_SHORTCUTS = new Set(['Ctrl+K', 'Ctrl+Shift+M', 'Ctrl+Shift+D', 'Ctrl+/', 'Ctrl+Shift+I',
      'Ctrl+R', 'Ctrl+Shift+R', 'Ctrl+F', 'Ctrl+E', 'Ctrl+G', 'Ctrl+S', 'Ctrl+B', 'Ctrl+I', 'Ctrl+U',
      'Ctrl+Shift+U', 'Ctrl+Shift+N', 'Ctrl+Shift+T', 'Ctrl+Shift+A', 'Ctrl+Shift+H', 'Ctrl+P', 'Ctrl+[',
      'Ctrl+]', 'Ctrl+Enter', 'Ctrl+=', 'Ctrl+-', 'Ctrl+0', 'Alt+↑', 'Alt+↓', 'Ctrl+Alt+↑', 'Ctrl+Alt+↓',
      'Alt+Shift+↑', 'Alt+Shift+↓', 'Shift+PageUp', 'Shift+PageDown', 'Ctrl+Shift+Alt+↑', 'Ctrl+Shift+Alt+↓']);

    // Returns { error } (bind refused) or { warning } / {} (bind allowed).
    function checkCombo(action, combo) {
      if (BLOCKED.has(combo.label)) return { error: `${combo.label} is reserved - pick another key` };
      for (const other of ACTIONS) {
        if (other !== action && sameCombo(S.hotkeys[other], combo)) {
          return { error: `${combo.label} is already used by ${ACTION_LABEL[other]}` };
        }
      }
      if (DISCORD_SHORTCUTS.has(combo.label)) return { warning: `${combo.label} overrides a Discord shortcut while focused` };
      if (isPrintable(combo)) return { warning: `${combo.label} is ignored while typing in a text box` };
      return {};
    }

    /* ---- firing (dedupes in-app + native events for one press) ---- */
    const lastFire = {};
    function fire(action, source) {
      if (!S.enabled) return;
      const now = performance.now();
      if (now - (lastFire[action] ?? -Infinity) < 250) return;   // one press can arrive via DOM + native hook
      lastFire[action] = now;
      if (action === 'toggle') toggleMic(source); else switchTo(action === 'slot0' ? 0 : 1, source);
    }

    /* ---- in-app listener (window, capture phase -> runs before Discord) ---- */
    let recording = null; // { action, held:Set }
    function onKeyDown(e) {
      if (recording || !S.enabled || e.repeat) return;
      const action = ACTIONS.find((a) => eventMatches(e, S.hotkeys[a]));
      if (!action) return;
      if (isPrintable(S.hotkeys[action]) && (isEditable(e.target) || isEditable(document.activeElement))) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      fire(action, 'hotkey');
    }
    window.addEventListener('keydown', onKeyDown, true);
    cleanups.push(() => window.removeEventListener('keydown', onKeyDown, true));

    /* ---- hotkey recorder ---- */
    function startRecording(action) {
      stopRecording();
      unregisterGlobal();                 // so the native hook doesn't fire while binding
      recording = { action, held: new Set() };
      render();
    }
    function stopRecording() {
      if (!recording) return;
      recording = null;
      registerGlobal();
      render();
    }
    function onRecordKey(e) {
      if (!recording) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'keyup') { recording.held.delete(e.code); return; }
      if (MODS[e.code]) { recording.held.add(e.code); return; }  // wait for the real key
      if (e.repeat) return;
      const action = recording.action;
      if (e.code === 'Escape') { stopRecording(); return; }
      if ((e.code === 'Backspace' || e.code === 'Delete') && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        S.hotkeys[action] = null; save(); stopRecording(); toast(`${ACTION_LABEL[action]} hotkey cleared`, 'info'); return;
      }
      const combo = makeCombo(e, recording.held);
      const check = checkCombo(action, combo);
      if (check.error) { toast(check.error, 'err'); return; }   // keep recording, let user try again
      S.hotkeys[action] = combo;
      save();
      stopRecording();
      toast(check.warning || `${ACTION_LABEL[action]} -> ${combo.label}`, check.warning ? 'warn' : 'ok');
    }
    window.addEventListener('keydown', onRecordKey, true);
    window.addEventListener('keyup', onRecordKey, true);
    const onBlurStopRec = () => stopRecording();
    window.addEventListener('blur', onBlurStopRec);
    cleanups.push(() => {
      window.removeEventListener('keydown', onRecordKey, true);
      window.removeEventListener('keyup', onRecordKey, true);
      window.removeEventListener('blur', onBlurStopRec);
    });

    /* ---- global hotkeys via Discord's native keybind API (desktop app only) ---- */
    let nativeIds = [];
    let globalStatus = '';
    function nativeUtils() {
      try { return window.DiscordNative?.nativeModules?.requireModule?.('discord_utils') || null; } catch (_) { return null; }
    }
    function unregisterGlobal() {
      const u = nativeIds.length ? nativeUtils() : null;
      for (const id of nativeIds) { try { u && u.inputEventUnregister(id); } catch (_) { /* already gone */ } }
      nativeIds = [];
    }
    function registerGlobal() {
      unregisterGlobal();
      globalStatus = '';
      if (!S.enabled || !S.global) return;
      const u = nativeUtils();
      if (!u || !isFn(u.inputEventRegister)) {
        globalStatus = 'Native keybind API not available (browser Discord?) - in-app hotkeys only.';
        return;
      }
      const failed = [];
      ACTIONS.forEach((action, i) => {
        const c = S.hotkeys[action];
        if (!c || !c.vk) return;
        const id = NATIVE_ID_BASE + i;
        const buttons = [...(c.modVk || []).map((vk) => [0, vk]), [0, c.vk]];
        const cb = (isDown) => {
          if (isDown === false) return;
          if (isPrintable(c) && document.hasFocus() && isEditable(document.activeElement)) return;
          fire(action, 'global');
        };
        try {
          u.inputEventRegister(id, buttons, cb, { focused: true, blurred: true, keydown: true, keyup: false });
          nativeIds.push(id);
        } catch (e) {
          failed.push(`${ACTION_LABEL[action]} (${c.label})`);
          warn('native keybind failed', action, e);
        }
      });
      if (failed.length) globalStatus = 'Global bind failed: ' + failed.join(', ');
    }
    cleanups.push(unregisterGlobal);

    /* =========================================================
     * 5. Styles
     * ======================================================= */
    const CSS = `
  #msw-root{position:fixed;z-index:100000;top:72px;right:24px;font-family:var(--font-primary,'gg sans','Noto Sans','Segoe UI',sans-serif);
    color:#dbdee1;font-size:13px;line-height:1.3;user-select:none;-webkit-user-select:none;color-scheme:dark;
    pointer-events:auto;-webkit-app-region:no-drag}
  #msw-root *{box-sizing:border-box;-webkit-app-region:no-drag}
  .msw-panel{width:318px;background:rgba(17,18,21,.62);backdrop-filter:blur(22px) saturate(150%);border:1px solid rgba(255,255,255,.09);
    border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.05);overflow:hidden}
  .msw-head{display:flex;align-items:center;gap:8px;padding:10px 10px 10px 12px;cursor:grab;border-bottom:1px solid rgba(255,255,255,.06)}
  .msw-head:active{cursor:grabbing}
  #msw-root.msw-docked .msw-head{cursor:default}
  .msw-titlebox{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
  .msw-title{font-weight:700;font-size:14px;color:#f2f3f5;white-space:nowrap}
  .msw-title small{font-weight:600;font-size:11px;color:#80848e;margin-left:6px}
  .msw-credit{font-size:9.5px;font-weight:500;line-height:1;letter-spacing:.03em;color:rgba(255,255,255,.2)}
  .msw-icon{width:18px;height:18px;flex:none;color:#5865F2}
  .msw-switch{position:relative;width:34px;height:20px;border-radius:10px;background:#4e5058;border:0;cursor:pointer;transition:background .15s;flex:none}
  .msw-switch::after{content:'';position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s}
  .msw-switch.on{background:#23A55A}.msw-switch.on::after{transform:translateX(14px)}
  .msw-iconbtn{width:24px;height:24px;border-radius:6px;border:0;background:transparent;color:#b5bac1;cursor:pointer;font-size:16px;line-height:1;flex:none}
  .msw-iconbtn:hover{background:rgba(255,255,255,.08);color:#fff}
  .msw-body{padding:10px;display:flex;flex-direction:column;gap:8px}
  .msw-body.off .msw-slot,.msw-body.off .msw-row{opacity:.45}
  .msw-slot{position:relative;border-radius:10px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.06);
    border-left:3px solid var(--acc);padding:9px 10px;display:flex;flex-direction:column;gap:7px;transition:background .15s,box-shadow .15s}
  .msw-slot.active{background:color-mix(in srgb,var(--acc) 13%,rgba(255,255,255,.03));box-shadow:0 0 0 1px color-mix(in srgb,var(--acc) 45%,transparent)}
  .msw-slot-top{display:flex;align-items:center;gap:8px}
  .msw-slot-name{font-weight:800;font-size:11px;letter-spacing:.06em;color:var(--acc)}
  .msw-badge{display:none;align-items:center;gap:5px;font-size:10px;font-weight:800;letter-spacing:.05em;color:#fff;
    background:var(--acc);padding:2px 7px;border-radius:999px}
  .msw-slot.active .msw-badge{display:inline-flex}
  .msw-badge i{width:6px;height:6px;border-radius:50%;background:#fff;animation:msw-pulse 1.6s infinite}
  @keyframes msw-pulse{50%{opacity:.35}}
  .msw-warn{font-size:11px;color:#f0b232;font-weight:600}
  .msw-select{width:100%;height:32px;border-radius:7px;background:rgba(0,0,0,.3);color:#dbdee1;border:1px solid rgba(255,255,255,.08);
    padding:0 8px;font:inherit;outline:none;cursor:pointer}
  .msw-select:focus{border-color:var(--acc,#5865F2)}
  .msw-select option{background:#1e1f22;color:#dbdee1}
  .msw-line{display:flex;gap:6px;align-items:center}
  .msw-key{flex:1;height:30px;display:flex;align-items:center;gap:6px;padding:0 6px 0 9px;border-radius:7px;background:rgba(0,0,0,.3);
    border:1px dashed rgba(255,255,255,.14);color:#b5bac1;cursor:pointer;font:inherit;font-size:12px;min-width:0}
  .msw-key:hover{border-color:rgba(255,255,255,.3);color:#fff}
  .msw-key b{color:#f2f3f5;font-family:Consolas,'Cascadia Mono',monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .msw-key .msw-kicon{opacity:.7}
  .msw-key .msw-x{margin-left:auto;padding:0 4px;border-radius:4px;color:#80848e}
  .msw-key .msw-x:hover{background:rgba(255,255,255,.1);color:#fff}
  .msw-key.rec{border-style:solid;border-color:#f0b232;color:#f0b232;animation:msw-rec 1s infinite}
  @keyframes msw-rec{50%{box-shadow:0 0 0 3px rgba(240,178,50,.18)}}
  .msw-btn{height:30px;padding:0 12px;border-radius:7px;border:0;font:inherit;font-weight:700;font-size:12px;cursor:pointer;
    color:#fff;background:var(--acc,#5865F2);flex:none;transition:filter .12s}
  .msw-btn:hover{filter:brightness(1.12)}.msw-btn:disabled{opacity:.4;cursor:default;filter:none}
  .msw-btn.ghost{background:rgba(255,255,255,.07);color:#dbdee1}
  .msw-row{display:flex;align-items:center;gap:6px}
  .msw-row .msw-lbl{font-size:11px;font-weight:700;letter-spacing:.04em;color:#949ba4;width:58px;flex:none}
  .msw-status{display:flex;align-items:center;gap:7px;padding:7px 9px;border-radius:8px;background:rgba(0,0,0,.25);font-size:12px;color:#b5bac1;min-width:0}
  .msw-status b{color:#f2f3f5;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .msw-dot{width:8px;height:8px;border-radius:50%;flex:none;background:#80848e}
  .msw-opts{display:flex;flex-direction:column;gap:5px;padding:2px 2px 0}
  .msw-check{display:flex;align-items:center;gap:7px;font-size:12px;color:#b5bac1;cursor:pointer}
  .msw-check input{accent-color:#5865F2;margin:0;cursor:pointer}
  .msw-note{font-size:11px;color:#f0b232}
  .msw-pill{display:flex;align-items:center;gap:7px;height:32px;padding:0 12px 0 10px;border-radius:999px;cursor:pointer;
    background:rgba(17,18,21,.62);backdrop-filter:blur(22px) saturate(150%);border:1px solid rgba(255,255,255,.1);box-shadow:0 6px 22px rgba(0,0,0,.4);
    font-weight:700;font-size:12px;color:#f2f3f5;max-width:260px}
  .msw-pill b{white-space:nowrap;flex:none}
  .msw-pill span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:#b5bac1}
  /* chip docked in Discord's title bar: soft translucent tile, styled like the inbox / help buttons */
  .msw-chip{display:inline-flex;align-items:center;gap:6px;height:24px;max-width:230px;padding:0 8px;margin-right:8px;border-radius:6px;
    flex:none;align-self:center;box-sizing:border-box;cursor:pointer;-webkit-app-region:no-drag;user-select:none;
    background:var(--background-modifier-hover,rgba(255,255,255,.07));color:var(--interactive-hover,#dbdee1);
    font:600 12px/1 var(--font-primary,'gg sans','Noto Sans','Segoe UI',sans-serif);
    transition:background .12s,color .12s}
  .msw-chip *{-webkit-app-region:no-drag}
  .msw-chip:hover{background:rgba(24,25,28,.9);color:var(--interactive-active,#fff)}   /* hover: darker, almost solid */
  .msw-chip.open{background:rgba(18,19,22,.95);color:var(--interactive-active,#fff)}
  .msw-chip.off{opacity:.5}
  .msw-chip-icon{width:15px;height:15px;flex:none}
  .msw-chip b{white-space:nowrap;flex:none;font-weight:700;color:var(--header-primary,#f2f3f5)}
  .msw-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
  .msw-toast{position:absolute;right:0;top:calc(100% + 8px);max-width:318px;padding:7px 11px;border-radius:8px;font-size:12px;font-weight:600;
    background:#111214;border:1px solid rgba(255,255,255,.1);border-left:3px solid var(--acc,#5865F2);color:#f2f3f5;
    box-shadow:0 6px 20px rgba(0,0,0,.5);opacity:0;transform:translateY(-4px);transition:opacity .15s,transform .15s;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .msw-toast.show{opacity:1;transform:none}
  `;
    (function injectCss() {
      try {                                       // constructable sheet: not affected by inline-style CSP
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        cleanups.push(() => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet); });
      } catch (_) {
        const st = document.createElement('style');
        st.textContent = CSS;
        document.head.appendChild(st);
        cleanups.push(() => st.remove());
      }
    })();

    /* tiny DOM helper (no innerHTML: device names are always inserted as text) */
    function h(tag, props, ...kids) {
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(props || {})) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
      for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
      return el;
    }
    const MIC_SVG = (cls = 'msw-icon') => {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', cls); svg.setAttribute('fill', 'currentColor');
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', 'M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Zm-7 9a1 1 0 0 1 2 0 5 5 0 0 0 10 0 1 1 0 1 1 2 0 7 7 0 0 1-6 6.92V21h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-3.08A7 7 0 0 1 5 11Z');
      svg.append(p);
      return svg;
    };

    /* =========================================================
     * 6. UI
     * ======================================================= */
    const root = h('div', { id: 'msw-root' });
    const toastEl = h('div', { class: 'msw-toast' });
    const ui = {};
    let toastTimer = 0;
    let lastSig = '';
    let dragMoved = false;
    const bootTime = performance.now();
    // Before Discord has enumerated devices its list holds one placeholder:
    // { id: 'default', name: 'No Input Devices', disabled: true }. Stay invisible until real devices exist.
    const PLACEHOLDER_NAME = 'No Input Devices';   // hard-coded (not translated) in Discord's MediaEngineStore
    // Title-bar mode: Discord's top bar appears a few seconds after launch. Wait for it instead of
    // flashing the floating pill; only fall back to floating if it never shows up.
    const DOCK_GRACE_MS = 15000;
    const floatingAllowed = () => !S.dock || performance.now() - bootTime > DOCK_GRACE_MS;

    // First run: Mic 1 = the mic Discord is using right now (only once real devices are known).
    function firstRunSetup(devs) {
      S.slots.forEach((s, i) => { if (s.name === PLACEHOLDER_NAME) S.slots[i] = { id: null, name: '' }; });
      if (S.slots[0].id || S.slots[1].id) return;
      const d = devs.find((x) => x.id === currentDeviceId() && !x.disabled);
      if (d) { S.slots[0] = { id: d.id, name: d.name }; save(); }
    }

    function toast(msg, kind = 'info', slotIdx) {
      if (!root.isConnected) { log(msg); return; }
      const color = slotIdx != null ? ACCENTS[slotIdx] : { ok: '#23A55A', warn: '#f0b232', err: '#f23f43', info: '#5865F2' }[kind];
      const r = root.getBoundingClientRect();
      const below = r.bottom + 50 < innerHeight;
      Object.assign(toastEl.style, {
        top: below ? 'calc(100% + 8px)' : 'auto', bottom: below ? 'auto' : 'calc(100% + 8px)',
        right: r.left > innerWidth / 2 ? '0' : 'auto', left: r.left > innerWidth / 2 ? 'auto' : '0',
      });
      toastEl.style.setProperty('--acc', color);
      toastEl.textContent = msg;
      toastEl.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
    }

    function keyButton(action) {
      const label = h('b');
      const hint = h('span');
      const x = h('span', { class: 'msw-x', title: 'Clear hotkey', onclick: (e) => {
        e.stopPropagation(); S.hotkeys[action] = null; save(); registerGlobal(); render();
      } }, '×');
      const el = h('button', {
        class: 'msw-key', title: 'Click, then press a key combination (Esc = cancel, Backspace = clear)',
        onclick: () => { if (recording && recording.action === action) stopRecording(); else { el.blur(); startRecording(action); } },
      }, h('span', { class: 'msw-kicon' }, '⌨'), label, hint, x);
      return {
        el,
        update() {
          const rec = !!recording && recording.action === action;
          const c = S.hotkeys[action];
          el.classList.toggle('rec', rec);
          label.textContent = rec ? 'Press keys…' : (c ? c.label : '');
          hint.textContent = !rec && !c ? 'Set hotkey' : '';
          x.style.display = !rec && c ? '' : 'none';
        },
      };
    }

    function buildSlot(i) {
      const s = {};
      s.select = h('select', { class: 'msw-select', title: `Microphone for slot ${i + 1}`, onchange: (e) => {
        const d = listDevices().find((x) => x.id === e.target.value);
        S.slots[i] = d ? { id: d.id, name: d.name } : { id: null, name: '' };
        save(); lastSig = ''; render();
      } });
      s.warn = h('span', { class: 'msw-warn' });
      s.key = keyButton('slot' + i);
      s.use = h('button', { class: 'msw-btn', title: `Switch Discord to Mic ${i + 1} now`, onclick: () => switchTo(i, 'manual') }, 'Use');
      s.el = h('div', { class: 'msw-slot', style: `--acc:${ACCENTS[i]}` },
        h('div', { class: 'msw-slot-top' },
          h('span', { class: 'msw-slot-name' }, `MIC ${i + 1}`),
          h('span', { class: 'msw-badge' }, h('i'), 'ACTIVE'),
          s.warn),
        s.select,
        h('div', { class: 'msw-line' }, s.key.el, s.use));
      return s;
    }

    function buildUI() {
      ui.enable = h('button', { class: 'msw-switch', title: 'Enable / disable hotkeys', onclick: () => {
        S.enabled = !S.enabled; save(); registerGlobal(); render();
        toast(S.enabled ? 'Mic Switcher enabled' : 'Mic Switcher disabled (hotkeys off)', 'info');
      } });
      const head = h('div', { class: 'msw-head' },
        MIC_SVG(),
        h('div', { class: 'msw-titlebox' },
          h('div', { class: 'msw-title' }, 'Mic Switcher', h('small', null, 'v' + VERSION)),
          h('div', { class: 'msw-credit' }, 'made by volync')),
        ui.enable,
        h('button', { class: 'msw-iconbtn', title: 'Minimize', onclick: () => setCollapsed(true) }, '–'),
        h('button', { class: 'msw-iconbtn', title: 'Close (remove until you paste the script again)', onclick: () => api.destroy() }, '×'));
      ui.slots = [0, 1].map(buildSlot);
      ui.toggleKey = keyButton('toggle');
      const toggleRow = h('div', { class: 'msw-row' },
        h('div', { class: 'msw-lbl' }, 'TOGGLE'), ui.toggleKey.el,
        h('button', { class: 'msw-btn ghost', title: 'Switch to the other mic', onclick: () => toggleMic('manual') }, '⇄ Swap'));
      ui.dot = h('div', { class: 'msw-dot' });
      ui.cur = h('b');
      const status = h('div', { class: 'msw-status', title: 'What Discord is actually using right now (read from MediaEngineStore)' },
        ui.dot, h('span', { style: 'flex:none' }, 'Discord input:'), ui.cur);
      ui.global = h('input', { type: 'checkbox', onchange: (e) => {
        S.global = e.target.checked; save(); registerGlobal(); render();
        if (S.global && !globalStatus) toast('Global hotkeys on - they work while gaming', 'ok');
      } });
      ui.sound = h('input', { type: 'checkbox', onchange: (e) => { S.sound = e.target.checked; save(); } });
      ui.dock = h('input', { type: 'checkbox', onchange: (e) => { S.dock = e.target.checked; save(); syncDock(); } });
      ui.note = h('div', { class: 'msw-note' });
      const opts = h('div', { class: 'msw-opts' },
        h('label', { class: 'msw-check', title: 'Dock next to the inbox / help buttons at the top of Discord' }, ui.dock, 'Show in Discord title bar'),
        h('label', { class: 'msw-check', title: "Uses Discord's native keybind hook (same as push-to-talk)" }, ui.global, 'Global hotkeys (work when Discord is not focused)'),
        h('label', { class: 'msw-check' }, ui.sound, 'Play Discord sound on switch'),
        ui.note);
      ui.body = h('div', { class: 'msw-body' }, ui.slots.map((s) => s.el), toggleRow, status, opts);
      ui.panel = h('div', { class: 'msw-panel' }, head, ui.body);

      ui.pillDot = h('div', { class: 'msw-dot' });
      ui.pillLabel = h('b');
      ui.pillName = h('span');
      ui.pill = h('div', { class: 'msw-pill', title: 'Click to open Mic Switcher (drag to move)', onclick: () => { if (!dragMoved) setCollapsed(false); } },
        ui.pillDot, ui.pillLabel, ui.pillName);

      // Title-bar chip (lives inside Discord's own top bar, see syncDock)
      ui.chipIcon = MIC_SVG('msw-chip-icon');
      ui.chipLabel = h('b');
      ui.chipName = h('span');
      ui.chip = h('div', { class: 'msw-chip', role: 'button', tabindex: '0',
        onclick: (e) => { e.stopPropagation(); setCollapsed(!S.collapsed); },
        ondblclick: (e) => e.stopPropagation(),   // double-clicking the title bar maximizes the window - not here
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed(!S.collapsed); } } },
        ui.chipIcon, ui.chipLabel, ui.chipName);

      makeDraggable(head);
      makeDraggable(ui.pill);
      root.append(ui.panel, ui.pill, toastEl);
    }

    function render() {
      if (!ui.panel) return;
      const devs = listDevices();
      const ready = devs.some((d) => !d.disabled);   // false = Discord still loading its device list
      root.style.display = ready ? '' : 'none';
      ui.chip.style.display = ready ? '' : 'none';
      if (!ready) return;
      firstRunSetup(devs);
      const cur = currentDeviceId();
      const act = activeSlot();
      const sig = JSON.stringify([devs.map((d) => [d.id, d.name, d.disabled]), S.slots]);
      const rebuild = sig !== lastSig;
      lastSig = sig;

      ui.slots.forEach((s, i) => {
        const slot = S.slots[i];
        const live = resolveSlot(i);
        if (rebuild && document.activeElement !== s.select) {
          s.select.replaceChildren(
            h('option', { value: '' }, '— Select microphone —'),
            ...devs.map((d) => h('option', { value: d.id, disabled: d.disabled }, d.name)));
          if (slot.id && !live) s.select.append(h('option', { value: slot.id, disabled: true }, `⚠ ${slot.name || slot.id} (disconnected)`));
          s.select.value = live ? live.id : (slot.id || '');
        }
        s.el.classList.toggle('active', act === i);
        s.warn.textContent = slot.id && !live ? 'DISCONNECTED' : '';
        s.use.disabled = !live;
        s.key.update();
      });
      ui.toggleKey.update();

      ui.cur.textContent = deviceName(cur);
      ui.dot.style.background = act >= 0 ? ACCENTS[act] : '#80848e';
      ui.enable.classList.toggle('on', S.enabled);
      ui.body.classList.toggle('off', !S.enabled);
      ui.global.checked = S.global;
      ui.sound.checked = S.sound;
      ui.note.textContent = [globalStatus, storage.persistent ? '' : 'Settings cannot be saved here (no localStorage).']
        .filter(Boolean).join(' ');

      ui.pillDot.style.background = act >= 0 ? ACCENTS[act] : '#80848e';
      ui.pillLabel.textContent = act >= 0 ? `Mic ${act + 1}` : 'Mic';
      ui.pillName.textContent = deviceName(cur);

      const docked = isDocked();
      root.classList.toggle('msw-docked', docked);
      ui.dock.checked = S.dock;
      ui.chipIcon.style.color = act >= 0 ? ACCENTS[act] : 'currentColor';
      ui.chipLabel.textContent = act >= 0 ? `Mic ${act + 1}` : 'Mic';
      ui.chipName.textContent = shortName(deviceName(cur));
      ui.chip.title = `Mic Switcher: ${deviceName(cur)}\nClick for settings`;
      ui.chip.classList.toggle('open', docked && !S.collapsed);
      ui.chip.classList.toggle('off', !S.enabled);

      ui.panel.style.display = S.collapsed ? 'none' : '';
      ui.pill.style.display = S.collapsed && !docked && floatingAllowed() ? '' : 'none';
      if (docked) positionDocked();
    }

    // "Микрофон (3- Maono Falcon Plus)" -> "Maono Falcon Plus" (chip only; panel shows full names)
    const shortName = (n) => {
      const m = /^[^(]*\((?:\d+-\s*)?(.*)\)$/.exec(String(n));   // Windows: "<endpoint> (<device>)"
      return m && m[1].length >= 6 ? m[1] : String(n);         // keep full name if the part in () is just a tag like "USB"
    };

    /* ---- docking into Discord's title bar ----
     * Discord renders:  <div data-window-chrome="true" class="bar_…">
     *                     <div class="title_…"/> <div class="leading_…"/>
     *                     <div class="trailing_…"> [inbox] [help] <div class="winButtons_…"/> </div>
     * The chip is prepended to trailing_, i.e. just left of the inbox button.
     * The class hash (e.g. _3zSH5d) changes between builds, so match the prefix only. */
    function findDockTarget() {
      for (const bar of document.querySelectorAll('[data-window-chrome="true"]')) {
        for (const el of bar.children) if (/(^|\s)trailing_/.test(el.className)) return el;
      }
      return null;
    }
    const isDocked = () => S.dock && !!ui.chip && ui.chip.isConnected;
    let wasDocked = false;
    function syncDock() {
      if (!ui.chip) return;
      const target = S.dock ? findDockTarget() : null;
      if (target && ui.chip.parentNode !== target) target.prepend(ui.chip);   // (re)insert after Discord re-renders
      if (!target && ui.chip.isConnected) ui.chip.remove();                   // dock off, or no title bar (browser)
      const docked = isDocked();
      if (wasDocked && !docked) {                                            // back to floating: restore free position
        Object.assign(root.style, { left: '', top: '', right: '' });
        if (S.pos) place(S.pos.x, S.pos.y);
      }
      if (docked !== wasDocked) { wasDocked = docked; render(); }
    }
    function positionDocked() {                    // panel opens like a dropdown under the chip
      const r = ui.chip.getBoundingClientRect();
      Object.assign(root.style, { left: 'auto', top: Math.round(r.bottom + 8) + 'px',
        right: Math.max(8, Math.round(innerWidth - r.right)) + 'px' });
    }

    function place(x, y) {
      const w = root.offsetWidth || 318;
      const hgt = root.offsetHeight || 40;
      x = Math.max(4, Math.min(innerWidth - w - 4, x));
      y = Math.max(4, Math.min(innerHeight - hgt - 4, y));
      Object.assign(root.style, { left: x + 'px', top: y + 'px', right: 'auto' });
    }
    function clampToViewport() {
      if (isDocked()) positionDocked();
      else if (S.pos) place(root.offsetLeft, root.offsetTop);
    }

    function setCollapsed(v) {
      S.collapsed = v;
      save();
      render();
      clampToViewport();
    }

    function makeDraggable(handle) {
      handle.addEventListener('mousedown', (e) => {
        if (isDocked() || e.button !== 0 || e.target.closest('button,input,select,label')) return;
        const r = root.getBoundingClientRect();
        const ox = e.clientX - r.left;
        const oy = e.clientY - r.top;
        const sx = e.clientX;
        const sy = e.clientY;
        dragMoved = false;
        const move = (ev) => {
          if (!dragMoved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
          dragMoved = true;
          place(ev.clientX - ox, ev.clientY - oy);
        };
        const up = () => {
          window.removeEventListener('mousemove', move, true);
          window.removeEventListener('mouseup', up, true);
          if (dragMoved) {
            S.pos = { x: root.offsetLeft, y: root.offsetTop };
            save();
            setTimeout(() => { dragMoved = false; }, 0);   // swallow the click that ends a drag
          }
        };
        window.addEventListener('mousemove', move, true);
        window.addEventListener('mouseup', up, true);
        e.preventDefault();
      });
    }

    /* =========================================================
     * 7. Init
     * ======================================================= */
    buildUI();
    document.body.appendChild(root);
    cleanups.push(() => root.remove());
    if (S.pos) place(S.pos.x, S.pos.y);
    // Always start folded (title-bar chip, or the small pill in floating mode). The title bar
    // may not exist yet at autostart, so this must not depend on whether we could dock already.
    S.collapsed = true;
    render();
    registerGlobal();
    syncDock();
    render();

    // Keep the chip in the title bar (Discord may re-render it) and the dropdown aligned.
    const dockTimer = setInterval(() => {
      syncDock();
      if (isDocked()) { if (!S.collapsed) positionDocked(); }
      else render();                       // not docked (yet): lets the pill appear once the grace period ends
    }, 1000);
    cleanups.push(() => { clearInterval(dockTimer); ui.chip.remove(); });
    // Docked panel behaves like a dropdown: a click anywhere else closes it.
    function onOutsideDown(e) {
      if (!isDocked() || S.collapsed || recording) return;
      if (root.contains(e.target) || ui.chip.contains(e.target)) return;
      setCollapsed(true);
    }
    document.addEventListener('mousedown', onOutsideDown, true);
    cleanups.push(() => document.removeEventListener('mousedown', onOutsideDown, true));

    // Live updates: device plugged/unplugged, or mic changed in Discord's own settings.
    let storeKey = '';
    let storeQueued = false;
    function onStoreChange() {
      if (storeQueued) return;
      storeQueued = true;
      setTimeout(() => {
        storeQueued = false;
        let key = '';
        try { key = currentDeviceId() + '|' + Object.keys(MediaEngineStore.getInputDevices() || {}).join(','); } catch (_) { /* ignore */ }
        if (key !== storeKey) { storeKey = key; render(); }
      }, 50);
    }
    MediaEngineStore.addChangeListener(onStoreChange);
    cleanups.push(() => MediaEngineStore.removeChangeListener(onStoreChange));
    const onResize = () => clampToViewport();
    window.addEventListener('resize', onResize);
    cleanups.push(() => window.removeEventListener('resize', onResize));

    /* =========================================================
     * 8. Console API
     * ======================================================= */
    function diagnose() {
      const u = nativeUtils();
      const info = {
        version: VERSION,
        MediaEngineStore: !!MediaEngineStore,
        AudioActionCreators: !!AudioActions,
        FluxDispatcher: !!Dispatcher,
        webpackRuntimes: reqs.map(moduleCount).join(' / ') + ' modules',
        dockedInTitleBar: isDocked(),
        nativeKeybindAPI: !!(u && isFn(u.inputEventRegister)),
        globalKeybindsRegistered: nativeIds.slice(),
        globalStatus: globalStatus || 'ok',
        persistentStorage: storage.persistent,
        currentInput: { id: currentDeviceId(), name: deviceName(currentDeviceId()) },
        activeSlot: activeSlot() + 1 || 'none',
        slots: S.slots.map((s, i) => ({ ...s, connected: !!resolveSlot(i) })),
        hotkeys: Object.fromEntries(ACTIONS.map((a) => [a, S.hotkeys[a] ? S.hotkeys[a].label : null])),
      };
      console.table(listDevices());
      log(info);
      return info;
    }

    const api = {
      version: VERSION,
      switchTo: (i) => switchTo(i, 'console'),
      toggle: () => toggleMic('console'),
      show: () => setCollapsed(false),
      hide: () => setCollapsed(true),
      devices: listDevices,
      diagnose,
      settings: S,
      destroy() {
        recording = null;
        clearTimeout(toastTimer);
        for (const fn of cleanups.splice(0).reverse()) { try { fn(); } catch (e) { warn('cleanup', e); } }
        if (window.__micSwitcher === api) delete window.__micSwitcher;
        if (window.MicSwitcher === api) delete window.MicSwitcher;
        log('Removed. Paste the script again to bring it back.');
      },
    };
    window.__micSwitcher = api;
    window.MicSwitcher = api;

    log(`v${VERSION} loaded. Input devices: ${listDevices().length}. Current: "${deviceName(currentDeviceId())}".`,
      `\n  switch via: ${AudioActions ? 'AudioActionCreators.setInputDevice' : 'Dispatcher'} | global hotkeys API: ${nativeUtils() ? 'yes' : 'no'}`,
      '\n  Console: MicSwitcher.toggle() / .switchTo(0|1) / .show() / .diagnose() / .destroy()');
  }

  if (!AUTOLOAD) { main(); return; }   // pasted in the console: run now, errors show in red

  // Autostart: retry every second (up to 3 minutes) until Discord has loaded.
  let tries = 0;
  (function attempt() {
    try { main(); }
    catch (e) {
      if (e && e.retryable && ++tries < 180) { setTimeout(attempt, 1000); return; }
      console.error('[MicSwitcher] autostart failed:', e);
    }
  })();
})();
