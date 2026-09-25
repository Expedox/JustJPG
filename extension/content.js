// JustJPG content script: finds images under the cursor (even behind overlays,
// with right-click blocked, as CSS backgrounds, canvas, video or inline SVG),
// renders the hover button and toasts, and hands data to the service worker.
(() => {
  if (globalThis.__justjpg) return;

  const { DEFAULTS } = globalThis.JustJPG;
  let settings = { ...DEFAULTS };
  const IS_TOP = window === window.top;
  const IMG_EXT = /\.(jpe?g|jfif|png|webp|avif|gif|heic|heif|bmp|tiff?|jxl|svg|ico)(?:[?#]|$)/i;

  try {
    chrome.storage.sync.get(DEFAULTS, (s) => {
      settings = { ...DEFAULTS, ...s };
      if (!settings.hoverButton) hideHover();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
      if (!settings.hoverButton) hideHover();
    });
  } catch {
    // extension context invalidated (addon reloaded) - stay inert
  }

  // ---------------------------------------------------------------- state
  const state = {
    lastContext: null, // {x, y, t}
    lastMouse: null,
    uiHidden: false,
  };
  const registry = new Map(); // token -> element
  let tokenSeq = 0;
  const register = (el) => {
    const token = `${Date.now().toString(36)}-${(tokenSeq++).toString(36)}`;
    registry.set(token, el);
    if (registry.size > 4000) registry.delete(registry.keys().next().value);
    return token;
  };

  // ---------------------------------------------------------------- media detection
  const isOwnUi = (el) => el === hoverHost || el === toastHost;

  function cssUrls(value) {
    if (!value || value === 'none') return [];
    const out = [];
    const re = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
    let m;
    while ((m = re.exec(value))) {
      if (m[2] && !/^data:image\/svg\+xml.{0,40}gradient/i.test(m[2])) out.push(m[2]);
    }
    return out;
  }

  function bgUrls(el) {
    const urls = [];
    try {
      urls.push(...cssUrls(getComputedStyle(el).backgroundImage));
      if (!urls.length) {
        urls.push(...cssUrls(getComputedStyle(el, '::before').backgroundImage));
        urls.push(...cssUrls(getComputedStyle(el, '::after').backgroundImage));
      }
    } catch {}
    return urls.map(absUrl).filter(Boolean);
  }

  function absUrl(u) {
    if (!u) return '';
    try {
      return new URL(u, document.baseURI).href;
    } catch {
      return '';
    }
  }

  function mediaKind(el) {
    if (!el || el.nodeType !== 1 || isOwnUi(el)) return null;
    const tag = el.localName;
    if (tag === 'img') return el.currentSrc || el.src ? 'img' : null;
    if (tag === 'video') return 'video';
    if (tag === 'canvas') return el.width > 8 && el.height > 8 ? 'canvas' : null;
    if (tag === 'picture') return el.querySelector('img') ? 'picture' : null;
    if (tag === 'input' && el.type === 'image' && el.src) return 'img';
    if (tag === 'image' && el instanceof SVGElement) return 'svgimage';
    if (tag === 'svg') return 'svg';
    if (el instanceof SVGElement && el.ownerSVGElement) return 'svgchild';
    if (bgUrls(el).length) return 'bg';
    return null;
  }

  function normalizeTarget(el, kind) {
    if (kind === 'picture') return [el.querySelector('img'), 'img'];
    if (kind === 'svgchild') {
      // outermost svg of this graphic
      let svg = el.ownerSVGElement;
      while (svg && svg.ownerSVGElement) svg = svg.ownerSVGElement;
      return [svg, 'svg'];
    }
    return [el, kind];
  }

  function deepElementsFromPoint(root, x, y, seen = new Set()) {
    const list = root.elementsFromPoint(x, y);
    const out = [];
    for (const el of list) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (el.shadowRoot) out.push(...deepElementsFromPoint(el.shadowRoot, x, y, seen));
      out.push(el);
    }
    return out;
  }

  // Media elements with pointer-events:none are invisible to elementsFromPoint,
  // so fall back to a geometric search.
  function geometricSearch(x, y) {
    let best = null;
    let bestArea = Infinity;
    const walk = (root) => {
      for (const el of root.querySelectorAll('img, video, canvas, svg, picture > img, input[type=image]')) {
        if (el instanceof SVGElement && el.ownerSVGElement) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const area = r.width * r.height;
        if (area < bestArea) {
          best = el;
          bestArea = area;
        }
      }
      for (const host of root.querySelectorAll('*')) if (host.shadowRoot) walk(host.shadowRoot);
    };
    try {
      walk(document);
    } catch {}
    return best;
  }

  function findMediaAt(x, y, { deep = true } = {}) {
    let elements;
    try {
      elements = deepElementsFromPoint(document, x, y);
    } catch {
      elements = [];
    }
    for (const el of elements) {
      if (el === document.documentElement || el === document.body) continue;
      const kind = mediaKind(el);
      if (kind) return normalizeTarget(el, kind);
    }
    if (deep) {
      const el = geometricSearch(x, y);
      if (el) {
        const kind = mediaKind(el);
        if (kind) return normalizeTarget(el, kind);
      }
      // body/html backgrounds as the very last resort
      for (const el of [document.body, document.documentElement]) {
        if (el && bgUrls(el).length) return [el, 'bg'];
      }
    }
    return [null, null];
  }

  // ---------------------------------------------------------------- srcset
  function parseSrcset(srcset) {
    const out = [];
    if (!srcset) return out;
    let i = 0;
    const s = srcset;
    while (i < s.length) {
      while (i < s.length && /[\s,]/.test(s[i])) i++;
      if (i >= s.length) break;
      let start = i;
      while (i < s.length && !/\s/.test(s[i])) i++;
      let url = s.slice(start, i);
      let desc = '';
      if (url.endsWith(',')) {
        url = url.replace(/,+$/, '');
      } else {
        start = i;
        let depth = 0;
        while (i < s.length && (s[i] !== ',' || depth > 0)) {
          if (s[i] === '(') depth++;
          if (s[i] === ')') depth--;
          i++;
        }
        desc = s.slice(start, i).trim();
      }
      const w = /(\d+)w/.exec(desc);
      const x = /([\d.]+)x/.exec(desc);
      out.push({ url: absUrl(url), w: w ? +w[1] : 0, x: x ? +x[1] : w ? 0 : 1 });
    }
    return out;
  }

  function largestFromSrcset(candidates) {
    if (!candidates.length) return '';
    const byW = candidates.filter((c) => c.w);
    const pool = byW.length ? byW : candidates;
    return pool.reduce((a, b) => ((b.w || b.x) > (a.w || a.x) ? b : a)).url;
  }

  function lazyAttrUrls(el) {
    const strong = [];
    const weak = [];
    for (const attr of el.attributes) {
      if (!attr.name.startsWith('data-')) continue;
      const v = attr.value.trim();
      if (!v || v.length > 2000 || /\s/.test(v.split(/\s+\d+[wx]/)[0])) continue;
      const looksUrl = /^(https?:)?\/\//i.test(v) || (v.startsWith('/') && IMG_EXT.test(v));
      if (!looksUrl) continue;
      if (/(full|zoom|large|orig|hi-?res|big|max)/i.test(attr.name)) strong.push(absUrl(v));
      else if (/src|url|image|img/i.test(attr.name)) weak.push(absUrl(v.split(/\s+/)[0]));
    }
    return { strong, weak };
  }

  // ---------------------------------------------------------------- describe
  function describe(el, kind) {
    const r = el.getBoundingClientRect();
    const desc = {
      token: register(el),
      kind,
      srcs: [],
      local: false,
      alt: '',
      width: 0,
      height: 0,
      renderedWidth: Math.round(r.width),
      renderedHeight: Math.round(r.height),
      frameUrl: location.href,
      frameTitle: document.title,
      dpr: window.devicePixelRatio || 1,
    };
    const push = (...urls) => {
      for (const u of urls) if (u && !u.startsWith('about:') && !desc.srcs.includes(u)) desc.srcs.push(u);
    };
    desc.alt = el.getAttribute?.('alt') || el.getAttribute?.('title') || el.getAttribute?.('aria-label') || '';

    if (kind === 'img') {
      desc.width = el.naturalWidth || 0;
      desc.height = el.naturalHeight || 0;
      const link = el.closest('a[href]');
      const linked = link && IMG_EXT.test(link.href) && !/\.svg/i.test(link.href) ? link.href : '';
      const { strong, weak } = lazyAttrUrls(el);
      let candidates = parseSrcset(el.getAttribute('srcset'));
      const picture = el.parentElement?.localName === 'picture' ? el.parentElement : null;
      if (picture) {
        for (const source of picture.querySelectorAll('source')) {
          candidates = candidates.concat(parseSrcset(source.getAttribute('srcset')));
        }
      }
      if (settings.preferLargest) {
        push(linked, ...strong, largestFromSrcset(candidates), el.currentSrc, el.src, ...weak);
      } else {
        push(el.currentSrc, el.src, largestFromSrcset(candidates), ...strong, ...weak, linked);
      }
    } else if (kind === 'video') {
      desc.width = el.videoWidth;
      desc.height = el.videoHeight;
      desc.local = true;
      desc.alt = desc.alt || document.title;
      if (el.readyState < 2 && el.poster) push(absUrl(el.poster));
    } else if (kind === 'canvas') {
      desc.width = el.width;
      desc.height = el.height;
      desc.local = true;
    } else if (kind === 'svg') {
      desc.local = true;
      desc.width = Math.round(r.width * desc.dpr);
      desc.height = Math.round(r.height * desc.dpr);
      desc.alt = desc.alt || el.querySelector(':scope > title')?.textContent || '';
    } else if (kind === 'svgimage') {
      push(absUrl(el.href?.baseVal || el.getAttribute('href') || el.getAttribute('xlink:href')));
    } else if (kind === 'bg') {
      push(...bgUrls(el));
      desc.alt = desc.alt || el.getAttribute('aria-label') || '';
    }
    // blob:/data: URLs only resolve inside the page - fetch them here
    if (!desc.local && desc.srcs.length && /^(blob|data):/i.test(desc.srcs[0])) desc.pageFetchFirst = true;
    return desc;
  }

  // ---------------------------------------------------------------- local data
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  function isBlankCanvas(canvas) {
    try {
      const probe = document.createElement('canvas');
      probe.width = 32;
      probe.height = 32;
      const ctx = probe.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0, 32, 32);
      const d = ctx.getImageData(0, 0, 32, 32).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
      return true;
    } catch {
      return false;
    }
  }

  function serializeSvg(svg) {
    const clone = svg.cloneNode(true);
    const r = svg.getBoundingClientRect();
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    clone.setAttribute('width', String(Math.round(r.width)));
    clone.setAttribute('height', String(Math.round(r.height)));
    // resolve <use href="#id"> references that live outside this svg
    for (const use of clone.querySelectorAll('use')) {
      const ref = use.getAttribute('href') || use.getAttribute('xlink:href');
      if (ref?.startsWith('#') && !clone.querySelector(ref)) {
        const target = document.querySelector(ref);
        if (target) {
          const defs = clone.querySelector('defs') || clone.insertBefore(document.createElementNS('http://www.w3.org/2000/svg', 'defs'), clone.firstChild);
          defs.appendChild(target.cloneNode(true));
        }
      }
    }
    const color = getComputedStyle(svg).color;
    if (color && !clone.getAttribute('color')) clone.setAttribute('color', color);
    const xml = new XMLSerializer().serializeToString(clone);
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  }

  async function localData(el, kind) {
    if (kind === 'canvas') {
      if (isBlankCanvas(el)) return null;
      return el.toDataURL('image/png');
    }
    if (kind === 'video') {
      if (!el.videoWidth) return null;
      const c = document.createElement('canvas');
      c.width = el.videoWidth;
      c.height = el.videoHeight;
      c.getContext('2d').drawImage(el, 0, 0);
      return c.toDataURL('image/png'); // throws SecurityError on cross-origin video
    }
    if (kind === 'svg') return serializeSvg(el);
    return null;
  }

  async function pageFetch(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return blobToDataUrl(await res.blob());
  }

  // ---------------------------------------------------------------- rect in top frame
  const pendingRects = new Map();

  function toTopRect(rect) {
    if (IS_TOP) return Promise.resolve({ rect, vw: window.innerWidth, vh: window.innerHeight });
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      pendingRects.set(id, resolve);
      setTimeout(() => {
        if (pendingRects.delete(id)) reject(new Error('Frame-Position unbekannt'));
      }, 3000);
      window.parent.postMessage({ __justjpg: 'rect', id, rect }, '*');
    });
  }

  window.addEventListener('message', async (e) => {
    const data = e.data;
    if (!data || typeof data !== 'object' || !data.__justjpg) return;
    if (data.__justjpg === 'rect-reply') {
      const resolve = pendingRects.get(data.id);
      if (resolve) {
        pendingRects.delete(data.id);
        resolve(data.result);
      }
      return;
    }
    if (data.__justjpg === 'rect') {
      const frame = [...document.querySelectorAll('iframe, frame')].find((f) => f.contentWindow === e.source);
      if (!frame) return;
      const fr = frame.getBoundingClientRect();
      const cs = getComputedStyle(frame);
      const ox = fr.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
      const oy = fr.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
      const r = data.rect;
      const rect = clipRect({ left: r.left + ox, top: r.top + oy, right: r.right + ox, bottom: r.bottom + oy }, fr);
      try {
        const result = await toTopRect(rect);
        e.source.postMessage({ __justjpg: 'rect-reply', id: data.id, result }, '*');
      } catch {}
    }
  });

  function clipRect(r, bounds) {
    const left = Math.max(r.left, bounds.left);
    const top = Math.max(r.top, bounds.top);
    const right = Math.min(r.right, bounds.right);
    const bottom = Math.min(r.bottom, bounds.bottom);
    return { left, top, right: Math.max(left, right), bottom: Math.max(top, bottom) };
  }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  async function prepareCapture(el) {
    let r = el.getBoundingClientRect();
    const fullyVisible = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
    if (!fullyVisible) {
      el.scrollIntoView({ block: r.height > innerHeight ? 'start' : 'center', inline: 'center', behavior: 'instant' });
      await nextFrame();
      await new Promise((res) => setTimeout(res, 250));
    }
    r = el.getBoundingClientRect();
    const rect = clipRect(r, { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
    if (rect.right - rect.left < 2 || rect.bottom - rect.top < 2) throw new Error('Element nicht sichtbar');
    return toTopRect(rect);
  }

  // ---------------------------------------------------------------- collect all
  async function collectAll(minSize = settings.galleryMinSize) {
    const items = [];
    const seen = new Set();
    const add = (el, kind) => {
      const desc = describe(el, kind);
      const key = desc.srcs[0] || desc.token;
      if (desc.srcs[0] && seen.has(key)) return;
      seen.add(key);
      const w = desc.width || desc.renderedWidth;
      const h = desc.height || desc.renderedHeight;
      if (kind === 'bg' ? desc.renderedWidth < minSize || desc.renderedHeight < minSize : w < minSize || h < minSize) return;
      if (desc.local) {
        try {
          const c = document.createElement('canvas');
          const scale = Math.min(1, 240 / Math.max(w, h, 1));
          c.width = Math.max(1, Math.round(w * scale));
          c.height = Math.max(1, Math.round(h * scale));
          if (kind === 'svg') desc.thumb = serializeSvg(el);
          else {
            c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
            desc.thumb = c.toDataURL('image/jpeg', 0.7);
          }
        } catch {
          desc.thumb = '';
        }
      } else {
        desc.thumb = el.localName === 'img' ? el.currentSrc || el.src : desc.srcs[0];
      }
      items.push(desc);
    };
    let count = 0;
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (++count > 20000) return;
        if (el.shadowRoot) walk(el.shadowRoot);
        if (isOwnUi(el) || el.localName === 'picture' || (el instanceof SVGElement && el.localName !== 'svg' && el.localName !== 'image')) continue;
        if (el instanceof SVGElement && el.ownerSVGElement && el.localName === 'svg') continue;
        const kind = mediaKind(el);
        if (kind && kind !== 'svgchild') {
          if (kind === 'svg') {
            // inline icons are rarely wanted - only keep big graphics
            const r = el.getBoundingClientRect();
            if (r.width < 200 || r.height < 200) continue;
          }
          add(el, kind);
        }
      }
    };
    walk(document);
    return items;
  }

  // ---------------------------------------------------------------- UI: hover button
  let hoverHost = null;
  let hoverBtn = null;
  let hoverTarget = null; // [el, kind]
  let hoverBusy = false;

  const ICON_SAVE =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>';

  function ensureHover() {
    if (hoverHost) return;
    hoverHost = document.createElement('justjpg-hover');
    hoverHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;display:none;';
    const shadow = hoverHost.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      button{all:initial;visibility:inherit;box-sizing:border-box;display:flex;align-items:center;gap:6px;height:32px;padding:0 10px 0 8px;
        border-radius:16px;background:rgba(17,17,17,.82);color:#fff;font:600 12px/1 system-ui,-apple-system,Segoe UI,sans-serif;
        cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35);backdrop-filter:blur(6px);transition:background .15s,transform .1s;user-select:none}
      button:hover{background:#e8590c}
      button:active{transform:scale(.95)}
      button.busy{opacity:.75;cursor:progress}
      button.ok{background:#2b8a3e}
      button.err{background:#c92a2a}
      svg{flex:none}
    </style><button type="button" title="Als JPG speichern (JustJPG)">${ICON_SAVE}<span>JPG</span></button>`;
    hoverBtn = shadow.querySelector('button');
    const swallow = (e) => {
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'dblclick', 'contextmenu']) {
      hoverBtn.addEventListener(type, (e) => {
        swallow(e);
        if (type !== 'contextmenu') e.preventDefault();
      });
    }
    hoverBtn.addEventListener('click', async (e) => {
      swallow(e);
      e.preventDefault();
      if (!hoverTarget || hoverBusy) return;
      const [el, kind] = hoverTarget;
      hoverBusy = true;
      hoverBtn.className = 'busy';
      const label = hoverBtn.querySelector('span');
      label.textContent = '...';
      try {
        const res = await chrome.runtime.sendMessage({ type: 'saveDescriptor', desc: describe(el, kind) });
        hoverBtn.className = res?.ok ? 'ok' : 'err';
        label.textContent = res?.ok ? 'OK' : 'Fehler';
      } catch {
        hoverBtn.className = 'err';
        label.textContent = 'Fehler';
      }
      setTimeout(() => {
        hoverBusy = false;
        if (hoverBtn) {
          hoverBtn.className = '';
          label.textContent = 'JPG';
        }
      }, 1400);
    });
    (document.documentElement || document).appendChild(hoverHost);
  }

  function hideHover() {
    if (hoverHost && !hoverBusy) hoverHost.style.display = 'none';
    if (!hoverBusy) hoverTarget = null;
  }

  function placeHover(el) {
    ensureHover();
    if (!hoverHost.isConnected) (document.documentElement || document).appendChild(hoverHost);
    const r = el.getBoundingClientRect();
    const vis = clipRect(r, { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
    const pos = settings.hoverPosition || 'top-right';
    const bw = 64;
    const bh = 32;
    const m = 8;
    let x = pos.endsWith('left') ? vis.left + m : vis.right - bw - m;
    let y = pos.startsWith('top') ? vis.top + m : vis.bottom - bh - m;
    x = Math.max(4, Math.min(innerWidth - bw - 4, x));
    y = Math.max(4, Math.min(innerHeight - bh - 4, y));
    hoverHost.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    hoverHost.style.display = state.uiHidden ? 'none' : 'block';
  }

  let hoverRaf = 0;
  function onHoverMove(x, y) {
    if (!settings.hoverButton || hoverBusy) return;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      if (hoverHost && hoverHost.style.display !== 'none') {
        const br = hoverHost.getBoundingClientRect();
        if (x >= br.left - 4 && x <= br.left + 72 && y >= br.top - 4 && y <= br.top + 40) return;
      }
      const [el, kind] = findMediaAt(x, y, { deep: false });
      if (!el || el === document.documentElement || el === document.body) return hideHover();
      const r = el.getBoundingClientRect();
      const min = settings.hoverMinSize || 0;
      if (r.width < min || r.height < min) return hideHover();
      hoverTarget = [el, kind];
      placeHover(el);
    });
  }

  // ---------------------------------------------------------------- UI: toast
  let toastHost = null;
  let toastBox = null;
  let toastTimer = 0;

  function toast(text, kind = 'ok') {
    if (!settings.showToast && kind !== 'err') return;
    if (!toastHost) {
      toastHost = document.createElement('justjpg-toast');
      toastHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;';
      const shadow = toastHost.attachShadow({ mode: 'closed' });
      shadow.innerHTML = `<style>
        div{all:initial;visibility:inherit;display:block;max-width:360px;padding:10px 14px;border-radius:10px;background:rgba(17,17,17,.9);color:#fff;
          font:500 13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.35);word-break:break-word;
          border-left:4px solid #2b8a3e;transition:opacity .2s}
        div.err{border-left-color:#e03131}
        div.info{border-left-color:#e8590c}
      </style><div></div>`;
      toastBox = shadow.querySelector('div');
    }
    if (!toastHost.isConnected) (document.documentElement || document).appendChild(toastHost);
    toastBox.className = kind;
    toastBox.textContent = text;
    toastHost.style.display = state.uiHidden ? 'none' : 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastHost.style.display = 'none'), kind === 'err' ? 6000 : 2800);
  }

  async function setUiHidden(hidden) {
    state.uiHidden = hidden;
    for (const host of [hoverHost, toastHost]) if (host) host.style.setProperty('visibility', hidden ? 'hidden' : 'visible', 'important');
    if (hidden) {
      await nextFrame();
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  // ---------------------------------------------------------------- events
  window.addEventListener(
    'contextmenu',
    (e) => {
      state.lastContext = { x: e.clientX, y: e.clientY, t: Date.now() };
      if (!settings.unblockContextMenu || isOwnUi(e.target)) return;
      // Only override the page when there is an image under the cursor, so
      // custom context menus of web apps keep working everywhere else.
      const [el] = findMediaAt(e.clientX, e.clientY, { deep: true });
      if (el && el !== document.documentElement && el !== document.body) {
        e.stopImmediatePropagation();
        e.stopPropagation();
      }
    },
    true
  );

  window.addEventListener(
    'mousemove',
    (e) => {
      state.lastMouse = { x: e.clientX, y: e.clientY, t: Date.now() };
      onHoverMove(e.clientX, e.clientY);
    },
    { capture: true, passive: true }
  );
  window.addEventListener('scroll', () => hideHover(), { capture: true, passive: true });
  document.addEventListener('mouseleave', () => hideHover());

  // ---------------------------------------------------------------- messaging
  function resolveAt(point, srcUrl) {
    if (point) {
      const [el, kind] = findMediaAt(point.x, point.y);
      if (el) {
        const desc = describe(el, kind);
        if (srcUrl && !desc.srcs.includes(srcUrl)) desc.srcs.push(srcUrl);
        return desc;
      }
    }
    if (srcUrl) {
      const el = [...document.images].find((i) => i.currentSrc === srcUrl || i.src === srcUrl);
      if (el) return describe(el, 'img');
      return { token: null, kind: 'url', srcs: [srcUrl], frameUrl: location.href, frameTitle: document.title, alt: '' };
    }
    return null;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const handle = async () => {
      switch (msg.type) {
        case 'resolveAtLastContext':
          return resolveAt(state.lastContext, msg.srcUrl);
        case 'resolveAtMouse':
          return resolveAt(state.lastMouse, null);
        case 'localData': {
          const el = registry.get(msg.token);
          if (msg.url) return pageFetch(msg.url);
          if (!el) throw new Error('Element nicht mehr vorhanden');
          return localData(el, msg.kind);
        }
        case 'prepareCapture': {
          const el = registry.get(msg.token);
          if (!el || !el.isConnected) throw new Error('Element nicht mehr vorhanden');
          return prepareCapture(el);
        }
        case 'toast':
          if (IS_TOP) toast(msg.text, msg.kind);
          return true;
        case 'viewport':
          return { vw: innerWidth, vh: innerHeight };
        default:
          return undefined;
      }
    };
    // Frames that are not addressed by frameId still get broadcast messages -
    // only answer the ones meant for everyone or that we can handle.
    handle().then(
      (value) => sendResponse({ ok: true, value }),
      (err) => sendResponse({ ok: false, error: String(err?.message || err) })
    );
    return true;
  });

  globalThis.__justjpg = {
    get lastMouse() {
      return state.lastMouse;
    },
    collectAll,
    setUiHidden,
  };
})();
