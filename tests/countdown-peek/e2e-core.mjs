import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
const EXT = process.env.EXT || new URL('../../countdown-peek', import.meta.url).pathname;
const srv = http.createServer((req, res) => {
  const p = path.join('site', new URL(req.url, 'http://x').pathname);
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {'content-type':'text/html'}); res.end(fs.readFileSync(p));
}).listen(8865);
const ctx = await chromium.launchPersistentContext('', { executablePath: process.env.CHROMIUM, channel: process.env.CHROMIUM ? undefined : 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const errors = [];
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const realNow = Date.now();
const target = realNow + 2*3600e3 + 4*60e3 + 28e3;
const url = `http://localhost:8865/countdown.html?t=${target}`;
const page = await ctx.newPage();
page.on('pageerror', e => errors.push(e.message));
await page.goto(url);
await page.waitForTimeout(500);
ok(await page.isHidden('#secret'), 'baseline: secret hidden without config');
ok(await page.evaluate(() => Date.toString().includes('[native code]') && Date.name === 'Date'), 'baseline Date untouched');

// --- popup flow: stub tabs.query to point at the test tab ---
const popup = await ctx.newPage();
popup.on('pageerror', e => errors.push('popup: ' + e.message));
await popup.addInitScript(() => {
  const q = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = () => q({ url: 'http://localhost:8865/*' });
});
await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
await popup.waitForTimeout(500);
ok((await popup.textContent('#host')) === 'localhost', 'popup shows host');
await popup.waitForFunction(() => /mốc/.test(document.querySelector('#detectMsg').textContent), null, { timeout: 15000 });
await popup.click('#detect');
await popup.waitForFunction(() => /mốc/.test(document.querySelector('#detectMsg').textContent), null, { timeout: 15000 });
const detMsg = await popup.textContent('#detectMsg');
console.log('  detect:', detMsg);
ok(/2h 4m 2\ds/.test(detMsg), 'detect countdown remaining ≈ 2h 4m 2Xs');
await popup.check('#utc');
console.log('  input (UTC):', await popup.inputValue('#target'));
await popup.click('#apply');
await popup.waitForFunction(() => /đã hết|vẫn|Không thấy countdown/.test(document.querySelector('#msg').textContent), null, { timeout: 20000 });
console.log('  msg:', await popup.textContent('#msg'), '| clock:', await popup.textContent('#pageClock'), '| pill:', await popup.textContent('#pill'));
ok((await popup.textContent('#pill')) === 'ON', 'pill ON');

await page.waitForLoadState('load');
await page.waitForTimeout(500);
ok(await page.isVisible('#secret'), 'after apply+reload: secret visible');
const info = await page.evaluate(() => ({
  early: window.__early, now: Date.now(), newD: +new Date(), str: Date(),
  inst: new Date() instanceof Date, ctor: new Date().constructor === Date,
  nativeStr: Date.toString(), nowStr: Date.now.toString(), len: Date.length,
  parsed: new Date(0).getTime(), args: new Date(2020, 0, 1).getFullYear(),
  intl: new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: 'UTC' }).format(),
  parts: new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'UTC' }).formatToParts()[0].value,
  fmtSame: (() => { const f = new Intl.DateTimeFormat(); return f.format === f.format; })(),
  sub: (() => { class X extends Date {} ; const x = new X(); return x instanceof X && x instanceof Date && Math.abs(+x - Date.now()) < 50; })(),
  frame: document.getElementById('fr').contentWindow.frameNow(),
  ls: localStorage.getItem('__countdown_peek__') != null,
}));
console.log('  ', JSON.stringify(info));
ok(info.early >= target && info.early < target + 5000, 'inline head script already sees fake time (sync path)');
ok(info.now >= target, 'Date.now fake');
ok(Math.abs(info.newD - info.now) < 50, 'new Date() fake');
ok(info.inst && info.ctor, 'instanceof / constructor');
ok(info.nativeStr === 'function Date() { [native code] }' && info.nowStr === 'function now() { [native code] }', 'toString disguised');
ok(info.len === 7 && info.parsed === 0 && info.args === 2020, 'Date semantics preserved');
ok(info.intl === String(new Date(target).getUTCFullYear()), 'Intl format() uses fake time');
ok(Number(info.parts) === new Date(target).getUTCHours() || Number(info.parts) === new Date(target + 5000).getUTCHours(), 'formatToParts uses fake time');
ok(info.fmtSame && info.sub, 'format cached / subclassing ok');
ok(info.frame >= target, 'iframe fake time');
const t1 = await page.evaluate(() => Date.now()); await page.waitForTimeout(1000); const t2 = await page.evaluate(() => Date.now());
ok(t2 - t1 >= 900 && t2 - t1 < 1500, 'clock keeps ticking');

// badge
const badge = await sw.evaluate(async () => { const [t] = await chrome.tabs.query({ url: 'http://localhost:8865/*' }); return chrome.action.getBadgeText({ tabId: t.id }); });
ok(badge === 'ON', 'badge ON');

// freeze + offset mode
await popup.reload(); await popup.waitForTimeout(500);
await popup.click('#tabOff');
await popup.fill('#offD', '1'); await popup.fill('#offH', '0'); await popup.fill('#offM', '0');
await popup.click('#apply'); await popup.waitForFunction(() => /đã hết|vẫn|Không thấy countdown/.test(document.querySelector('#msg').textContent), null, { timeout: 20000 });
await page.waitForLoadState('load');
const f1 = await page.evaluate(() => Date.now()); await page.waitForTimeout(700); const f2 = await page.evaluate(() => Date.now());
ok(f2 - f1 >= 600 && Math.abs(f1 - (Date.now() + 864e5)) < 5000, 'offset +1d ticking');

page.on('console', m => console.log('  console:', m.text())); await page.evaluate(() => window.addEventListener('__countdown_peek_update__', e => console.log('main got', String(e.detail).slice(0, 60))));
await sw.evaluate(async () => { const { sites } = await chrome.storage.local.get('sites'); sites.localhost = { enabled: true, mode: 'offset', offset: -864e5, freeze: false, updatedAt: Date.now() }; await chrome.storage.local.set({ sites }); });
await page.waitForTimeout(500);
const live = await page.evaluate(() => Date.now());
console.log('  live diff', live - Date.now(), await page.evaluate(() => localStorage.getItem('__countdown_peek__'))); ok(Math.abs(live - (Date.now() - 864e5)) < 5000, 'live update from storage without reload');

// disable
await popup.reload(); await popup.waitForTimeout(500);
await popup.click('#disable'); await popup.waitForTimeout(1500);
await page.waitForLoadState('load'); await page.waitForTimeout(300);
const off = await page.evaluate(() => ({ d: Date.now(), n: Date.toString(), ls: localStorage.getItem('__countdown_peek__') }));
ok(Math.abs(off.d - Date.now()) < 2000 && off.n === 'function Date() { [native code] }' && off.ls === null, 'disabled: real clock, no patch, localStorage cleared');
ok(await page.isHidden('#secret'), 'disabled: secret hidden again');

ok(errors.length === 0, 'no page errors ' + JSON.stringify(errors));
await ctx.close(); srv.close();
