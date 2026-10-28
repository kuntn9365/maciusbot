'use strict';

/* global syncInjectRegistration, peelPage */

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
  lastDetect: null, // { remaining, realAt } last running countdown seen, in real time
  detectedTarget: null, // target produced by detection (exempt from the near-now guard)
  detecting: null, // pending detection promise
  touched: false, // user changed the form; auto-detect must not overwrite it
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
  if (globalThis.__countdownPeek) {
    globalThis.__countdownPeek.push(cfg);
    return true;
  }
  let host = location.hostname;
  if (window !== window.top && location.ancestorOrigins && location.ancestorOrigins.length) {
    try {
      host = new URL(location.ancestorOrigins[location.ancestorOrigins.length - 1]).hostname;
    } catch {}
  }
  try {
    if (cfg) {
      const c = { ...cfg, host };
      localStorage.setItem(key, JSON.stringify(c, Object.keys(c).sort()));
    } else {
      localStorage.removeItem(key);
    }
  } catch {}
  return true;
}

// MAIN world: read the page's (possibly faked) clock.
function readPageNow() {
  return Date.now();
}

// MAIN world. Finds a running countdown by reading the page text twice and
// keeping the values that went down by about the elapsed time, so a normal
// clock ("18:28:17") or a count-up timer isn't mistaken for one.
// Supports "05:31:42" / "2:05:31:42" / "2 days 05:31:42" / "31:42",
// "2 Days 05 Hours ..." / "05h 31m 42s" / one-digit-per-box layouts, and open
// shadow roots. Also picks up "17:00 UTC" / "Monday at 16:00 UTC" text.
async function detectCountdown(sampleMs) {
  const UNITS = [
    [/^(days?|ngày|d)$/i, 864e5],
    [/^(hours?|hrs?|giờ|h)$/i, 36e5],
    [/^(minutes?|mins?|phút|m)$/i, 6e4],
    [/^(seconds?|secs?|giây|s)$/i, 1e3],
  ];
  // Digits may be split by spaces (one digit per inline box), not newlines:
  // "Season 3\n02 Days" must not read as 302 days.
  const LABELED =
    /(?<!\d)(\d{1,4}|\d(?:[ \t]\d){1,3})[ \t\n]*(days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|ngày|giờ|phút|giây|[dhms])(?!\p{L})/giu;
  // Optional "2 days " / "2 ngày " / "2d " in front of HH:MM:SS.
  const COLON =
    /(?:(?<!\d)(\d{1,4})\s*(?:days?|ngày|d)(?!\p{L})[,.]?\s*)?(?<![\d:])(\d{1,3})((?:\s{0,3}:\s{0,3}\d{2}){1,3})(?![\d:])/giu;
  const MULT = [864e5, 36e5, 6e4, 1e3];

  function shadowText(root, depth = 0) {
    if (depth > 5) return '';
    let t = '';
    for (const el of root.querySelectorAll('*')) {
      if (!el.shadowRoot) continue;
      for (const c of el.shadowRoot.children) {
        if (!/^(STYLE|SCRIPT|TEMPLATE)$/.test(c.tagName)) t += `\n${c.innerText || c.textContent || ''}`;
      }
      t += shadowText(el.shadowRoot, depth + 1);
    }
    return t;
  }

  function pageText() {
    const raw = ((document.body && document.body.innerText) || '') + (document.body ? shadowText(document.body) : '');
    // One digit (or colon) per block box comes out one per line: re-join them.
    return raw.replace(/(^|\n)((?:[ \t]*[\d:][ \t]*\n)+[ \t]*[\d:])(?=[ \t]*(\n|$))/g, (m, a, b) => a + b.replace(/\s+/g, ''));
  }

  function scan(t) {
    const out = [];
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        out.push({
          kind: 'label',
          parts: run.length,
          unit: run[run.length - 1].unit,
          remaining: run.reduce((s, i) => s + i.value * i.unit, 0),
        });
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
      const nums = [m[2], ...m[3].split(':').slice(1)].map((s) => parseInt(s, 10));
      const mult = MULT.slice(MULT.length - nums.length);
      // Every field after the first must be a valid clock field.
      if (!nums.every((v, i) => i === 0 || v < (mult[i] === 36e5 ? 24 : 60))) continue;
      const days = m[1] && nums.length === 3 ? parseInt(m[1], 10) : 0;
      out.push({
        kind: 'colon',
        parts: nums.length + (m[1] && nums.length === 3 ? 1 : 0),
        unit: 1e3,
        remaining: days * 864e5 + nums.reduce((s, v, i) => s + v * mult[i], 0),
      });
    }
    const seen = {};
    for (const c of out) c.key = `${c.kind}${(seen[c.kind] = (seen[c.kind] || 0) + 1)}`;
    return out;
  }

  // "17:00 UTC", "17:00 (UTC)", "UTC 17:00", "5 PM UTC", "16:00 UTC+7",
  // "Monday at 16:00 UTC", "2026-11-05 17:00 UTC". Returns every valid match.
  function utcHints(t, nowMs) {
    const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const TIME = String.raw`(?<![\d:])(\d{1,2})(?::(\d{2}))?(?::\d{2})?(?![\d:])\s*(am|pm)?`;
    const OFF = String.raw`(?:([+-])(\d{1,2})(?::?(\d{2}))?)?`;
    const PRE = String.raw`(?:\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+(?:at\s+)?|\b(\d{4})-(\d{2})-(\d{2})[ T]+)?`;
    const RES = [
      new RegExp(`${PRE}${TIME}\\s*\\(?(?:UTC|GMT)${OFF}\\)?`, 'gi'),
      new RegExp(`\\(?(?:UTC|GMT)${OFF}\\)?[ \\t]*${TIME}`, 'gi'),
    ];
    const out = [];
    for (const [i, re] of RES.entries()) {
      for (const m of t.matchAll(re)) {
        // Normalize capture positions of the two shapes.
        const g =
          i === 0
            ? { wd: m[1], y: m[2], mo: m[3], d: m[4], h: m[5], mi: m[6], ap: m[7], sg: m[8], oh: m[9], om: m[10] }
            : { sg: m[1], oh: m[2], om: m[3], h: m[4], mi: m[5], ap: m[6] };
        let h = Number(g.h);
        const mi = Number(g.mi || 0);
        if (!g.mi && !g.ap) continue;
        if (g.ap) h = (h % 12) + (/pm/i.test(g.ap) ? 12 : 0);
        if (h > 23 || mi > 59) continue;
        const tz = g.sg ? (g.sg === '-' ? -1 : 1) * (Number(g.oh) * 60 + Number(g.om || 0)) * 6e4 : 0;
        let at;
        if (g.y) {
          at = Date.UTC(Number(g.y), Number(g.mo) - 1, Number(g.d), h, mi) - tz;
        } else {
          const d = new Date(nowMs + tz);
          at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, mi) - tz;
          const wd = g.wd ? DAYS.indexOf(g.wd.toLowerCase()) : -1;
          for (let k = 0; k < 8 && (at <= nowMs || (wd >= 0 && new Date(at + tz).getUTCDay() !== wd)); k++) at += 864e5;
        }
        out.push({ at, text: m[0].trim(), index: m.index });
      }
    }
    return out.sort((a, b) => a.index - b.index);
  }

  const aText = pageText();
  const a = scan(aText);
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, sampleMs));
  const bText = pageText();
  const b = scan(bText);
  // performance.now() is never faked, so this is real elapsed time.
  const elapsed = performance.now() - t0;
  const pageNow = Date.now();

  const prev = new Map(a.map((c) => [c.key, c]));
  const live = b.filter((c) => {
    const p = prev.get(c.key);
    if (!p) return false;
    const d = p.remaining - c.remaining;
    return d > 0 && Math.abs(d - elapsed) <= 1200;
  });
  // Labeled countdowns without a seconds field only change once a minute; take
  // one with 3+ fields that stayed exactly the same (not a count-up timer).
  const steady = b.filter((c) => {
    const p = prev.get(c.key);
    return c.kind === 'label' && c.parts >= 3 && p && p.remaining === c.remaining;
  });
  const pick = live.sort((x, y) => y.parts - x.parts)[0] || steady.sort((x, y) => y.parts - x.parts)[0] || null;

  // Drop hints whose text changed between samples (a live "09:15:22 UTC" clock).
  const aHints = new Set(utcHints(aText, pageNow).map((h) => h.text));
  const hints = utcHints(bText, pageNow).filter((h) => aHints.has(h.text));

  return {
    pageNow,
    remaining: pick ? pick.remaining : null,
    unit: pick ? pick.unit : null,
    live: !!(pick && live.includes(pick)),
    hints: hints.map(({ at, text }) => ({ at, text })),
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
    name.textContent = host || 'file://';
    const desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = describe(cfg);
    info.append(name, desc);
    const rm = document.createElement('button');
    rm.textContent = '✕';
    rm.title = 'Xoá';
    rm.addEventListener('click', async () => {
      delete state.sites[host];
      await chrome.storage.local.set({ sites: state.sites });
      await syncInjectRegistration().catch(() => {});
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

// Returns false when the page can't be scripted (error page, Web Store, …).
async function pushToTab(cfg) {
  try {
    if (cfg) {
      // Tabs loaded while the site was off have no inject.js yet.
      await chrome.scripting.executeScript({
        target: { tabId: state.tab.id, allFrames: true },
        world: 'MAIN',
        files: ['src/inject.js'],
      });
    }
    const res = await chrome.scripting.executeScript({
      target: { tabId: state.tab.id, allFrames: true },
      func: pushConfig,
      args: [KEY, cfg],
    });
    return res.some((r) => r.result === true);
  } catch {
    return false;
  }
}

// Runs detectCountdown in every frame: a running countdown in any frame wins,
// then a steady one, then the first "HH:MM UTC" hint.
async function runDetect(sampleMs = 1500) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: state.tab.id, allFrames: true },
    world: 'MAIN',
    func: detectCountdown,
    args: [sampleMs],
  });
  const rs = results.map((r) => r.result).filter(Boolean);
  const r = rs.find((x) => x.live) || rs.find((x) => x.remaining != null) || rs.find((x) => x.hints.length) || rs[0] || null;
  if (r && r.remaining != null && r.live) {
    // Page clock may be faked: keep "remaining" against real time for verify().
    state.lastDetect = { remaining: r.remaining, realAt: Date.now() };
  }
  return r;
}

