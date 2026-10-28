'use strict';

const KEY = '__countdown_peek__';
const BUFFER = 2000; // land a little past zero

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  tab: null,
  host: '',
  sites: {},
  mode: 'absolute',
  target: 0,
  utc: false,
  pageNow: null, // { now, at } page's Date.now() sampled at popup time `at`
  lastDetect: null, // { remaining, realAt } last live countdown seen, in real time
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

// MAIN world. Finds a running countdown by reading the page text twice and
// keeping the values that went down by about the elapsed time, so a normal
// clock ("18:28:17") or a static "24h" label isn't mistaken for one.
// Supports "05:31:42" / "2:05:31:42" / "31:42" and "2 Days 05 Hours ..." /
// "05h 31m 42s". Also picks up "17:00 UTC" / "Monday at 16:00 UTC" text.
async function detectCountdown(sampleMs) {
  const UNITS = [
    [/^(days?|ngày|d)$/i, 864e5],
    [/^(hours?|hrs?|giờ|h)$/i, 36e5],
    [/^(minutes?|mins?|phút|m)$/i, 6e4],
    [/^(seconds?|secs?|giây|s)$/i, 1e3],
  ];
  const LABELED =
    /(?<!\d)((?:\d\s*){1,4})(days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|ngày|giờ|phút|giây|[dhms])(?!\p{L})/giu;
  const COLON = /(?<![\d:])(\d{1,3})((?:\s{0,3}:\s{0,3}\d{2}){1,3})(?![\d:])/g;
  const MULT = [864e5, 36e5, 6e4, 1e3];

  const text = () => (document.body && document.body.innerText) || '';

  function scan(t) {
    const out = [];
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        out.push({ kind: 'label', parts: run.length, remaining: run.reduce((s, i) => s + i.value * i.unit, 0) });
      }
      run = [];
    };
    for (const m of t.matchAll(LABELED)) {
      const u = UNITS.find(([r]) => r.test(m[2]));
      if (!u) continue;
      const item = {
        value: parseInt(m[1].replace(/\s+/g, ''), 10),
        unit: u[1],
        start: m.index,
        end: m.index + m[0].length,
      };
      const last = run[run.length - 1];
      if (last && item.unit < last.unit && item.start - last.end <= 40) {
        run.push(item);
      } else {
        flush();
        run = [item];
      }
    }
    flush();
    for (const m of t.matchAll(COLON)) {
      const nums = [m[1], ...m[2].split(':').slice(1)].map((s) => parseInt(s, 10));
      const mult = MULT.slice(MULT.length - nums.length);
      // Every field after the first must be a valid clock field.
      const ok = nums.every((v, i) => i === 0 || v < (mult[i] === 36e5 ? 24 : 60));
      if (!ok) continue;
      out.push({ kind: 'colon', parts: nums.length, remaining: nums.reduce((s, v, i) => s + v * mult[i], 0) });
    }
    const seen = {};
    for (const c of out) c.key = `${c.kind}${(seen[c.kind] = (seen[c.kind] || 0) + 1)}`;
    return out;
  }

  function utcHint(t, nowMs) {
    const m =
      /(?:\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+(?:at\s+)?)?\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:UTC|GMT)(?:\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?)?/i.exec(
        t,
      );
    if (!m) return null;
    let h = Number(m[2]);
    const mi = Number(m[3] || 0);
    if (m[4]) h = (h % 12) + (/pm/i.test(m[4]) ? 12 : 0);
    if (h > 23 || mi > 59 || (!m[3] && !m[4])) return null;
    const tz = m[5] ? (m[5] === '-' ? -1 : 1) * (Number(m[6]) * 60 + Number(m[7] || 0)) * 6e4 : 0;
    const d = new Date(nowMs);
    let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, mi) - tz;
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const wd = m[1] ? days.indexOf(m[1].toLowerCase()) : -1;
    for (let i = 0; i < 8 && (at <= nowMs || (wd >= 0 && new Date(at + tz).getUTCDay() !== wd)); i++) at += 864e5;
    return { at, text: m[0].trim() };
  }

  const a = scan(text());
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, sampleMs));
  const bText = text();
  const b = scan(bText);
  const t1 = Date.now();
  const elapsed = t1 - t0;

  const prev = new Map(a.map((c) => [c.key, c]));
  const live = b.filter((c) => {
    const p = prev.get(c.key);
    if (!p) return false;
    const d = p.remaining - c.remaining;
    return d > 0 && Math.abs(d - elapsed) <= 1200;
  });
  // Prefer the most detailed running countdown; else a labeled one with 3+
  // fields that isn't ticking (e.g. the page clock is frozen). Two static
  // fields are too easy to hit by accident ("Volume 24h: 5m").
  const pick =
    live.sort((x, y) => y.parts - x.parts)[0] ||
    b.filter((c) => c.kind === 'label' && c.parts >= 3).sort((x, y) => y.parts - x.parts)[0] ||
    null;
  return {
    pageNow: t1,
    remaining: pick ? pick.remaining : null,
    live: !!(pick && live.includes(pick)),
    format: pick ? pick.kind : null,
    hint: utcHint(bText, t1),
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

function setUtc(on) {
  state.utc = on;
  $('utc').checked = on;
  renderTarget();
  renderClock();
  renderSites();
}

function renderTarget() {
  $('target').value = Number.isFinite(state.target) ? toInput(state.target, state.utc) : '';
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

// Runs detectCountdown in every frame; the first frame with a countdown wins,
// else the first with a "HH:MM UTC" hint.
async function runDetect(sampleMs = 1500) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: state.tab.id, allFrames: true },
    world: 'MAIN',
    func: detectCountdown,
    args: [sampleMs],
  });
  const rs = results.map((r) => r.result).filter(Boolean);
  const r = rs.find((x) => x.remaining != null) || rs.find((x) => x.hint) || null;
  if (r && r.remaining != null && r.live) {
    // Page clock may be faked: convert "remaining" to real time for later checks.
    state.lastDetect = { remaining: r.remaining, realAt: Date.now() };
  }
  return r;
}

