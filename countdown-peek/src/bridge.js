// Runs in the extension's ISOLATED world. Keeps the page's localStorage mirror
// (read synchronously by inject.js on the next load) in sync with
// chrome.storage, and pushes live updates to inject.js.
(() => {
  'use strict';

  const KEY = '__countdown_peek__';
  const EVT = '__countdown_peek_update__';
  const isTop = window === window.top;

  // Config is keyed by the top-level page's hostname so iframes follow it.
  const topHost = (() => {
    if (isTop) return location.hostname;
    const ao = location.ancestorOrigins;
    if (ao && ao.length) {
      try {
        return new URL(ao[ao.length - 1]).hostname;
      } catch {}
    }
    try {
      return window.top.location.hostname;
    } catch {
      return location.hostname;
    }
  })();

  // The mirror carries the top host it was written for; inject.js ignores
  // copies written for another host (same-site frames share localStorage).
  const canon = (cfg) => {
    if (!cfg || !cfg.enabled) return null;
    const c = { ...cfg, host: topHost };
    return JSON.stringify(c, Object.keys(c).sort());
  };

  const readMirror = () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  };
  const mirrorHost = (json) => {
    try {
      return JSON.parse(json).host;
    } catch {
      return undefined;
    }
  };

  // What inject.js in this window applied at document_start. Tracked per
  // window: same-origin frames share localStorage, so the mirror alone can't
  // tell whether this window has seen a change.
  const initial = readMirror();
  let applied = initial && mirrorHost(initial) === topHost ? initial : null;

  function push(cfg) {
    const next = canon(cfg);
    const cur = readMirror();
    // Don't delete a copy that belongs to another top-level host.
    if (cur !== next && (next || mirrorHost(cur) === topHost)) {
      try {
        if (next) localStorage.setItem(KEY, next);
        else localStorage.removeItem(KEY);
      } catch {}
    }
    if (applied !== next) {
      applied = next;
      window.dispatchEvent(new CustomEvent(EVT, { detail: next }));
    }
    if (isTop) {
      chrome.runtime.sendMessage({ type: 'badge', on: !!next }).catch(() => {});
    }
  }

  // Lets the popup push a config directly (via scripting.executeScript).
  globalThis.__countdownPeek = { push };

  chrome.storage.local.get('sites').then(({ sites }) => push(sites && sites[topHost]));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.sites) return;
    const sites = changes.sites.newValue || {};
    push(sites[topHost]);
  });
})();
