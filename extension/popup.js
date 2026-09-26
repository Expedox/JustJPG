// JustJPG gallery: lists every image of the current tab (all frames) and saves
// the selection as JPG.
(async () => {
  const { DEFAULTS } = globalThis.JustJPG;
  const { t } = globalThis.JustJPGi18n;
  await globalThis.JustJPGi18n.init();
  globalThis.JustJPGi18n.applyTo(document);
  const $ = (id) => document.getElementById(id);
  const grid = $('grid');
  const empty = $('empty');
  const saveBtn = $('save');
  const allBox = $('all');
  const minSel = $('min');
  const progress = $('progress');

  let items = []; // { frameId, desc, w, h, tile }
  const selected = new Set();

  $('options').onclick = () => chrome.runtime.openOptionsPage();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  $('visible').onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'saveVisible', tabId: tab.id });
    window.close();
  };

  const settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };

  // ---------------------------------------------------------------- dropdowns
  const menus = [
    { btn: $('viewBtn'), menu: $('viewMenu'), focus: $('thumb') },
    { btn: $('minBtn'), menu: $('minMenu'), focus: minSel },
  ];
  const setMenu = (entry, open) => {
    entry.menu.hidden = !open;
    entry.btn.setAttribute('aria-expanded', String(open));
    if (open) entry.focus.focus();
  };
  for (const entry of menus) {
    entry.btn.onclick = (e) => {
      e.stopPropagation();
      const open = entry.menu.hidden;
      for (const other of menus) setMenu(other, false);
      setMenu(entry, open);
    };
    entry.menu.onclick = (e) => e.stopPropagation();
  }
  document.addEventListener('click', () => menus.forEach((m) => setMenu(m, false)));
  document.addEventListener('keydown', (e) => {
    const open = menus.find((m) => !m.menu.hidden);
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      setMenu(open, false);
      open.btn.focus();
    }
  });

  // ---------------------------------------------------------------- preview size
  const thumb = $('thumb');
  const applyThumb = (px) => {
    grid.style.setProperty('--thumb', `${px}px`);
    $('thumbOut').textContent = `${px} px`;
  };
  thumb.value = settings.galleryThumbSize;
  applyThumb(settings.galleryThumbSize);
  thumb.oninput = () => applyThumb(+thumb.value);
  thumb.onchange = () => chrome.storage.sync.set({ galleryThumbSize: +thumb.value });

  // ---------------------------------------------------------------- minimum size
  // The slider only goes up to the largest size that still shows an image.
  // It is quadratic, so the small values most pages need get most of the travel.
  const STEPS = +minSel.max;
  let minMax = 0; // largest useful minimum for the images found
  let minWanted = settings.galleryMinSize; // what the user picked, may exceed minMax
  const niceRound = (v) => (v < 100 ? Math.round(v) : v < 1000 ? Math.round(v / 5) * 5 : Math.round(v / 10) * 10);
  const posToPx = (p) => (minMax ? Math.min(minMax, niceRound(minMax * (p / STEPS) ** 2)) : 0);
  const pxToPos = (px) => (minMax ? Math.round(Math.sqrt(Math.min(1, px / minMax)) * STEPS) : 0);
  const currentMin = () => Math.min(minWanted, minMax);

  function sizeOf(item) {
    return Math.min(item.w || item.desc.renderedWidth || 0, item.h || item.desc.renderedHeight || 0);
  }

  function updateMinRange() {
    minMax = items.reduce((m, i) => Math.max(m, sizeOf(i)), 0);
    minSel.disabled = !minMax;
    minSel.value = pxToPos(currentMin());
    $('minMax').textContent = `${minMax} px`;
    $('minOut').textContent = `${currentMin()} px`;
    $('minLabel').textContent = t('popup.minButton', { px: `${currentMin()} px` });
  }

  minSel.oninput = () => {
    minWanted = posToPx(+minSel.value);
    applyFilter();
  };
  minSel.onchange = () => chrome.storage.sync.set({ galleryMinSize: minWanted });

  function showEmpty(text) {
    empty.textContent = text;
    empty.hidden = false;
    grid.hidden = true;
  }

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => globalThis.__justjpg?.collectAll(16) ?? null,
    });
  } catch {
    showEmpty(t('popup.restricted'));
    return;
  }

  const seen = new Set();
  for (const r of results) {
    if (!Array.isArray(r.result)) continue;
    for (const desc of r.result) {
      const key = desc.srcs[0] || `${r.frameId}:${desc.token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ frameId: r.frameId, desc, w: desc.width || 0, h: desc.height || 0 });
    }
  }
  if (!results.some((r) => Array.isArray(r.result))) {
    showEmpty(t('popup.notReady'));
    return;
  }

  function formatOf(desc) {
    if (desc.kind === 'video') return t('popup.fmt.video');
    if (desc.kind === 'canvas') return 'Canvas';
    if (desc.kind === 'svg') return 'SVG';
    const src = desc.srcs[0] || '';
    if (src.startsWith('data:')) return (/^data:image\/([\w+.-]+)/.exec(src)?.[1] || 'data').replace('+xml', '');
    if (src.startsWith('blob:')) return 'blob';
    const ext = /\.([a-z0-9]{3,4})(?:[?#]|$)/i.exec(src)?.[1]?.toLowerCase();
    return ext && /^(jpe?g|png|webp|avif|gif|heic|heif|bmp|svg|ico|tiff?|jxl|jfif)$/.test(ext) ? ext : desc.kind === 'bg' ? 'CSS' : t('popup.fmt.image');
  }

  function render() {
    grid.textContent = '';
    for (const item of items) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      tile.tabIndex = 0;
      tile.innerHTML = '<div class="ph"></div><span class="box"></span><button class="one">JPG</button><div class="meta"><span class="fmt"></span><span class="dim"></span></div>';
      tile.querySelector('.one').title = t('popup.saveOne');
      tile.querySelector('.ph').textContent = formatOf(item.desc);
      tile.querySelector('.fmt').textContent = formatOf(item.desc).toUpperCase();
      const dim = tile.querySelector('.dim');
      const setDim = () => (dim.textContent = item.w && item.h ? `${item.w}x${item.h}` : '');
      setDim();
      if (item.desc.thumb) {
        const img = new Image();
        img.referrerPolicy = 'no-referrer';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.onload = () => {
          tile.querySelector('.ph').remove();
          if (!item.w && item.desc.kind !== 'svg') {
            item.w = img.naturalWidth;
            item.h = img.naturalHeight;
            setDim();
            applyFilter();
          }
        };
        img.onerror = () => img.remove();
        img.src = item.desc.thumb;
        tile.prepend(img);
      }
      const toggle = () => {
        if (selected.has(item)) selected.delete(item);
        else selected.add(item);
        tile.classList.toggle('selected', selected.has(item));
        updateButton();
      };
      tile.onclick = toggle;
      tile.onkeydown = (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          toggle();
        }
      };
      tile.querySelector('.one').onclick = (e) => {
        e.stopPropagation();
        save([item]);
      };
      item.tile = tile;
      grid.append(tile);
    }
    applyFilter();
  }

  function visibleItems() {
    return items.filter((i) => !i.tile.hidden);
  }

  function applyFilter() {
    updateMinRange();
    const min = currentMin();
    for (const item of items) {
      item.tile.hidden = sizeOf(item) < min;
      if (item.tile.hidden && selected.delete(item)) item.tile.classList.remove('selected');
    }
    const n = visibleItems().length;
    $('minInfo').textContent = t('popup.visibleOf', { n, total: items.length });
    $('count').textContent = t('popup.count', { n });
    if (!n) {
      empty.textContent = items.length ? t('popup.noneAtSize') : t('popup.none');
      empty.hidden = false;
    } else empty.hidden = true;
    updateButton();
  }

  function updateButton() {
    const vis = visibleItems();
    saveBtn.disabled = !selected.size;
    saveBtn.textContent = selected.size ? t('popup.saveN', { n: selected.size }) : t('popup.select');
    allBox.checked = vis.length > 0 && vis.every((i) => selected.has(i));
    allBox.indeterminate = !allBox.checked && vis.some((i) => selected.has(i));
  }

  allBox.onchange = () => {
    for (const item of visibleItems()) {
      if (allBox.checked) selected.add(item);
      else selected.delete(item);
      item.tile.classList.toggle('selected', allBox.checked);
    }
    updateButton();
  };

  let running = null;
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'batchProgress' || msg.tabId !== tab.id || !running) return;
    const item = running[msg.index];
    item?.tile.classList.add(msg.ok ? 'done' : 'fail');
    if (item && !msg.ok) item.tile.title = msg.error || t('popup.error');
    progress.firstElementChild.style.width = `${Math.round(((msg.done + msg.failed) / msg.total) * 100)}%`;
  });

  async function save(list) {
    if (!list.length || running) return;
    running = list;
    saveBtn.disabled = true;
    progress.hidden = false;
    progress.firstElementChild.style.width = '0';
    for (const i of list) i.tile.classList.remove('done', 'fail');
    const res = await chrome.runtime.sendMessage({
      type: 'saveBatch',
      tabId: tab.id,
      items: list.map((i) => ({ frameId: i.frameId, desc: i.desc })),
    });
    running = null;
    saveBtn.textContent = res?.failed?.length
      ? t('popup.resultPartial', { done: res.done, failed: res.failed.length })
      : t('popup.result', { n: res?.done ?? 0 });
    setTimeout(updateButton, 2500);
  }

  saveBtn.onclick = () => save(items.filter((i) => selected.has(i) && !i.tile.hidden));

  items.sort((a, b) => (b.w * b.h || b.desc.renderedWidth * b.desc.renderedHeight) - (a.w * a.h || a.desc.renderedWidth * a.desc.renderedHeight));
  render();
})();