async function detect({ auto = false } = {}) {
  $('detectMsg').textContent = 'Đang dò countdown…';
  let r;
  try {
    r = await runDetect();
  } catch (e) {
    $('detectMsg').textContent = `Lỗi: ${e.message}`;
    return;
  }
  if (!r || (r.remaining == null && !r.hint)) {
    $('detectMsg').textContent = auto
      ? 'Không tự dò được countdown — nhập mốc bằng tay (ví dụ tick UTC rồi nhập giờ mở).'
      : 'Không tìm thấy countdown (dạng 05:31:42 hoặc Days/Hours/Minutes/Seconds) hay giờ "UTC" trên trang.';
    return;
  }
  let target;
  let msg;
  if (r.remaining != null) {
    const end = r.pageNow + r.remaining;
    // Snap to the "HH:MM UTC" text when it agrees with the countdown.
    const snapped = r.hint && Math.abs(r.hint.at - end) < 90e3;
    target = (snapped ? r.hint.at : end) + BUFFER;
    msg = `Countdown còn ${fmtDuration(r.remaining)}${r.live ? '' : ' (không thấy đang chạy)'}`;
    if (snapped) msg += ` · khớp "${r.hint.text}"`;
  } else {
    target = r.hint.at + BUFFER;
    msg = `Theo dòng chữ "${r.hint.text}"`;
  }
  state.target = target;
  setMode('absolute');
  if (r.hint) setUtc(true);
  else renderTarget();
  $('detectMsg').textContent = `${msg} → mốc ${fmt(target)}`;
}