function targetFrom(r) {
  if (r.remaining != null) {
    // A countdown without seconds can be up to one unit later than shown.
    const end = r.pageNow + r.remaining + (r.unit > 1e3 ? r.unit : 0);
    // Snap to "HH:MM UTC" text that agrees with the countdown, but never earlier.
    const hint = r.hints.find((h) => Math.abs(h.at - end) < 90e3);
    return {
      target: (hint ? Math.max(hint.at, end) : end) + BUFFER,
      msg: `Countdown còn ${fmtDuration(r.remaining)}${r.live ? '' : ' (không thấy chạy)'}${hint ? ` · khớp "${hint.text}"` : ''}`,
      hint,
    };
  }
  const hint = r.hints[0];
  return { target: hint.at + BUFFER, msg: `Theo dòng chữ "${hint.text}"`, hint };
}

function detect({ auto = false, prefill = true } = {}) {
  $('detectMsg').textContent = 'Đang dò countdown…';
  const job = (async () => {
    let r;
    try {
      r = await runDetect();
    } catch (e) {
      $('detectMsg').textContent = `Không đọc được trang: ${e.message}`;
      return null;
    }
    if (!r || (r.remaining == null && !r.hints.length)) {
      $('detectMsg').textContent = !prefill
        ? 'Không thấy countdown trên trang.'
        : auto
          ? 'Không tự dò được countdown — nhập mốc bằng tay (ví dụ tick UTC rồi nhập giờ mở).'
          : 'Không tìm thấy countdown (dạng 05:31:42 hoặc Days/Hours/Minutes/Seconds) hay giờ "UTC" trên trang.';
      return r;
    }
    const { target, msg, hint } = targetFrom(r);
    // Auto-detect never overwrites what the user already changed.
    if (prefill && !(auto && state.touched)) {
      state.target = target;
      state.detectedTarget = target;
      setMode('absolute');
      if (hint) setUtc(true);
      else renderTarget();
      $('detectMsg').textContent = `${msg} → mốc ${fmt(target)}`;
    } else {
      $('detectMsg').textContent = `${msg} → gợi ý mốc ${fmt(target)} (bấm Dò countdown để dùng)`;
    }
    return r;
  })();
  const tracked = job.finally(() => {
    if (state.detecting === tracked) state.detecting = null;
  });
  state.detecting = tracked;
  return job;
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
async function verify(cfg, before, reloaded) {
  setMsg('Đang kiểm tra trang…');
  await sleep(1500);
  let r;
  try {
    r = await runDetect(1500);
  } catch (e) {
    setMsg(`Đã bật: ${describe(cfg)}. Không kiểm tra được trang (${e.message}).`);
    return;
  }
  if (!r || r.remaining == null) {
    if (before) setMsg(`Đã bật: ${describe(cfg)}. Countdown trên trang đã hết.`, 'ok');
    else setMsg(`Đã bật: ${describe(cfg)}. Không thấy countdown nào để kiểm tra — xem trang để chắc chắn.`);
    return;
  }
  const left = fmtDuration(r.remaining);
  if (!r.live) {
    setMsg(`Trang vẫn hiện còn ${left} (không thấy chạy). Có thể cần mốc muộn hơn — xem lại trang.`, 'err');
    return;
  }
  const unchanged = before && Math.abs(before.remaining - (Date.now() - before.realAt) - r.remaining) < 5000;
  if (unchanged && !reloaded) {
    setMsg(`Trang chưa phản ứng (vẫn còn ${left}). Tải lại trang (F5) hoặc bật "Tải lại trang sau khi áp dụng".`, 'err');
  } else if (unchanged) {
    setMsg(
      `Trang vẫn đếm ngược y như cũ (còn ${left}). Trang này lấy giờ từ server/API (hoặc nguồn ngoài trình duyệt), extension không qua được.`,
      'err',
    );
  } else if (!before) {
    setMsg(
      `Trang vẫn còn ${left}. Mốc chưa đủ xa, hoặc trang lấy giờ từ server/API — bấm Dò countdown rồi Áp dụng lại để biết chắc.`,
      'err',
    );
  } else {
    setMsg(`Trang vẫn còn ${left}. Mốc chưa đủ xa — hãy chọn mốc muộn hơn (hoặc bấm Dò countdown rồi Áp dụng).`, 'err');
  }
}

// Baseline for verify(). Must run before the new config is stored: bridge.js
// pushes it into the page on storage.onChanged, and a sample taken across
// that clock jump doesn't look like a running countdown.
async function takeBaseline() {
  if (state.detecting) await state.detecting;
  if (!state.lastDetect) {
    setMsg('Đang đọc countdown hiện tại…');
    await runDetect(1500).catch(() => null);
  }
}

async function afterChange(cfg) {
  const reload = $('reload').checked;
  const before = state.lastDetect;
  const { prefs = {} } = await chrome.storage.local.get('prefs');
  await chrome.storage.local.set({ prefs: { ...prefs, reload } });
  await syncInjectRegistration();
  const pushed = await pushToTab(cfg);
  if (cfg && !pushed) {
    setMsg('Không chạy được trên trang này (trang lỗi, Chrome Web Store, file:// chưa cho phép…).', 'err');
    return;
  }
  await chrome.action.setBadgeText({ tabId: state.tab.id, text: cfg ? 'ON' : '' });
  renderPill();
  renderSites();
  if (reload) {
    const loaded = waitTabComplete(state.tab.id);
    await chrome.tabs.reload(state.tab.id);
    await loaded;
  }
  await refreshPageClock();
  if (cfg) await verify(cfg, before, reload);
}

async function apply() {
  const realNow = Date.now();
  const cfg = {
    enabled: true,
    mode: state.mode,
    target: state.target,
    offset: offsetFromInputs(),
    updatedAt: realNow,
  };
  if (cfg.mode === 'absolute') {
    if (!Number.isFinite(cfg.target)) {
      setMsg('Mốc thời gian không hợp lệ.', 'err');
      return;
    }
    const delta = cfg.target - realNow;
    if (Math.abs(delta) < 120e3 && cfg.target !== state.detectedTarget) {
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
  await takeBaseline();
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

async function peel(action) {
  $('peelMsg').textContent = '';
  let res;
  try {
    [res] = await chrome.scripting.executeScript({
      target: { tabId: state.tab.id },
      func: peelPage,
      args: [action],
    });
  } catch (e) {
    $('peelMsg').textContent = `Không chạy được trên trang này: ${e.message}`;
    return;
  }
  const r = res.result || {};
  if (action === 'zap') {
    window.close(); // hand focus back to the page
  } else if (action === 'restore') {
    $('peelMsg').textContent = `Đã hiện lại ${r.restored || 0} lớp.`;
  } else if (r.hidden || r.unblurred) {
    $('peelMsg').textContent = `Đã gỡ ${r.hidden} lớp phủ, bỏ làm mờ ${r.unblurred} phần. Lớp nào còn sót thì dùng "Chọn để gỡ…".`;
  } else {
    $('peelMsg').textContent = 'Không thấy lớp phủ ở giữa màn hình. Dùng "Chọn để gỡ…" rồi bấm vào lớp cần ẩn.';
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
    state.target = Number.isFinite(cfg.target) ? cfg.target : Date.now() + 36e5;
    fillOffsetInputs(cfg.offset || 0);
  } else {
    state.target = Math.ceil(Date.now() / 6e4) * 6e4 + 36e5;
  }
  renderTarget();
  renderPill();

  const touch = () => {
    state.touched = true;
  };
  $('tabAbs').addEventListener('click', () => (touch(), setMode('absolute')));
  $('tabOff').addEventListener('click', () => (touch(), setMode('offset')));
  ['offD', 'offH', 'offM'].forEach((id) => $(id).addEventListener('input', touch));
  $('target').addEventListener('change', () => {
    touch();
    state.target = fromInput($('target').value, state.utc);
  });
  $('utc').addEventListener('change', () => {
    touch();
    setUtc($('utc').checked);
    chrome.storage.local.get('prefs').then(({ prefs = {} }) => chrome.storage.local.set({ prefs: { ...prefs, utc: state.utc } }));
  });
  document.querySelectorAll('[data-add]').forEach((btn) =>
    btn.addEventListener('click', () => {
      touch();
      const add = Number(btn.dataset.add);
      state.target = add === 0 ? Date.now() : (Number.isFinite(state.target) ? state.target : Date.now()) + add;
      renderTarget();
    }),
  );
  $('detect').addEventListener('click', () => detect());
  $('apply').addEventListener('click', () => {
    touch();
    apply().catch((e) => setMsg(e.message, 'err'));
  });
  $('disable').addEventListener('click', () => {
    touch();
    disable().catch((e) => setMsg(e.message, 'err'));
  });
  $('peelAuto').addEventListener('click', () => peel('auto'));
  $('peelZap').addEventListener('click', () => peel('zap'));
  $('peelRestore').addEventListener('click', () => peel('restore'));

  await refreshPageClock();
  setInterval(renderClock, 250);

  // Read the page's countdown: prefill the target when the site isn't enabled
  // yet; otherwise only report it (and keep it as verify()'s baseline).
  detect({ auto: true, prefill: !cfg });
}

init().catch((e) => setMsg(e.message, 'err'));
