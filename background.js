importScripts('defaults.js');

const attached = new Set();   // debugger bağlı sekmeler
const lastPos = new Map();    // sekme -> son fare konumu

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(Object.keys(EHM_DEFAULTS));
  await chrome.storage.local.set({ ...EHM_DEFAULTS, ...cur });
});

// ---------- Global kısayol (Alt+Shift+S) ----------
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-click') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' }, { frameId: 0 });
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['defaults.js', 'content.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'toggle' }, { frameId: 0 });
    } catch (_) {}
  }
});

// ---------- Debugger (gerçek tıklama) ----------
async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    // Servis çalışanı yeniden başlamış olabilir: bağlantı bizde duruyor demektir.
    if (!/^Debugger is already attached/i.test(e && e.message || '')) throw e;
  }
  attached.add(tabId);
}

async function detach(tabId) {
  attached.delete(tabId);
  lastPos.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
}

async function mouse(tabId, params) {
  return chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', params);
}

async function dbgClick(tabId, { x, y, button }) {
  const b = button === 'right' ? 'right' : 'left';
  const mask = b === 'right' ? 2 : 1;
  const last = lastPos.get(tabId);
  if (!last || last.x !== x || last.y !== y) {
    await mouse(tabId, { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    lastPos.set(tabId, { x, y });
  }
  const presses = button === 'double' ? 2 : 1;
  for (let i = 1; i <= presses; i++) {
    await mouse(tabId, { type: 'mousePressed', x, y, button: b, buttons: mask, clickCount: i });
    await mouse(tabId, { type: 'mouseReleased', x, y, button: b, buttons: 0, clickCount: i });
  }
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId == null) return;
  attached.delete(source.tabId);
  lastPos.delete(source.tabId);
  chrome.tabs.sendMessage(source.tabId, { type: 'dbg-detached' }, { frameId: 0 }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  lastPos.delete(tabId);
});

// ---------- İçerik betiğinden gelen mesajlar ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  (async () => {
    if (tabId == null) return { ok: false, error: 'sekme yok' };
    switch (msg.type) {
      case 'dbg-attach':
        await ensureAttached(tabId);
        return { ok: true };
      case 'dbg-detach':
        await detach(tabId);
        return { ok: true };
      case 'dbg-click':
        await ensureAttached(tabId);
        await dbgClick(tabId, msg);
        return { ok: true };
      case 'frame-key':
        // iframe içinde basılan kısayol tuşunu üst çerçeveye ilet
        chrome.tabs.sendMessage(tabId, { type: 'key', code: msg.code }, { frameId: 0 }).catch(() => {});
        return { ok: true };
    }
    return { ok: false, error: 'bilinmeyen mesaj' };
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});
