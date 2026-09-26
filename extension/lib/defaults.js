// Shared settings + filename helpers. Loaded as a classic script (content
// script, options page, popup) and imported as a module by the service worker,
// so it only writes to globalThis and has no exports.
(() => {
  const DEFAULTS = {
    language: 'en', // 'auto' or a code from translations.js
    // Trigger
    contextMenu: true,
    hoverButton: true,
    hoverMinSize: 120,
    hoverPosition: 'top-right',
    unblockContextMenu: true,

    // Saving
    saveMode: 'direct', // 'direct' | 'ask'
    subfolder: 'JustJPG',
    conflictAction: 'uniquify', // 'uniquify' | 'overwrite'

    // Conversion
    quality: 92,
    background: '#ffffff',
    keepJpeg: true,
    preferLargest: true,
    screenshotFallback: true,

    // Filename
    filenameTemplate: '{name}',
    fallbackTemplate: '{domain}_{date}_{time}',
    crypticFallback: true,
    lowercase: false,
    spaceReplacement: '_', // '_' | '-' | ' '
    maxNameLength: 120,

    // Feedback / gallery
    showToast: true,
    galleryMinSize: 60,
    galleryThumbSize: 130,
  };

  // Labels live in translations.js as 'preset.<id>' and 'ph.<name>'.
  const PRESETS = [
    { id: 'original', template: '{name}' },
    { id: 'domain-time', template: '{domain}_{date}_{time}' },
    { id: 'title', template: '{title}' },
    { id: 'title-index', template: '{title}_{index}' },
    { id: 'alt', template: '{alt}' },
    { id: 'domain-name', template: '{domain}_{name}' },
    { id: 'date-name', template: '{date}_{name}' },
    { id: 'counter', template: 'JustJPG_{counter}' },
    { id: 'size', template: '{name}_{width}x{height}' },
    { id: 'timestamp', template: '{timestamp}' },
  ];

  const PLACEHOLDERS = ['name', 'domain', 'title', 'alt', 'date', 'time', 'year', 'month', 'day', 'timestamp', 'counter', 'index', 'width', 'height', 'format', 'random'];

  const GENERIC_NAMES = new Set([
    'image', 'img', 'images', 'photo', 'picture', 'pic', 'download', 'file', 'index',
    'default', 'media', 'unnamed', 'blob', 'original', 'large', 'small', 'medium',
    'thumbnail', 'thumb', 'full', 'raw', 'content', 'render', 'get', 'view', 'show',
    'fetch', 'proxy', 'cdn', 'asset', 'assets', 'untitled', 'screenshot', 'frame',
  ]);

  function isCryptic(name) {
    if (!name) return true;
    const n = name.trim();
    if (n.length < 2) return true;
    if (GENERIC_NAMES.has(n.toLowerCase())) return true;
    // hex hashes, uuids
    if (/^[a-f0-9-]{16,}$/i.test(n)) return true;
    // base64 / random ids: long, no separators, mixed letters + digits
    if (n.length >= 20 && /^[A-Za-z0-9_-]+$/.test(n) && /\d/.test(n) && /[a-z]/.test(n) && /[A-Z]/.test(n)) return true;
    // purely numeric ids that are long (e.g. 1729384756123)
    if (/^\d{9,}$/.test(n)) return true;
    return false;
  }

  function baseNameFromUrl(url) {
    if (!url || /^(data|blob):/i.test(url)) return '';
    try {
      const u = new URL(url);
      let last = u.pathname.split('/').filter(Boolean).pop() || '';
      last = decodeURIComponent(last);
      last = last.replace(/\.[a-z0-9]{2,5}$/i, '');
      // some CDNs put the name in a query param
      if (!last || isCryptic(last)) {
        for (const key of ['filename', 'file', 'name', 'title']) {
          const v = u.searchParams.get(key);
          if (v) return v.replace(/\.[a-z0-9]{2,5}$/i, '');
        }
      }
      return last;
    } catch {
      return '';
    }
  }

  function domainOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return 'page';
    }
  }

  const pad = (n, l = 2) => String(n).padStart(l, '0');

  function sanitizeSegment(s, opts) {
    let out = String(s)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[<>:"/\\|?*~]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const rep = opts.spaceReplacement ?? '_';
    if (rep !== ' ') out = out.replace(/ /g, rep);
    // collapse repeated separators
    out = out.replace(/([_-])\1+/g, '$1').replace(/^[._\s-]+|[._\s-]+$/g, '');
    if (opts.lowercase) out = out.toLowerCase();
    const max = Math.max(10, Number(opts.maxNameLength) || 120);
    if (out.length > max) out = out.slice(0, max).replace(/[._\s-]+$/g, '');
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(out)) out = '_' + out;
    return out;
  }

  // info: { srcUrl, pageUrl, pageTitle, alt, width, height, format, index }
  function buildFilename(settings, info, now = new Date()) {
    const original = baseNameFromUrl(info.srcUrl);
    const values = {
      name: original,
      domain: domainOf(info.pageUrl || info.srcUrl),
      title: (info.pageTitle || '').trim(),
      alt: (info.alt || '').trim(),
      date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      time: `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`,
      year: String(now.getFullYear()),
      month: pad(now.getMonth() + 1),
      day: pad(now.getDate()),
      timestamp: String(now.getTime()),
      counter: pad(info.counter ?? 1, 4),
      index: pad(info.index ?? 1, 3),
      width: info.width ? String(info.width) : '',
      height: info.height ? String(info.height) : '',
      format: info.format || '',
      random: Math.random().toString(36).slice(2, 8),
    };

    const fill = (tpl) => tpl.replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));

    let template = settings.filenameTemplate || '{name}';
    const usesName = /\{name\}/.test(template);
    const usesAlt = /\{alt\}/.test(template);
    if (settings.crypticFallback) {
      if ((usesName && isCryptic(original)) || (usesAlt && !values.alt)) {
        template = settings.fallbackTemplate || '{domain}_{date}_{time}';
      }
    }
    let name = sanitizeSegment(fill(template), settings);
    if (!name) name = sanitizeSegment(fill('{domain}_{date}_{time}'), settings);

    const folder = String(settings.subfolder || '')
      .split(/[\\/]+/)
      .map((seg) => sanitizeSegment(fill(seg), { ...settings, lowercase: false }))
      .filter(Boolean)
      .join('/');
    return (folder ? folder + '/' : '') + name + '.jpg';
  }

  globalThis.JustJPG = { DEFAULTS, PRESETS, PLACEHOLDERS, isCryptic, baseNameFromUrl, domainOf, buildFilename };
})();
