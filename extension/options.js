(async () => {
  const { DEFAULTS, PRESETS, PLACEHOLDERS, buildFilename } = globalThis.JustJPG;
  const $ = (id) => document.getElementById(id);
  let settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };

  const inputs = [...document.querySelectorAll('[data-key]')];
  const template = $('template');
  const preset = $('preset');

  // ---------------------------------------------------------------- presets + placeholders
  for (const p of PRESETS) preset.add(new Option(`${p.label}  -  ${p.template}`, p.id));
  preset.add(new Option('Eigenes Muster', 'custom'));
  preset.onchange = () => {
    const p = PRESETS.find((x) => x.id === preset.value);
    if (!p) return template.focus();
    template.value = p.template;
    save('filenameTemplate', p.template);
  };

  for (const [ph, label] of Object.entries(PLACEHOLDERS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = ph;
    b.title = label;
    b.onclick = () => {
      const { selectionStart: s = template.value.length, selectionEnd: e = s } = template;
      template.setRangeText(ph, s, e, 'end');
      template.focus();
      save('filenameTemplate', template.value);
    };
    $('placeholders').append(b);
  }

  // ---------------------------------------------------------------- bind inputs
  function fill() {
    for (const el of inputs) {
      const v = settings[el.dataset.key];
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.type === 'radio') el.checked = el.value === v;
      else el.value = v;
    }
    refresh();
  }

  function readValue(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number' || el.type === 'range') {
      const n = Number(el.value);
      const min = el.min === '' ? -Infinity : Number(el.min);
      const max = el.max === '' ? Infinity : Number(el.max);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : DEFAULTS[el.dataset.key];
    }
    return el.value;
  }

  let savedTimer = 0;
  async function save(key, value) {
    settings[key] = value;
    await chrome.storage.sync.set({ [key]: value });
    refresh();
    $('saved').textContent = 'Gespeichert';
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => ($('saved').textContent = ''), 1500);
  }

  for (const el of inputs) {
    const evt = el.type === 'text' || el.type === 'range' || el.type === 'color' ? 'input' : 'change';
    el.addEventListener(evt, () => {
      if (el.type === 'radio' && !el.checked) return;
      save(el.dataset.key, readValue(el));
    });
    if (el.type === 'number') el.addEventListener('blur', () => (el.value = settings[el.dataset.key]));
  }

  for (const chip of document.querySelectorAll('[data-color]')) {
    chip.onclick = () => {
      document.querySelector('[data-key=background]').value = chip.dataset.color;
      save('background', chip.dataset.color);
    };
  }

  function refresh() {
    $('qualityOut').textContent = settings.quality;
    for (const el of document.querySelectorAll('[data-show]')) el.hidden = !settings[el.dataset.show];
    const match = PRESETS.find((p) => p.template === settings.filenameTemplate);
    preset.value = match ? match.id : 'custom';
    const sample = {
      srcUrl: 'https://cdn.example.com/media/sonnenuntergang-am-meer.webp',
      pageUrl: 'https://www.example.com/galerie',
      pageTitle: 'Urlaub 2026 - Galerie',
      alt: 'Sonnenuntergang am Meer',
      width: 1920,
      height: 1080,
      format: 'webp',
      index: 1,
      counter: currentCounter,
    };
    $('preview').textContent = buildFilename(settings, sample);
  }

  // ---------------------------------------------------------------- counter
  let currentCounter = (await chrome.storage.local.get('counter')).counter || 1;
  $('counter').textContent = currentCounter;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.counter) {
      currentCounter = changes.counter.newValue;
      $('counter').textContent = currentCounter;
      refresh();
    }
  });
  $('resetCounter').onclick = () => chrome.storage.local.set({ counter: 1 });

  // ---------------------------------------------------------------- shortcuts
  const commands = await chrome.commands.getAll();
  const labels = { 'save-under-cursor': 'Bild unter Mauszeiger', 'save-visible': 'Sichtbarer Bereich' };
  $('shortcuts').textContent =
    commands
      .filter((c) => labels[c.name])
      .map((c) => `${labels[c.name]}: ${c.shortcut || 'nicht belegt'}`)
      .join('  |  ') || 'nicht belegt';
  $('editShortcuts').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });

  // ---------------------------------------------------------------- reset
  $('reset').onclick = async () => {
    if (!confirm('Alle Einstellungen auf Standard zurücksetzen?')) return;
    await chrome.storage.sync.clear();
    settings = { ...DEFAULTS };
    fill();
  };

  fill();
})();
