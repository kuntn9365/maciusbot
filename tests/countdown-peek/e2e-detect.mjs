import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
const EXT = process.env.EXT || new URL('../../countdown-peek', import.meta.url).pathname;
const PORT = 8870;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/ping') { res.writeHead(204); return res.end(); }
  if (u.pathname === '/api/time') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ now: Date.now() })); }
  const p = path.join('site', u.pathname);
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(fs.readFileSync(p));
}).listen(PORT);
const ctx = await chromium.launchPersistentContext('', { executablePath: process.env.CHROMIUM, headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const errors = [];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const clearSites = () => sw.evaluate(() => chrome.storage.local.set({ sites: {} }));

async function openPopup(urlGlob) {
  const popup = await ctx.newPage();
  popup.on('pageerror', (e) => errors.push('popup: ' + e.message));
  await popup.addInitScript((g) => { const q = chrome.tabs.query.bind(chrome.tabs); chrome.tabs.query = () => q({ url: g }); }, urlGlob);
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  return popup;
}
const waitMsg = (popup, sel, re, timeout = 15000) => popup.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s).textContent), [sel, re.source], { timeout }).then(() => true, () => false);

const target = Math.ceil(Date.now() / 6e4) * 6e4 + (5 * 3600 + 31 * 60) * 1000;
const targetUtc = new Date(target).toISOString().slice(11, 16);

for (const mode of ['client', 'fetchdate', 'xhrdate']) {
  await clearSites();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(mode + ': ' + e.message));
  await page.goto(`http://localhost:${PORT}/hoodora.html?t=${target}&mode=${mode}`);
  await page.waitForTimeout(600);
  ok(await page.isHidden('#secret'), `[${mode}] baseline gated`);
  const popup = await openPopup(`http://localhost:${PORT}/hoodora.html*`);
  const got = await waitMsg(popup, '#detectMsg', /mốc/);
  const dm = await popup.textContent('#detectMsg');
  console.log('   detect:', dm, '| input:', await popup.inputValue('#target'), '| utc:', await popup.isChecked('#utc'));
  ok(got && /Countdown còn 0d 5h 3\dm/.test(dm) && dm.includes(`${targetUtc} UTC`), `[${mode}] auto-detect HH:MM:SS countdown, snapped to "${targetUtc} UTC"`);
  ok((await popup.inputValue('#target')).endsWith(`T${targetUtc}:02`) && await popup.isChecked('#utc'), `[${mode}] input prefilled ${targetUtc}:02 in UTC`);
  await popup.click('#apply');
  const done = await waitMsg(popup, '#msg', /đã hết|vẫn/, 20000);
  console.log('   msg:', await popup.textContent('#msg'));
  ok(done && /đã hết/.test(await popup.textContent('#msg')), `[${mode}] verify says countdown finished`);
  ok(await page.isVisible('#secret'), `[${mode}] secret visible after apply`);
  await popup.close(); await page.close();
}

// API-provided server time: extension cannot help, verify must say so.
{
  await clearSites();
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/hoodora.html?t=${target}&mode=api`);
  await page.waitForTimeout(600);
  const popup = await openPopup(`http://localhost:${PORT}/hoodora.html*`);
  await waitMsg(popup, '#detectMsg', /mốc/);
  await popup.click('#apply');
  const done = await waitMsg(popup, '#msg', /đã hết|vẫn/, 20000);
  const msg = await popup.textContent('#msg');
  console.log('   msg:', msg);
  ok(done && /server\/API/.test(msg), '[api] verify reports server/API time');
  ok(await page.isHidden('#secret'), '[api] still gated (expected)');
  await popup.close(); await page.close();
}

// Guard: target ≈ now must be refused.
{
  await clearSites();
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/hoodora.html?t=${target}`);
  const popup = await openPopup(`http://localhost:${PORT}/hoodora.html*`);
  await waitMsg(popup, '#detectMsg', /mốc/);
  await popup.click('[data-add="0"]');
  await popup.click('#apply');
  await popup.waitForTimeout(300);
  const msg = await popup.textContent('#msg');
  const sites = await sw.evaluate(async () => (await chrome.storage.local.get('sites')).sites);
  ok(/gần bằng giờ thật/.test(msg) && !sites.localhost, 'guard: target≈now refused, nothing saved');
  await popup.close(); await page.close();
}

// No false positive on a plain ticking clock.
{
  await clearSites();
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/clock.html`);
  const popup = await openPopup(`http://localhost:${PORT}/clock.html*`);
  await waitMsg(popup, '#detectMsg', /dò được|tìm thấy|mốc/);
  const dm = await popup.textContent('#detectMsg');
  console.log('   detect:', dm);
  ok(/Không tự dò được/.test(dm), 'clock page: no false countdown');
  await popup.close(); await page.close();
}

// Regression: labeled Days/Hours/Minutes/Seconds countdown (hydrex style).
{
  await clearSites();
  const t2 = Date.now() + 2 * 3600e3 + 4 * 60e3 + 28e3;
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/countdown.html?t=${t2}`);
  const popup = await openPopup(`http://localhost:${PORT}/countdown.html*`);
  await waitMsg(popup, '#detectMsg', /mốc|dò được/);
  const dm = await popup.textContent('#detectMsg');
  console.log('   detect:', dm);
  ok(/Countdown còn 0d 2h 4m 2\ds/.test(dm), 'labeled countdown still detected');
  await popup.click('#apply');
  await waitMsg(popup, '#msg', /đã hết|vẫn/, 20000);
  ok(await page.isVisible('#secret'), 'labeled: secret visible');
  await popup.close(); await page.close();
}

ok(errors.length === 0, 'no page errors ' + JSON.stringify(errors));
await ctx.close(); srv.close();
