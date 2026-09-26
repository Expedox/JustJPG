(async () => {
  const { DEFAULTS, PRESETS, PLACEHOLDERS, buildFilename } = globalThis.JustJPG;
  const i18n = globalThis.JustJPGi18n;
  const { t } = i18n;
  const $ = (id) => document.getElementById(id);
  await i18n.init();
  let settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };

  const inputs = [...document.querySelectorAll('[data-key]')];
  const template = $('template');
  const preset = $('preset');

  // ---------------------------------------------------------------- language
  const language = $('language');
  language.add(new Option(t('opt.languageAuto'), 'auto'));
  for (const { code, name } of i18n.languages()) language.add(new Option(name, code));

  // Texts that are built in JS; re-run whenever the language changes.
  function renderTexts() {
    i18n.applyTo(document);
    language.options[0].text = t('opt.languageAuto');
    preset.textContent = '';
    for (const p of PRESETS) preset.add(new Option(`${t('preset.' + p.id)}  -  ${p.template}`, p.id));
    preset.add(new Option(t('opt.customTemplate'), 'custom'));
    for (const chip of $('placeholders').children) chip.title = t('ph.' + chip.dataset.ph);
    renderShortcuts();
    refresh();
  }
  i18n.onChange(renderTexts);

  // ---------------------------------------------------------------- presets + placeholders
  preset.onchange = () => {
    const p = PRESETS.find((x) => x.id === preset.value);
    if (!p) return template.focus();
    template.value = p.template;
    save('filenameTemplate', p.template);
  };

  for (const name of PLACEHOLDERS) {
    const ph = `{${name}}`;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = ph;
    b.dataset.ph = name;
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
    $('saved').textContent = t('opt.saved');
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
      srcUrl: `https://cdn.example.com/media/${t('opt.sampleFile')}.webp`,
      pageUrl: 'https://www.example.com/gallery',
      pageTitle: t('opt.sampleTitle'),
      alt: t('opt.sampleAlt'),
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
  function renderShortcuts() {
    const labels = { 'save-under-cursor': 'opt.shortcutCursor', 'save-visible': 'opt.shortcutVisible' };
    $('shortcuts').textContent =
      commands
        .filter((c) => labels[c.name])
        .map((c) => `${t(labels[c.name])}: ${c.shortcut || t('opt.shortcutNone')}`)
        .join('  |  ') || t('opt.shortcutNone');
  }
  $('editShortcuts').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });

  // ---------------------------------------------------------------- reset
  $('reset').onclick = async () => {
    if (!confirm(t('opt.resetConfirm'))) return;
    await chrome.storage.sync.clear();
    settings = { ...DEFAULTS };
    fill();
  };

  renderTexts();
  fill();
})();
