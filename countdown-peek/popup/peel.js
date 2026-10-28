// ISOLATED world (via scripting.executeScript). Removes "coming soon" /
// "maintenance" layers sitting on top of the page and un-blurs what's behind.
// action: 'auto' | 'zap' | 'restore'
function peelPage(action) {
  const ATTR = 'data-cp-peeled';
  const S = (globalThis.__countdownPeekPeel ||= { fps: new Set(), observer: null, style: null, stop: null });

  const isUi = (el) => !!(el && el.closest && el.closest('[data-cp-ui]'));
  const skipTag = (el) => /^(CANVAS|VIDEO|IFRAME|HTML|BODY|HEAD)$/.test(el.tagName);
  const fingerprint = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim() : '';
    return `${el.tagName}.${cls}|${cls ? '' : (el.textContent || '').trim().slice(0, 60)}`;
  };

  function ensureStyle() {
    if (S.style && S.style.isConnected) return;
    S.style = document.createElement('style');
    S.style.setAttribute('data-cp-ui', '');
    S.style.textContent =
      `[${ATTR}]{display:none!important}` +
      '[data-cp-unblur]{filter:none!important;-webkit-filter:none!important;pointer-events:auto!important;user-select:auto!important}' +
      '[data-cp-unblur="2"]{opacity:1!important}' +
      '[data-cp-unlock]{overflow:auto!important}';
    (document.head || document.documentElement).append(S.style);
  }

  function hide(el) {
    if (!el || el.hasAttribute(ATTR) || isUi(el) || skipTag(el)) return false;
    el.setAttribute(ATTR, '');
    S.fps.add(fingerprint(el));
    return true;
  }

  function cover(el) {
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    return w > 0 && h > 0 ? (w * h) / (innerWidth * innerHeight) : 0;
  }

  // Walk up from `el` and return the outermost positioned layer that is still
  // small relative to the page (so the app's own full-screen root is kept).
  function overlayRoot(el) {
    const total = document.body.getElementsByTagName('*').length || 1;
    let best = null;
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (n.getElementsByTagName('*').length / total > 0.5) break;
      const cs = getComputedStyle(n);
      const z = parseInt(cs.zIndex, 10);
      const c = cover(n);
      if ((cs.position === 'fixed' && c >= 0.05) || ((cs.position === 'absolute' || cs.position === 'sticky') && z > 0 && c >= 0.25)) {
        if (!skipTag(n)) best = n;
      }
    }
    return best;
  }

  function topAt(x, y) {
    return document.elementsFromPoint(x, y).find((e) => !isUi(e) && e !== document.documentElement && e !== document.body) || null;
  }

  function unblur(root = document.body) {
    let n = 0;
    const els = root === document.body ? document.body.getElementsByTagName('*') : [root, ...root.getElementsByTagName('*')];
    for (const el of els) {
      if (el.hasAttribute('data-cp-unblur') || isUi(el)) continue;
      const cs = getComputedStyle(el);
      if (/blur\(/.test(cs.filter)) {
        el.setAttribute('data-cp-unblur', parseFloat(cs.opacity) < 1 ? '2' : '1');
        n++;
      }
    }
    for (const el of [document.documentElement, document.body]) {
      if (getComputedStyle(el).overflow.includes('hidden')) el.setAttribute('data-cp-unlock', '');
    }
    return n;
  }

  function autoPeel() {
    let hidden = 0;
    const pts = [[0.5, 0.5], [0.5, 0.35], [0.5, 0.65], [0.3, 0.5], [0.7, 0.5]];
    for (let pass = 0; pass < 12; pass++) {
      let found = false;
      for (const [fx, fy] of pts) {
        const el = topAt(innerWidth * fx, innerHeight * fy);
        const root = el && overlayRoot(el);
        if (root && hide(root)) {
          hidden++;
          found = true;
        }
      }
      if (!found) break;
    }
    // Tints with pointer-events:none don't show up in hit testing.
    const total = document.body.getElementsByTagName('*').length || 1;
    for (const el of document.body.getElementsByTagName('*')) {
      if (el.hasAttribute(ATTR) || isUi(el) || skipTag(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.pointerEvents !== 'none' || cs.display === 'none') continue;
      if (cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
      if (cover(el) >= 0.5 && el.getElementsByTagName('*').length / total <= 0.5 && hide(el)) hidden++;
    }
    return hidden;
  }

  // Frameworks may remount the gate; hide anything matching what we removed.
  function keep() {
    if (S.observer) return;
    let added = new Set();
    let changed = new Set();
    let timer = 0;
    const check = (el) => {
      if (!el.hasAttribute(ATTR) && S.fps.has(fingerprint(el))) hide(el);
      if (!el.hasAttribute('data-cp-unblur') && /blur\(/.test(getComputedStyle(el).filter)) {
        el.setAttribute('data-cp-unblur', parseFloat(getComputedStyle(el).opacity) < 1 ? '2' : '1');
      }
    };
    const flush = () => {
      timer = 0;
      ensureStyle();
      for (const node of added) {
        if (!node.isConnected) continue;
        check(node);
        const kids = node.getElementsByTagName('*');
        for (let i = 0; i < kids.length && i < 3000; i++) check(kids[i]);
      }
      for (const el of changed) if (el.isConnected) check(el);
      added = new Set();
      changed = new Set();
    };
    S.observer = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'childList') {
          m.addedNodes.forEach((n) => n.nodeType === 1 && !isUi(n) && added.add(n));
        } else if (!isUi(m.target)) {
          changed.add(m.target);
        }
      }
      if ((added.size || changed.size) && !timer) timer = setTimeout(flush, 50);
    });
    S.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  }

  function zap() {
    if (S.stop) return;
    const box = document.createElement('div');
    box.setAttribute('data-cp-ui', '');
    box.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #f85149;background:rgba(248,81,73,.18);display:none;box-sizing:border-box';
    const tip = document.createElement('div');
    tip.setAttribute('data-cp-ui', '');
    tip.style.cssText =
      'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;background:#1f6feb;color:#fff;font:600 13px/1.4 system-ui,sans-serif;padding:6px 12px;border-radius:8px;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.4)';
    tip.textContent = 'Countdown Peek: bấm vào lớp muốn gỡ · Esc để thoát';
    document.documentElement.append(box, tip);

    const pick = (e) => {
      const el = topAt(e.clientX, e.clientY);
      return el ? overlayRoot(el) || el : null;
    };
    const onMove = (e) => {
      const t = pick(e);
      if (!t) {
        box.style.display = 'none';
        return;
      }
      const r = t.getBoundingClientRect();
      Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    };
    const block = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onClick = (e) => {
      block(e);
      if (hide(pick(e))) {
        unblur();
        keep();
      }
      onMove(e);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        block(e);
        S.stop();
      }
    };
    const blockers = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu'];
    addEventListener('mousemove', onMove, true);
    addEventListener('click', onClick, true);
    addEventListener('keydown', onKey, true);
    blockers.forEach((t) => addEventListener(t, block, true));
    S.stop = () => {
      removeEventListener('mousemove', onMove, true);
      removeEventListener('click', onClick, true);
      removeEventListener('keydown', onKey, true);
      blockers.forEach((t) => removeEventListener(t, block, true));
      box.remove();
      tip.remove();
      S.stop = null;
    };
  }

  if (!document.body) return { hidden: 0, unblurred: 0 };

  if (action === 'restore') {
    if (S.stop) S.stop();
    if (S.observer) S.observer.disconnect();
    S.observer = null;
    S.fps.clear();
    let n = 0;
    for (const el of document.querySelectorAll(`[${ATTR}],[data-cp-unblur],[data-cp-unlock]`)) {
      if (el.hasAttribute(ATTR)) n++;
      el.removeAttribute(ATTR);
      el.removeAttribute('data-cp-unblur');
      el.removeAttribute('data-cp-unlock');
    }
    if (S.style) S.style.remove();
    return { restored: n };
  }

  ensureStyle();
  if (action === 'zap') {
    zap();
    return { zap: true };
  }
  const hidden = autoPeel();
  const unblurred = unblur();
  if (hidden || unblurred) keep();
  return { hidden, unblurred };
}
