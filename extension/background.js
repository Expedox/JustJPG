// JustJPG service worker: context menu, keyboard shortcuts, the save pipeline
// (original file -> page-context fetch -> screenshot fallback) and downloads.
import './translations.js';
import './lib/i18n.js';
import './lib/defaults.js';

const { DEFAULTS, buildFilename } = globalThis.JustJPG;
const i18n = globalThis.JustJPGi18n;
const { t } = i18n;
const CONTENT_FILES = ['translations.js', 'lib/i18n.js', 'lib/defaults.js', 'content.js'];

const MENU_SAVE = 'justjpg-save';
const MENU_VISIBLE = 'justjpg-visible';
const MENU_SHORTCUTS = 'justjpg-shortcuts';

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- setup
async function setupMenus() {
  await i18n.init();
  await chrome.contextMenus.removeAll();
  const s = await getSettings();
  chrome.action.setTitle({ title: t('action.title') });
  // Action (toolbar icon) menu - always available
  chrome.contextMenus.create({ id: MENU_VISIBLE, title: t('menu.visible'), contexts: ['action'] });
  chrome.contextMenus.create({ id: MENU_SHORTCUTS, title: t('menu.shortcuts'), contexts: ['action'] });
  if (!s.contextMenu) return;
  // A single page item, so Chrome shows it directly instead of in a submenu.
  // 'page' matters: on sites with overlays the click never hits the <img>.
  chrome.contextMenus.create({
    id: MENU_SAVE,
    title: t('menu.save'),
    contexts: ['image', 'video', 'page', 'frame', 'link', 'selection', 'editable'],
  });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await setupMenus();
  // make the addon work in tabs that were open before installation
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file:///*'] });
  for (const tab of tabs) {
    chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, files: CONTENT_FILES })
      .catch(() => {});
  }
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(setupMenus);
i18n.onChange(setupMenus);
i18n.init();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && 'contextMenu' in changes) setupMenus();
});

// ---------------------------------------------------------------- offscreen
let creatingOffscreen = null;
let offscreenIdleTimer = 0;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS', 'DOM_PARSER'],
      justification: 'Decode images locally and convert them to JPG',
    })
    .catch((e) => {
      if (!String(e?.message).includes('single offscreen')) throw e;
    })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

async function offscreen(msg) {
  await ensureOffscreen();
  clearTimeout(offscreenIdleTimer);
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', lang: i18n.lang, ...msg });
  // free the decoder memory when idle
  offscreenIdleTimer = setTimeout(() => chrome.offscreen.closeDocument().catch(() => {}), 60_000);
  if (!res) throw new Error(t('err.converter'));
  if (!res.ok) throw Object.assign(new Error(res.error), { code: res.code });
  return res.value;
}

// ---------------------------------------------------------------- page helpers
async function frameCall(tabId, frameId, msg) {
  const res = await chrome.tabs.sendMessage(tabId, msg, { frameId });
  if (!res) throw new Error(t('err.page'));
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

function toast(tabId, text, kind = 'ok') {
  chrome.tabs.sendMessage(tabId, { type: 'toast', text, kind }, { frameId: 0 }).catch(() => {});
}

// Many CDNs refuse hotlinked requests without the page's Referer. Requests from
// the offscreen document carry tabId -1, so a session rule scoped to that only
// touches our own fetches.
let ruleSeq = Math.floor(Math.random() * 1e6) + 1;
async function withReferer(url, referer, fn) {
  let host = '';
  try {
    const u = new URL(url);
    if (/^https?:$/.test(u.protocol)) host = u.hostname;
  } catch {}
  if (!host || !/^https?:/i.test(referer || '')) return fn();
  const id = ruleSeq++;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          priority: 1,
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: referer }] },
          condition: { requestDomains: [host], tabIds: [chrome.tabs.TAB_ID_NONE] },
        },
      ],
    });
  } catch {
    return fn();
  }
  try {
    return await fn();
  } finally {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
  }
}

// ---------------------------------------------------------------- screenshot
let lastCapture = 0;

async function capture(windowId) {
  // Chrome allows ~2 captures per second
  const wait = 600 - (Date.now() - lastCapture);
  if (wait > 0) await sleep(wait);
  lastCapture = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

// Hide our own button/toast in every frame and wait until they have
// repainted, so they never end up in a screenshot.
async function setUiHidden(tabId, hidden) {
  await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      func: (h) => globalThis.__justjpg?.setUiHidden(h),
      args: [hidden],
    })
    .catch(() => {});
}

