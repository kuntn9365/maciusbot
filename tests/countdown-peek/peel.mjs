import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
const PORT = 8790;
const srv = http.createServer((req, res) => { const p = path.join('site', new URL(req.url, 'http://x').pathname); res.writeHead(200, {'content-type':'text/html'}); res.end(fs.existsSync(p)?fs.readFileSync(p):''); }).listen(PORT);
const src = fs.readFileSync(new URL('../../countdown-peek/popup/peel.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const vis = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return 'missing'; const cs = getComputedStyle(e); return cs.display !== 'none' && e.getClientRects().length > 0; }, sel);
const run = (page, a) => page.evaluate(`(${src})(${JSON.stringify(a)})`);
for (const q of ['', 'layout=2', 'rerender=1', 'layout=2&rerender=1']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://localhost:${PORT}/maint.html?${q}`);
  const r = await run(page, 'auto');
  const st = await page.evaluate(() => { const a = getComputedStyle(document.getElementById('app')); return { filter: a.filter, op: a.opacity, pe: a.pointerEvents, ov: getComputedStyle(document.body).overflow }; });
  const modalSel = q.includes('layout=2') ? '.modal2' : '.modal';
  ok(r.hidden >= 1 && !(await vis(page, modalSel)) && (q.includes('layout=2') ? !(await vis(page, '.bd2')) : true), `[${q || 'default'}] overlay hidden (${JSON.stringify(r)})`);
  ok(st.filter === 'none' && st.op === '1' && st.pe === 'auto' && st.ov === 'auto', `[${q || 'default'}] content unblurred/unlocked ${JSON.stringify(st)}`);
  ok(await vis(page, 'header'), `[${q || 'default'}] fixed header kept`);
  await page.click('#play'); ok((await page.title()) === 'clicked', `[${q || 'default'}] content clickable`);
  if (q.includes('rerender')) { await page.waitForTimeout(2500); ok(!(await vis(page, modalSel)), `[${q}] stays hidden after remount`); }
  const r2 = await run(page, 'auto'); ok(r2.hidden === 0, `[${q || 'default'}] second auto is a no-op`);
  await run(page, 'restore'); await page.waitForTimeout(100);
  ok(await vis(page, modalSel), `[${q || 'default'}] restore brings overlay back`);
  ok(errs.length === 0, `[${q || 'default'}] no errors ${errs}`);
  await page.close();
}
// zap
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://localhost:${PORT}/maint.html?layout=2`);
  await run(page, 'zap');
  ok(await page.evaluate(() => !!document.querySelector('[data-cp-ui]')), 'zap: UI shown');
  await page.mouse.move(640, 400); await page.mouse.click(640, 400);
  ok(!(await vis(page, '.modal2')), 'zap: clicked modal hidden');
  await page.mouse.move(100, 600); await page.mouse.click(100, 600);
  ok(!(await vis(page, '.bd2')), 'zap: clicked backdrop hidden');
  ok((await page.title()) !== 'clicked', 'zap: clicks do not reach page');
  await page.keyboard.press('Escape');
  ok(await page.evaluate(() => document.querySelectorAll('div[data-cp-ui]').length === 0), 'zap: Esc removes UI');
  await page.click('#play'); ok((await page.title()) === 'clicked', 'zap: page clickable after Esc');
  await page.close();
}
// no overlay page: nothing hidden
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://localhost:${PORT}/clock.html`);
  const r = await run(page, 'auto'); ok(r.hidden === 0 && r.unblurred === 0, 'plain page untouched ' + JSON.stringify(r));
  await page.close();
}
await browser.close(); srv.close();
