importScripts('registry.js');

// Shows an "ON" badge on tabs where the fake clock is active.
chrome.action.setBadgeBackgroundColor({ color: '#1f6feb' });

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'badge' && sender.tab && sender.tab.id != null) {
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: msg.on ? 'ON' : '' });
  }
});

// Dynamic content scripts can be dropped on install/update; rebuild them.
chrome.runtime.onInstalled.addListener(() => syncInjectRegistration().catch(console.error));
chrome.runtime.onStartup.addListener(() => syncInjectRegistration().catch(console.error));
