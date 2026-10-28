import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
const EXT = process.env.EXT || new URL('../../countdown-peek', import.meta.url).pathname; const PORT = 8871;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/ping') { res.writeHead(204); return res.end(); }
  if (u.pathname === '/api/time') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ now: Date.now() })); }
  const p = path.join('site', u.pathname);
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(fs.readFileSync(p));
}).listen(PORT);
const ctx = await chromium.launchPersistentContext('', { executablePath: process.env.CHROMIUM, channel: process.env.CHROMIUM ? undefined : 'chromium', headless: true, viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const errors = [];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const clearSites = async () => { await sw.evaluate(async () => { await chrome.storage.local.set({ sites: {} }); await syncInjectRegistration(); }); };
async function openPopup(glob) {
  const popup = await ctx.newPage();
  popup.on('pageerror', (e) => errors.push('popup: ' + e.message));
  await popup.addInitScript((g) => { const q = chrome.tabs.query.bind(chrome.tabs); chrome.tabs.query = () => q({ url: g }); }, glob);
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  return popup;
}
const waitText = (pg, sel, re, timeout = 20000) => pg.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s).textContent), [sel, re.source], { timeout }).then(() => true, () => false);
const H = 5 * 3600e3 + 31 * 60e3 + 42e3;

// 1-3: days prefix, flex digits, shadow root are detected and unlocked
for (const [fmt, extra, re] of [['days', 2 * 864e5, /Countdown còn 2d 5h 31m/], ['flex', 0, /Countdown còn 0d 5h 31m/], ['shadow', 0, /Countdown còn 0d 5h 31m/]]) {
  await clearSites();
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(fmt + ': ' + e.message));
  await page.goto(`http://localhost:${PORT}/cd2.html?fmt=${fmt}&t=${Date.now() + H + extra}`);
  const popup = await openPopup(`http://localhost:${PORT}/cd2.html*`);
  await waitText(popup, '#detectMsg', /mốc|dò được/);
  const dm = await popup.textContent('#detectMsg'); console.log('   ', fmt, dm);
  ok(re.test(dm), `[${fmt}] detected`);
  await popup.click('#apply'); await waitText(popup, '#msg', /đã hết|vẫn|Không thấy/);
  console.log('   ', await popup.textContent('#msg'));
  ok(await page.isVisible('#secret'), `[${fmt}] unlocked`);
  await popup.close(); await page.close();
}

// 4: decrement-only countdown + reload unchecked -> "chưa phản ứng"
{
  await clearSites();
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/cd2.html?fmt=decr&t=${Date.now() + H}`);
  const popup = await openPopup(`http://localhost:${PORT}/cd2.html*`);
  await waitText(popup, '#detectMsg', /mốc/);
  await popup.uncheck('#reload');
  await popup.click('#apply'); await waitText(popup, '#msg', /đã hết|vẫn|chưa phản ứng|Không thấy/);
  const msg = await popup.textContent('#msg'); console.log('   ', msg);
  ok(/chưa phản ứng/.test(msg), '[decr/no reload] suggests reload instead of server/API');
  await popup.check('#reload'); await popup.close(); await page.close();
  await sw.evaluate(async () => { const { prefs = {} } = await chrome.storage.local.get('prefs'); await chrome.storage.local.set({ prefs: { ...prefs, reload: true } }); });
}

// 5: near launch (90 s) detected target is accepted
{
  await clearSites();
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/cd2.html?fmt=colon&t=${Date.now() + 90e3}`);
  const popup = await openPopup(`http://localhost:${PORT}/cd2.html*`);
  await waitText(popup, '#detectMsg', /mốc/);
  await popup.click('#apply'); await waitText(popup, '#msg', /đã hết|vẫn|gần bằng|Không thấy/);
  const msg = await popup.textContent('#msg'); console.log('   ', msg);
  ok(/đã hết/.test(msg), '[near] detected target <2min accepted');
  await popup.close(); await page.close();
}

// 6: auto-detect does not overwrite a user change
{
  await clearSites();
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/hoodora.html?t=${Date.now() + H}`);
  const popup = await openPopup(`http://localhost:${PORT}/hoodora.html*`);
  await popup.click('[data-add="604800000"]');
  const typed = await popup.inputValue('#target');
  await waitText(popup, '#detectMsg', /gợi ý|mốc/);
  ok((await popup.inputValue('#target')) === typed, 'user change kept: ' + (await popup.textContent('#detectMsg')));
  await popup.close(); await page.close();
}

