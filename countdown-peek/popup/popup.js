'use strict';

const KEY = '__countdown_peek__';

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');

const state = {
  tab: null,
  host: '',
  sites: {},
  mode: 'absolute',
  target: 0,
  utc: false,
  pageNow: null, // { now, at } page's Date.now() sampled at popup time `at`
};

// ---------- time helpers ----------
function toInput(ms, utc) {
  const d = new Date(ms);
  const p = utc
    ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
    : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
  return `${p[0]}-${pad(p[1])}-${pad(p[2])}T${pad(p[3])}:${pad(p[4])}:${pad(p[5])}`;
}

function fromInput(value, utc) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (!m) return NaN;
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number);
  const s = Number(m[6] || 0);
  return utc ? Date.UTC(y, mo - 1, d, h, mi, s) : new Date(y, mo - 1, d, h, mi, s).getTime();
}

function fmt(ms, utc = state.utc) {
  const s = new Intl.DateTimeFormat('vi-VN', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: utc ? 'UTC' : undefined,
  }).format(ms);
  return utc ? `${s} UTC` : s;
}

function fmtDuration(ms) {
  const sign = ms < 0 ? '-' : '';
  let s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  s %= 86400;
  return `${sign}${d}d ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}

function describe(cfg) {
  if (cfg.mode === 'offset') return `Cộng ${fmtDuration(cfg.offset)}`;
  return `Mốc ${fmt(cfg.target)}`;
}

// ---------- functions injected into the page ----------
// ISOLATED world: hand the config to bridge.js (mirror + live update). Tabs
// opened before the extension was installed have no bridge; just write the
// mirror so the reload that follows picks it up.
function pushConfig(key, cfg) {
  if (globalThis.__countdownPeek) return globalThis.__countdownPeek.push(cfg);
  try {
    if (cfg) localStorage.setItem(key, JSON.stringify(cfg, Object.keys(cfg).sort()));
    else localStorage.removeItem(key);
  } catch {}
}

// MAIN world: read the page's (possibly faked) clock.
function readPageNow() {
  return Date.now();
}

// MAIN world: find a "NN Days NN Hours NN Minutes NN Seconds" style countdown.
function detectCountdown() {
  const text = (document.body && document.body.innerText) || '';
  const units = [
    [/^(days?|ngày|d)$/i, 864e5],
    [/^(hours?|hrs?|giờ|h)$/i, 36e5],
    [/^(minutes?|mins?|phút|m)$/i, 6e4],
    [/^(seconds?|secs?|giây|s)$/i, 1e3],
  ];
  const re =
    /(?<!\d)((?:\d\s*){1,4})(days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|ngày|giờ|phút|giây|[dhms])(?!\p{L})/giu;
  const runs = [];
  let run = [];
  for (const m of text.matchAll(re)) {
    const unit = units.find(([r]) => r.test(m[2]));
    if (!unit) continue;
    const item = {
      value: parseInt(m[1].replace(/\s+/g, ''), 10),
      unit: unit[1],
      start: m.index,
      end: m.index + m[0].length,
    };
    const last = run[run.length - 1];
    if (last && item.unit < last.unit && item.start - last.end <= 40) {
      run.push(item);
    } else {
      if (run.length >= 2) runs.push(run);
      run = [item];
    }
  }
  if (run.length >= 2) runs.push(run);
  if (!runs.length) return null;
  const best = runs.reduce((a, b) => (b.length > a.length ? b : a));
  return {
    remaining: best.reduce((sum, i) => sum + i.value * i.unit, 0),
    pageNow: Date.now(),
  };
}

// ---------- UI ----------
function setMsg(text, kind = '') {
  $('msg').textContent = text;
  $('msg').className = `small ${kind}`;
}

function setMode(mode) {
  state.mode = mode;
  $('tabAbs').classList.toggle('active', mode === 'absolute');
  $('tabOff').classList.toggle('active', mode === 'offset');
  $('panelAbs').hidden = mode !== 'absolute';
  $('panelOff').hidden = mode !== 'offset';
}

function renderTarget() {
  $('target').value = toInput(state.target, state.utc);
}

function renderPill() {
  const on = !!state.sites[state.host];
  $('pill').textContent = on ? 'ON' : 'OFF';
  $('pill').classList.toggle('on', on);
}

function renderClock() {
  if (!state.pageNow) {
    $('pageClock').textContent = '—';
    return;
  }
  const ms = state.pageNow.now + (Date.now() - state.pageNow.at);
  $('pageClock').textContent = fmt(ms);
}

function renderSites() {
  const ul = $('sites');
  ul.textContent = '';
  const entries = Object.entries(state.sites);
  $('sitesBox').hidden = entries.length === 0;
  for (const [host, cfg] of entries) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.style.minWidth = '0';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = host;
    const desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = describe(cfg) + (cfg.freeze ? ' · đóng băng' : '');
    info.append(name, desc);
    const rm = document.createElement('button');
    rm.textContent = '✕';
    rm.title = 'Xoá';
    rm.addEventListener('click', async () => {
      delete state.sites[host];
      await chrome.storage.local.set({ sites: state.sites });
      renderSites();
      renderPill();
    });
    li.append(info, rm);
    ul.append(li);
  }
}

function offsetFromInputs() {
  const n = (id) => Number($(id).value) || 0;
  return n('offD') * 864e5 + n('offH') * 36e5 + n('offM') * 6e4;
}

function fillOffsetInputs(ms) {
  const sign = ms < 0 ? -1 : 1;
  let m = Math.round(Math.abs(ms) / 6e4);
  $('offD').value = sign * Math.floor(m / 1440);
  m %= 1440;
  $('offH').value = sign * Math.floor(m / 60);
  $('offM').value = sign * (m % 60);
}

async function refreshPageClock() {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: state.tab.id },
      world: 'MAIN',
      func: readPageNow,
    });
    state.pageNow = { now: res.result, at: Date.now() };
  } catch {
    state.pageNow = null;
  }
  renderClock();
}

async function pushToTab(cfg) {
  await chrome.scripting
    .executeScript({
      target: { tabId: state.tab.id, allFrames: true },
      func: pushConfig,
      args: [KEY, cfg],
    })
    .catch(() => {});
}

async function afterChange(cfg) {
  const reload = $('reload').checked;
  await chrome.storage.local.set({ prefs: { utc: state.utc, reload } });
  await pushToTab(cfg);
  await chrome.action.setBadgeText({ tabId: state.tab.id, text: cfg ? 'ON' : '' });
  renderPill();
  renderSites();
  if (reload) {
    await chrome.tabs.reload(state.tab.id);
    setTimeout(refreshPageClock, 800);
  } else {
    refreshPageClock();
  }
}

async function apply() {
  const cfg = {
    enabled: true,
    mode: state.mode,
    target: state.target,
    offset: offsetFromInputs(),
    freeze: $('freeze').checked,
    updatedAt: Date.now(),
  };
  if (cfg.mode === 'absolute' && !Number.isFinite(cfg.target)) {
    setMsg('Mốc thời gian không hợp lệ.', 'err');
    return;
  }
  state.sites[state.host] = cfg;
  await chrome.storage.local.set({ sites: state.sites });
  setMsg(`Đã bật: ${describe(cfg)}`, 'ok');
  await afterChange(cfg);
}

async function disable() {
  delete state.sites[state.host];
  await chrome.storage.local.set({ sites: state.sites });
  setMsg('Đã tắt, trang dùng lại giờ thật.', 'ok');
  await afterChange(null);
}

async function detect() {
  $('detectMsg').textContent = 'Đang dò…';
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: state.tab.id },
      world: 'MAIN',
      func: detectCountdown,
    });
    const r = res.result;
    if (!r) {
      $('detectMsg').textContent = 'Không tìm thấy countdown dạng Days/Hours/Minutes/Seconds.';
      return;
    }
    // Countdowns show whole seconds; add a small buffer to land just past zero.
    state.target = r.pageNow + r.remaining + 2000;
    setMode('absolute');
    renderTarget();
    $('detectMsg').textContent = `Countdown còn ${fmtDuration(r.remaining)} → mốc ${fmt(state.target)}`;
  } catch (e) {
    $('detectMsg').textContent = `Lỗi: ${e.message}`;
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;
  const { sites = {}, prefs = {} } = await chrome.storage.local.get(['sites', 'prefs']);
  state.sites = sites;
  state.utc = !!prefs.utc;
  $('utc').checked = state.utc;
  if (prefs.reload === false) $('reload').checked = false;
  renderSites();

  let url = null;
  try {
    url = new URL(tab.url);
  } catch {}
  if (!url || !/^(https?|file):$/.test(url.protocol)) {
    $('main').hidden = true;
    $('unsupported').hidden = false;
    $('host').textContent = url ? url.protocol : '—';
    return;
  }
  state.host = url.hostname;
  $('host').textContent = state.host || url.protocol;

  const cfg = sites[state.host];
  if (cfg) {
    setMode(cfg.mode);
    state.target = cfg.target || Math.ceil(Date.now() / 6e4) * 6e4;
    fillOffsetInputs(cfg.offset || 0);
    $('freeze').checked = !!cfg.freeze;
  } else {
    state.target = Math.ceil(Date.now() / 6e4) * 6e4;
  }
  renderTarget();
  renderPill();

  $('tabAbs').addEventListener('click', () => setMode('absolute'));
  $('tabOff').addEventListener('click', () => setMode('offset'));
  $('target').addEventListener('change', () => {
    state.target = fromInput($('target').value, state.utc);
  });
  $('utc').addEventListener('change', () => {
    state.utc = $('utc').checked;
    renderTarget();
    renderClock();
    renderSites();
    chrome.storage.local.set({ prefs: { utc: state.utc, reload: $('reload').checked } });
  });
  document.querySelectorAll('[data-add]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const add = Number(btn.dataset.add);
      state.target = add === 0 ? Date.now() : (Number.isFinite(state.target) ? state.target : Date.now()) + add;
      renderTarget();
    }),
  );
  $('detect').addEventListener('click', detect);
  $('apply').addEventListener('click', () => apply().catch((e) => setMsg(e.message, 'err')));
  $('disable').addEventListener('click', () => disable().catch((e) => setMsg(e.message, 'err')));

  await refreshPageClock();
  setInterval(renderClock, 250);
}

init().catch((e) => setMsg(e.message, 'err'));