async function captureElement(tab, frameId, desc, options) {
  try {
    const { rect, vw } = await frameCall(tab.id, frameId, { type: 'prepareCapture', token: desc.token });
    await setUiHidden(tab.id, true);
    const png = await capture(tab.windowId);
    return await offscreen({ type: 'crop', url: png, rect, vw, options });
  } finally {
    setUiHidden(tab.id, false);
  }
}

// ---------------------------------------------------------------- save pipeline
async function nextCounter(template) {
  if (!/\{counter\}/.test(template)) return undefined;
  const { counter = 1 } = await chrome.storage.local.get('counter');
  await chrome.storage.local.set({ counter: counter + 1 });
  return counter;
}

async function convertDescriptor(tab, frameId, desc, s) {
  const options = { quality: s.quality, background: s.background, keepJpeg: s.keepJpeg };
  const dpr = desc.dpr || 1;
  const hint = { width: Math.round((desc.renderedWidth || 0) * dpr), height: Math.round((desc.renderedHeight || 0) * dpr) };
  const errors = [];
  const hasPage = desc.token != null;

  // 1. data the page renders itself: canvas, current video frame, inline svg
  if (desc.local && hasPage) {
    try {
      const dataUrl = await frameCall(tab.id, frameId, { type: 'localData', token: desc.token, kind: desc.kind });
      if (dataUrl) return { result: await offscreen({ type: 'convert', url: dataUrl, options, hint }), src: '' };
      errors.push(t('err.contentEmpty'));
    } catch (e) {
      errors.push(/secur|taint/i.test(e.message) ? t('err.contentProtected') : e.message);
    }
  }

  // 2. original files, best candidate first
  for (const src of desc.srcs || []) {
    if (!/^blob:/i.test(src)) {
      try {
        const result = await withReferer(src, desc.frameUrl || tab.url, () => offscreen({ type: 'convert', url: src, options, hint }));
        return { result, src };
      } catch (e) {
        errors.push(e.message);
        if (e.code && e.code !== 'fetch') continue; // decoding failed - page fetch won't help
      }
    }
    // 2b. fetch inside the page (blob: URLs, session-bound URLs)
    if (hasPage) {
      try {
        const dataUrl = await frameCall(tab.id, frameId, { type: 'localData', token: desc.token, url: src });
        return { result: await offscreen({ type: 'convert', url: dataUrl, options, hint }), src };
      } catch (e) {
        errors.push(e.message);
      }
    }
  }

  // 3. last resort: photograph the element
  if (s.screenshotFallback && hasPage) {
    try {
      return { result: await captureElement(tab, frameId, desc, options), src: desc.srcs?.[0] || '', screenshot: true };
    } catch (e) {
      errors.push(t('err.screenshot', { message: e.message }));
    }
  }
  throw new Error(errors[0] || t('err.noImage'));
}

async function download(dataUrl, info, s) {
  const counter = await nextCounter(s.filenameTemplate);
  const filename = buildFilename(s, { ...info, counter });
  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: s.saveMode === 'ask',
    conflictAction: s.conflictAction === 'overwrite' ? 'overwrite' : 'uniquify',
  });
  return filename.split('/').pop();
}

async function saveDescriptor(tab, frameId, desc, extra = {}) {
  const s = await getSettings();
  const { result, src, screenshot } = await convertDescriptor(tab, frameId, desc, s);
  const filename = await download(
    result.dataUrl,
    {
      srcUrl: src,
      pageUrl: tab.url,
      pageTitle: tab.title,
      alt: desc.alt,
      width: result.width,
      height: result.height,
      format: result.format,
      index: extra.index,
    },
    s
  );
  return { filename, screenshot, kept: result.kept, format: result.format };
}

async function saveAndReport(tab, frameId, desc) {
  try {
    if (!desc) throw new Error(t('err.noImageHere'));
    const r = await saveDescriptor(tab, frameId, desc);
    const note = r.screenshot
      ? t('toast.viaScreenshot')
      : r.kept
        ? t('toast.keptJpeg')
        : r.format
          ? t('toast.fromFormat', { format: r.format.toUpperCase() })
          : '';
    toast(tab.id, t('toast.saved', { file: r.filename }) + note);
    return { ok: true, ...r };
  } catch (e) {
    toast(tab.id, `JustJPG: ${e.message}`, 'err');
    return { ok: false, error: e.message };
  }
}