// 7: removing a site with its tab closed -> next visit runs on real time from the first script
{
  await clearSites();
  const target = Date.now() + 2 * 3600e3;
  let page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/countdown.html?t=${target}`);
  let popup = await openPopup(`http://localhost:${PORT}/countdown.html*`);
  await waitText(popup, '#detectMsg', /mốc/);
  await popup.click('#apply'); await waitText(popup, '#msg', /đã hết|vẫn|Không thấy/);
  ok(await page.evaluate(() => window.__early) >= target, 'enabled: early script on fake time');
  await popup.close(); await page.close();
  const other = await ctx.newPage(); await other.goto(`http://127.0.0.1:${PORT}/clock.html`);
  popup = await openPopup(`http://127.0.0.1:${PORT}/clock.html*`);
  await popup.waitForSelector('#sites li');
  await popup.click('#sites li button'); await popup.waitForTimeout(500);
  await popup.close(); await other.close();
  page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/countdown.html?t=${target}`);
  const early = await page.evaluate(() => window.__early);
  ok(Math.abs(early - Date.now()) < 5000, `removed site: early script on real time (diff ${early - Date.now()} ms)`);
  ok(await page.evaluate(() => Date.toString().includes('[native code]') && !Object.keys(Date).length), 'removed site: Date not patched');
  await page.close();
}

// 8: Headers — page-built Headers untouched, response headers shifted incl. iteration; Date statics non-enumerable
{
  await clearSites();
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/countdown.html?t=${Date.now() + 3600e3}`);
  await sw.evaluate(async () => { await chrome.storage.local.set({ sites: { localhost: { enabled: true, mode: 'offset', offset: 864e5, updatedAt: 1 } } }); await syncInjectRegistration(); });
  await page.reload(); await page.waitForTimeout(300);
  const r = await page.evaluate(async () => {
    const res = await fetch('/ping', { cache: 'no-store' });
    const g = Date.parse(res.headers.get('date')) - Date.now();
    const it = Date.parse(Object.fromEntries(res.headers).date) - Date.now();
    let fe; res.headers.forEach((v, k) => { if (k === 'date') fe = Date.parse(v) - Date.now(); });
    const own = new Headers({ date: 'Thu, 01 Jan 2015 00:00:00 GMT' }).get('date');
    return { g, it, fe, own, keys: Object.keys(Date), shift: Date.now() - performance.timeOrigin - performance.now() };
  });
  console.log('   ', JSON.stringify(r));
  ok(Math.abs(r.g) < 3000 && Math.abs(r.it) < 3000 && Math.abs(r.fe) < 3000, 'response Date header shifted for get/iteration/forEach');
  ok(r.own === 'Thu, 01 Jan 2015 00:00:00 GMT', 'page-built Headers untouched');
  ok(r.keys.length === 0, 'Date statics non-enumerable');
  ok(Math.abs(r.shift) < 50, 'timeOrigin + performance.now() matches fake Date.now()');
  await page.close();
}

// 9: peel overlay from the popup, then restore
{
  await clearSites();
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/maint.html?rerender=1`);
  const popup = await openPopup(`http://localhost:${PORT}/maint.html*`);
  await popup.click('#peelAuto'); await waitText(popup, '#peelMsg', /Đã gỡ|Không thấy/);
  console.log('   ', await popup.textContent('#peelMsg'));
  await page.waitForTimeout(2500);
  ok(!(await page.isVisible('.modal')) && (await page.evaluate(() => getComputedStyle(document.getElementById('app')).filter)) === 'none', 'peel: overlay hidden, content unblurred (survives re-render)');
  await popup.click('#peelRestore'); await waitText(popup, '#peelMsg', /hiện lại/);
  ok(await page.isVisible('.modal'), 'peel: restore');
  await popup.close(); await page.close();
}

