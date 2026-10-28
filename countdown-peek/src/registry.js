// Shared by background.js (importScripts) and the popup (<script>).
// inject.js is registered only for enabled hosts, so a stale localStorage copy
// on a site that was switched off (or a reinstall) can't fake its clock.
const COUNTDOWN_PEEK_SCRIPT_ID = 'countdown-peek-inject';

async function syncInjectRegistration() {
  const { sites = {} } = await chrome.storage.local.get('sites');
  const matches = [];
  for (const [host, cfg] of Object.entries(sites)) {
    if (!cfg || !cfg.enabled) continue;
    if (host === '') matches.push('file:///*');
    else if (/^[a-z0-9.\-_]+$/i.test(host) || /^\[[0-9a-f:.]+\]$/i.test(host)) matches.push(`*://${host}/*`);
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [COUNTDOWN_PEEK_SCRIPT_ID] });
  if (!matches.length) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [COUNTDOWN_PEEK_SCRIPT_ID] });
    return;
  }
  const script = {
    id: COUNTDOWN_PEEK_SCRIPT_ID,
    js: ['src/inject.js'],
    matches,
    runAt: 'document_start',
    allFrames: true,
    matchOriginAsFallback: true,
    world: 'MAIN',
  };
  if (existing.length) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
}