async function saveVisible(tab) {
  const s = await getSettings();
  try {
    await setUiHidden(tab.id, true);
    const png = await capture(tab.windowId);
    setUiHidden(tab.id, false);
    const result = await offscreen({ type: 'convert', url: png, options: { quality: s.quality, background: s.background, keepJpeg: false } });
    const filename = await download(result.dataUrl, { srcUrl: '', pageUrl: tab.url, pageTitle: tab.title, width: result.width, height: result.height, format: 'screenshot' }, s);
    toast(tab.id, t('toast.saved', { file: filename }));
    return { ok: true, filename };
  } catch (e) {
    setUiHidden(tab.id, false);
    toast(tab.id, `JustJPG: ${e.message}`, 'err');
    return { ok: false, error: e.message };
  }
}

async function saveBatch(tabId, items) {
  const tab = await chrome.tabs.get(tabId);
  let done = 0;
  const failed = [];
  for (let i = 0; i < items.length; i++) {
    const { frameId, desc } = items[i];
    let error = null;
    try {
      await saveDescriptor(tab, frameId, desc, { index: i + 1 });
      done++;
    } catch (e) {
      error = e.message;
      failed.push({ index: i, error });
    }
    chrome.runtime
      .sendMessage({ type: 'batchProgress', tabId, index: i, ok: !error, error, done, failed: failed.length, total: items.length })
      .catch(() => {});
  }
  const text = failed.length
    ? t('toast.batchPartial', { done, total: items.length, failed: failed.length })
    : t('toast.batchDone', { n: done });
  toast(tabId, text, failed.length ? 'info' : 'ok');
  return { ok: true, done, failed };
}

// ---------------------------------------------------------------- triggers
async function onMenuClicked(info, tab) {
  if (info.menuItemId === MENU_SHORTCUTS) {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    return;
  }
  if (!tab?.id) return;
  if (info.menuItemId === MENU_VISIBLE) return saveVisible(tab);
  if (info.menuItemId !== MENU_SAVE) return;
  const frameId = info.frameId ?? 0;
  let desc = null;
  try {
    desc = await frameCall(tab.id, frameId, { type: 'resolveAtLastContext', srcUrl: info.srcUrl });
  } catch {
    // no content script (e.g. page opened before install, restricted page)
    if (info.srcUrl) desc = { token: null, kind: 'url', srcs: [info.srcUrl], frameUrl: info.frameUrl || info.pageUrl };
  }
  return saveAndReport(tab, frameId, desc);
}

async function onCommand(command, tab) {
  tab ??= (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab?.id) return;
  if (command === 'save-visible') return saveVisible(tab);
  if (command !== 'save-under-cursor') return;
  let frameId = 0;
  try {
    // the frame where the mouse moved most recently is the one under the cursor
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => globalThis.__justjpg?.lastMouse ?? null,
    });
    let best = 0;
    for (const r of results) {
      if (r.result && r.result.t > best) {
        best = r.result.t;
        frameId = r.frameId;
      }
    }
    const desc = await frameCall(tab.id, frameId, { type: 'resolveAtMouse' });
    return saveAndReport(tab, frameId, desc);
  } catch (e) {
    toast(tab.id, `JustJPG: ${e.message}`, 'err');
    return { ok: false, error: e.message };
  }
}

chrome.contextMenus.onClicked.addListener(onMenuClicked);
chrome.commands.onCommand.addListener(onCommand);
// handy from the service worker console: justjpg.onCommand('save-under-cursor')
globalThis.justjpg = { onMenuClicked, onCommand, saveVisible };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return;
  let job;
  switch (msg?.type) {
    case 'saveDescriptor':
      job = saveAndReport(sender.tab, sender.frameId ?? 0, msg.desc);
      break;
    case 'saveBatch':
      job = saveBatch(msg.tabId, msg.items);
      break;
    case 'saveVisible':
      job = chrome.tabs.get(msg.tabId).then(saveVisible);
      break;
    case 'resetCounter':
      job = chrome.storage.local.set({ counter: 1 }).then(() => ({ ok: true }));
      break;
    default:
      return;
  }
  job.then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