// 10: utc hint parsing (unit test inside the popup page)
{
  const popup = await openPopup(`http://localhost:${PORT}/nothing*`);
  const cases = await popup.evaluate(async () => {
    const out = {};
    const T = ['Hoodora opens at 17:00 UTC.', 'Launch: 2026-11-05 17:00:00 UTC', 'Opens 5 PM UTC', 'Starts 17:00 (UTC)', 'UTC 17:00 start', 'Season 2 UTC event — opens 17:00 UTC', 'at 16:00 UTC+7', '17:00 UTC - 20:00 UTC'];
    for (const t of T) { document.body.innerText = t; const r = await detectCountdown(50); out[t] = r.hints.map((h) => new Date(h.at).toISOString().slice(0, 16)); }
    return out;
  });
  console.log('   ', JSON.stringify(cases, null, 1));
  const hhmm = (k) => (cases[k][0] || '').slice(11);
  ok(hhmm('Hoodora opens at 17:00 UTC.') === '17:00' && cases['Launch: 2026-11-05 17:00:00 UTC'][0] === '2026-11-05T17:00' && hhmm('Opens 5 PM UTC') === '17:00'
    && hhmm('Starts 17:00 (UTC)') === '17:00' && hhmm('UTC 17:00 start') === '17:00' && hhmm('Season 2 UTC event — opens 17:00 UTC') === '17:00'
    && hhmm('at 16:00 UTC+7') === '09:00' && hhmm('17:00 UTC - 20:00 UTC') === '17:00', 'utc hint variants');
  await popup.close();
}

// 11: Apply pressed while auto-detect is still sampling, on a server-time page
for (const pre of [false, true]) {
  await clearSites();
  if (pre) await sw.evaluate(async () => { await chrome.storage.local.set({ sites: { localhost: { enabled: true, mode: 'absolute', target: Date.now() - 3600e3, updatedAt: 1 } } }); await syncInjectRegistration(); });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/hoodora.html?mode=api&t=${Date.now() + H}`);
  await page.waitForTimeout(500);
  const popup = await openPopup(`http://localhost:${PORT}/hoodora.html*`);
  await popup.waitForSelector('#detect');
  await popup.click('[data-add="604800000"]');
  await popup.click('#apply');
  await waitText(popup, '#msg', /đã hết|vẫn|chưa phản ứng|Không thấy/, 30000);
  const msg = await popup.textContent('#msg'); console.log('   ', msg);
  ok(/server\/API/.test(msg) && /y như cũ/.test(msg), `[apply during auto-detect, preEnabled=${pre}] reports server/API time`);
  await popup.close(); await page.close();
}

// Opening time on a whole minute, so the page's "opens at HH:MM UTC" text matches it exactly.
const opening = () => Math.ceil(Date.now() / 6e4) * 6e4 + 5 * 3600e3 + 31 * 60e3;
const utcIn = (ms) => new Date(ms).toISOString().slice(0, 19);
const storedTarget = () => sw.evaluate(async () => { const { sites = {} } = await chrome.storage.local.get('sites'); return sites.localhost ? sites.localhost.target : null; });
const DONE = /đã hết|Trang vẫn|chưa phản ứng|Không thấy|trước giờ mở|gần bằng/;

// 12: site enabled with a target that is too early: the popup refills the detected one
{
  await clearSites();
  const T = opening();
  await sw.evaluate(async (t) => { await chrome.storage.local.set({ sites: { localhost: { enabled: true, mode: 'absolute', target: t, updatedAt: 1 } } }); await syncInjectRegistration(); }, Date.now() + 3600e3);
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push('stale: ' + e.message));
  await page.goto(`http://localhost:${PORT}/hoodora.html?t=${T}`);
  await page.waitForTimeout(500);
  // The config was written straight to storage, so this first load may run on
  // an older test's localStorage mirror. bridge.js has rewritten it by now;
  // reload, as on a page the user had already loaded with this target.
  const firstLoadUnlocked = await page.isVisible('#secret');
  await page.reload(); await page.waitForTimeout(500);
  const gated = await page.isHidden('#secret');
  const popup = await openPopup(`http://localhost:${PORT}/hoodora.html*`);
  await waitText(popup, '#detectMsg', /mốc|Không thấy/);
  const dm = await popup.textContent('#detectMsg'); const input = await popup.inputValue('#target');
  console.log('   first load unlocked:', firstLoadUnlocked, '| gated after reload:', gated, '|', dm, '| input:', input);
  ok(gated && /đã điền mốc mới/.test(dm) && input === utcIn(T + 2000) && await popup.isChecked('#utc'), `[stale target] popup refills ${utcIn(T + 2000)} UTC`);
  await popup.click('#apply'); await waitText(popup, '#msg', DONE, 30000);
  const msg = await popup.textContent('#msg'); console.log('   ', msg);
  ok(/đã hết/.test(msg) && (await storedTarget()) === T + 2000 && await page.isVisible('#secret'), '[stale target] apply stores it and unlocks the page');
  await popup.close(); await page.close();
}

