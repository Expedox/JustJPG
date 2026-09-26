// Tiny i18n runtime for JustJPG. Texts live in translations.js.
//   t('key', { n: 3 })   -> translated text, {placeholders} filled in
//   applyTo(document)    -> fills elements marked with
//                           data-i18n / data-i18n-html / data-i18n-title /
//                           data-i18n-placeholder / data-i18n-aria-label
// Loaded as a classic script and imported by the module contexts, so it only
// writes to globalThis.
(() => {
  const T = globalThis.JustJPGTranslations;
  const FALLBACK = 'en';
  let lang = FALLBACK;
  const listeners = new Set();

  function resolve(pref) {
    if (pref && pref !== 'auto') return T[pref] ? pref : FALLBACK;
    let ui = FALLBACK;
    try {
      ui = chrome.i18n.getUILanguage();
    } catch {
      ui = navigator.language || FALLBACK;
    }
    if (T[ui]) return ui;
    const base = ui.split(/[-_]/)[0];
    return T[base] ? base : FALLBACK;
  }

  function t(key, vars) {
    let s = T[lang]?.[key] ?? T[FALLBACK][key] ?? key;
    if (typeof s === 'object') s = (vars?.n === 1 ? s.one : s.other) ?? s.other ?? s.one;
    if (!vars) return s;
    return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  }

  const ATTRS = ['title', 'placeholder', 'aria-label'];

  function applyTo(root = document) {
    if (root === document) document.documentElement.lang = lang;
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
    for (const attr of ATTRS) {
      for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
    }
  }

  function setLanguage(pref) {
    const next = resolve(pref);
    if (next === lang) return;
    lang = next;
    for (const fn of listeners) fn(lang);
  }

  // Reads the saved language and follows later changes from the settings page.
  let ready = null;
  function init() {
    ready ??= (async () => {
      try {
        const { language } = await chrome.storage.sync.get({ language: FALLBACK });
        lang = resolve(language);
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'sync' && changes.language) setLanguage(changes.language.newValue ?? FALLBACK);
        });
      } catch {
        // storage unavailable (e.g. extension reloaded) - keep English
      }
      return lang;
    })();
    return ready;
  }

  globalThis.JustJPGi18n = {
    t,
    applyTo,
    init,
    onChange: (fn) => listeners.add(fn),
    // for contexts without chrome.storage (offscreen document)
    use: setLanguage,
    get lang() {
      return lang;
    },
    languages: () => Object.entries(T).map(([code, texts]) => ({ code, name: texts._name || code })),
  };
})();