function waitTabComplete(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// After applying, check whether the page still counts down and say why.
async function verify(cfg, before) {
  setMsg('Đang kiểm tra trang…');
  await sleep(1500);
  let r = null;
  try {
    r = await runDetect(1500);
  } catch {}
  if (!r || r.remaining == null || !r.live || r.remaining <= 0) {
    setMsg(`Đã bật: ${describe(cfg)}. Countdown trên trang đã hết.`, 'ok');
    return;
  }
  const left = fmtDuration(r.remaining);
  const unchanged = before && Math.abs(before.remaining - (Date.now() - before.realAt) - r.remaining) < 5000;
  if (unchanged) {
    setMsg(
      `Trang vẫn đếm ngược y như cũ (còn ${left}). Trang này lấy giờ từ server/API, extension chỉ đổi được giờ trình duyệt nên không qua được.`,
      'err',
    );
  } else {
    setMsg(`Trang vẫn còn ${left}. Mốc chưa đủ xa — hãy chọn mốc muộn hơn (hoặc bấm Dò countdown rồi Áp dụng).`, 'err');
  }
}

async function afterChange(cfg) {
  const reload = $('reload').checked;
  const before = state.lastDetect;
  await chrome.storage.local.set({ prefs: { utc: state.utc, reload } });
  await pushToTab(cfg);
  await chrome.action.setBadgeText({ tabId: state.tab.id, text: cfg ? 'ON' : '' });
  renderPill();
  renderSites();
  if (reload) {
    const loaded = waitTabComplete(state.tab.id);
    await chrome.tabs.reload(state.tab.id);
    await loaded;
  }
  await refreshPageClock();
  if (cfg) await verify(cfg, before);
}

async function apply() {
  const realNow = Date.now();
  const cfg = {
    enabled: true,
    mode: state.mode,
    target: state.target,
    offset: offsetFromInputs(),
    freeze: $('freeze').checked,
    updatedAt: realNow,
  };
  if (cfg.mode === 'absolute') {
    if (!Number.isFinite(cfg.target)) {
      setMsg('Mốc thời gian không hợp lệ.', 'err');
      return;
    }
    if (Math.abs(cfg.target - realNow) < 120e3) {
      setMsg(
        'Mốc đang gần bằng giờ thật nên trang sẽ không khác gì. Chọn mốc SAU giờ mở (ví dụ trang ghi 17:00 UTC → tick UTC, nhập 17:00:05), hoặc bấm Dò countdown.',
        'err',
      );
      return;
    }
  } else if (Math.abs(cfg.offset) < 60e3) {
    setMsg('Khoảng cộng thêm đang là 0.', 'err');
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
    state.target = Number.isFinite(cfg.target) ? cfg.target : Date.now() + 36e5;
    fillOffsetInputs(cfg.offset || 0);
    $('freeze').checked = !!cfg.freeze;
  } else {
    state.target = Math.ceil(Date.now() / 6e4) * 6e4 + 36e5;
  }
  renderTarget();
  renderPill();

  $('tabAbs').addEventListener('click', () => setMode('absolute'));
  $('tabOff').addEventListener('click', () => setMode('offset'));
  $('target').addEventListener('change', () => {
    state.target = fromInput($('target').value, state.utc);
  });
  $('utc').addEventListener('change', () => {
    setUtc($('utc').checked);
    chrome.storage.local.set({ prefs: { utc: state.utc, reload: $('reload').checked } });
  });
  document.querySelectorAll('[data-add]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const add = Number(btn.dataset.add);
      state.target = add === 0 ? Date.now() : (Number.isFinite(state.target) ? state.target : Date.now()) + add;
      renderTarget();
    }),
  );
  $('detect').addEventListener('click', () => detect());
  $('apply').addEventListener('click', () => apply().catch((e) => setMsg(e.message, 'err')));
  $('disable').addEventListener('click', () => disable().catch((e) => setMsg(e.message, 'err')));

  await refreshPageClock();
  setInterval(renderClock, 250);

  // Not enabled here yet: try to prefill the target from the page.
  if (!cfg) detect({ auto: true });
}

init().catch((e) => setMsg(e.message, 'err'));