// 13: Apply clicked while auto-detect is still sampling, site not enabled yet
{
  await clearSites();
  const T = opening();
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push('early-apply: ' + e.message));
  await page.goto(`http://localhost:${PORT}/hoodora.html?t=${T}`);
  await page.waitForTimeout(500);
  const popup = await openPopup(`http://localhost:${PORT}/hoodora.html*`);
  await waitText(popup, '#detectMsg', /Đang dò/);
  const before = await popup.inputValue('#target');
  const sampling = await popup.evaluate(() => !!state.detecting);
  await popup.click('#apply'); await waitText(popup, '#msg', DONE, 30000);
  const msg = await popup.textContent('#msg'); const saved = await storedTarget();
  console.log('   input at click:', before, '| saved:', saved && utcIn(saved), '|', msg);
  ok(sampling && saved === T + 2000 && /đã hết/.test(msg) && await page.isVisible('#secret'), '[apply while detecting] uses the detected target, not the now+1h default');
  await popup.close(); await page.close();
}

// 14: a typed target before the opening time is refused and replaced by the detected one
{
  await clearSites();
  const T = opening();
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push('early-target: ' + e.message));
  await page.goto(`http://localhost:${PORT}/hoodora.html?t=${T}`);
  await page.waitForTimeout(500);
  const popup = await openPopup(`http://localhost:${PORT}/hoodora.html*`);
  await waitText(popup, '#detectMsg', /mốc/);
  const utc = await popup.isChecked('#utc');
  await popup.fill('#target', utcIn(T - 30 * 60e3 + 5e3));
  await popup.dispatchEvent('#target', 'change');
  await popup.click('#apply'); await waitText(popup, '#msg', DONE);
  const msg = await popup.textContent('#msg'); const input = await popup.inputValue('#target'); const saved = await storedTarget();
  console.log('   ', msg, '| input:', input);
  ok(utc && /trước giờ mở/.test(msg) && input === utcIn(T + 2000) && saved === null, '[early target] refused, input replaced by the detected target, nothing saved');
  await popup.click('#apply'); await waitText(popup, '#msg', /đã hết|Trang vẫn|chưa phản ứng|Không thấy/, 30000);
  const msg2 = await popup.textContent('#msg'); console.log('   ', msg2);
  ok(/đã hết/.test(msg2) && (await storedTarget()) === T + 2000 && await page.isVisible('#secret'), '[early target] second apply unlocks');
  await popup.close(); await page.close();
}

// 15: snapping to the "HH:MM UTC" text absorbs the countdown's ~1 s reading error, nothing more
{
  const popup = await openPopup(`http://localhost:${PORT}/nothing*`);
  const r = await popup.evaluate(() => {
    const X = Date.UTC(2026, 10, 5, 17, 0);
    const t = (lo, unit = 1e3) => targetFrom({ pageNow: lo - 3600e3, remaining: 3600e3, unit, live: true, hints: [{ at: X, text: '17:00 UTC' }] }).target - X;
    return { before: t(X - 800), after1200: t(X + 1200), after1500: t(X + 1500), after3000: t(X + 3000), minutes: t(X - 30e3, 6e4) };
  });
  console.log('   ', JSON.stringify(r));
  ok(r.before === 2000 && r.after1200 === 2000 && r.after1500 === 2000 && r.after3000 === 5000 && r.minutes === 32000, 'snap: text time within 1.5 s, countdown end otherwise');
  await popup.close();
}

ok(errors.length === 0, 'no page errors ' + JSON.stringify(errors));
await ctx.close(); srv.close();
