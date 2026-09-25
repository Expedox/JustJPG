// JustJPG offscreen document: downloads image bytes with the extension's host
// permissions (no CORS), decodes everything Chrome can decode plus HEIC/HEIF
// via a bundled libheif WASM build, and encodes to JPEG. Everything stays local.

const MAX_AREA = 16384 * 16384;
let libheif = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  const run = msg.type === 'crop' ? crop(msg) : convert(msg);
  run.then(
    (value) => sendResponse({ ok: true, value }),
    (err) => sendResponse({ ok: false, error: String(err?.message || err), code: err?.code })
  );
  return true;
});

class ConvertError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- fetch
async function load(url) {
  let res;
  try {
    res = await fetch(url, { credentials: 'include', cache: 'force-cache', redirect: 'follow' });
  } catch (e) {
    throw new ConvertError(`Download fehlgeschlagen (${e.message})`, 'fetch');
  }
  if (!res.ok) throw new ConvertError(`Server antwortet mit HTTP ${res.status}`, 'fetch');
  const blob = await res.blob();
  if (!blob.size) throw new ConvertError('Leere Antwort vom Server', 'fetch');
  return blob;
}

// ---------------------------------------------------------------- sniffing
const ascii = (b, s, e) => String.fromCharCode(...b.subarray(s, e));

async function sniff(blob) {
  const b = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return 'png';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  if (ascii(b, 0, 4) === 'GIF8') return 'gif';
  if (ascii(b, 0, 2) === 'BM') return 'bmp';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'ico';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return 'tiff';
  if ((b[0] === 0xff && b[1] === 0x0a) || ascii(b, 4, 8) === 'JXL ') return 'jxl';
  if (ascii(b, 4, 8) === 'ftyp') {
    const size = Math.min(new DataView(b.buffer).getUint32(0), b.length);
    const brands = [ascii(b, 8, 12)];
    for (let i = 16; i + 4 <= size; i += 4) brands.push(ascii(b, i, i + 4));
    if (brands.some((x) => x === 'avif' || x === 'avis')) return 'avif';
    if (brands.some((x) => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'heif'].includes(x))) return 'heic';
    return 'mp4';
  }
  const head = new TextDecoder().decode(b).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg')) || (head.startsWith('<!--') && head.includes('<svg'))) return 'svg';
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';
  const type = (blob.type || '').toLowerCase();
  if (type.includes('svg')) return 'svg';
  if (type.startsWith('image/')) return type.slice(6).replace('x-', '');
  return 'unknown';
}

// ---------------------------------------------------------------- decoding
function loadImageElement(blob, type) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(type ? new Blob([blob], { type }) : blob);
    const img = new Image();
    img.decoding = 'sync';
    img.onload = () => resolve({ img, revoke: () => URL.revokeObjectURL(url) });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Bild konnte nicht dekodiert werden'));
    };
    img.src = url;
  });
}

async function decodeHeic(blob) {
  if (!libheif) {
    const mod = await import('./lib/libheif/libheif-bundle.mjs');
    libheif = mod.default();
  }
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(new Uint8Array(await blob.arrayBuffer()));
  if (!images?.length) throw new ConvertError('HEIC-Datei enthält kein Bild', 'decode');
  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();
  const imageData = new ImageData(width, height);
  await new Promise((resolve, reject) => {
    image.display(imageData, (out) => (out ? resolve() : reject(new ConvertError('HEIC-Dekodierung fehlgeschlagen', 'decode'))));
  });
  for (const im of images) im.free?.();
  const bitmap = await createImageBitmap(imageData);
  return { source: bitmap, width, height, opaque: true };
}

async function decode(blob, format, hint) {
  if (format === 'html') throw new ConvertError('Server liefert eine Webseite statt eines Bildes (Hotlink-Schutz)', 'fetch');

  if (format === 'svg') {
    const { img, revoke } = await loadImageElement(blob, 'image/svg+xml');
    let w = img.naturalWidth || hint?.width || 1024;
    let h = img.naturalHeight || hint?.height || 1024;
    // render vector graphics at least at the on-screen pixel size, min 1024px
    const target = Math.max(hint?.width || 0, 1024);
    const scale = Math.max(1, target / Math.max(w, h));
    w = Math.round(w * scale);
    h = Math.round(h * scale);
    return { source: img, width: w, height: h, cleanup: revoke };
  }

  if (format !== 'heic') {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      // fall through
    }
  }
  if (format === 'heic' || format === 'mp4') {
    try {
      return await decodeHeic(blob);
    } catch (e) {
      if (format === 'heic') throw e instanceof ConvertError ? e : new ConvertError(`HEIC-Fehler: ${e.message}`, 'decode');
    }
  }
  try {
    const { img, revoke } = await loadImageElement(blob);
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, cleanup: revoke };
  } catch {
    throw new ConvertError(`Format "${format}" kann nicht gelesen werden`, 'decode');
  }
}

// ---------------------------------------------------------------- encoding
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

async function encodeJpeg(source, width, height, { quality, background }, crop) {
  let scale = 1;
  if (width * height > MAX_AREA) scale = Math.sqrt(MAX_AREA / (width * height));
  const w = Math.max(1, Math.floor(width * scale));
  const h = Math.max(1, Math.floor(height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = background || '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  if (crop) ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);
  else ctx.drawImage(source, 0, 0, w, h);
  const q = Math.min(1, Math.max(0.1, (Number(quality) || 92) / 100));
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: q });
  return { dataUrl: await blobToDataUrl(blob), width: w, height: h, bytes: blob.size };
}

// ---------------------------------------------------------------- API
async function convert({ url, options, hint }) {
  const blob = await load(url);
  const format = await sniff(blob);

  if (format === 'jpeg' && options.keepJpeg) {
    let width = 0;
    let height = 0;
    try {
      const bm = await createImageBitmap(blob);
      width = bm.width;
      height = bm.height;
      bm.close();
    } catch {}
    const jpeg = blob.type === 'image/jpeg' ? blob : new Blob([blob], { type: 'image/jpeg' });
    return { dataUrl: await blobToDataUrl(jpeg), width, height, format, kept: true, bytes: blob.size };
  }

  const decoded = await decode(blob, format, hint);
  try {
    const out = await encodeJpeg(decoded.source, decoded.width, decoded.height, options);
    return { ...out, format, kept: false };
  } finally {
    decoded.source.close?.();
    decoded.cleanup?.();
  }
}

async function crop({ url, rect, vw, options }) {
  const blob = await load(url);
  const bitmap = await createImageBitmap(blob);
  // screenshot pixels per CSS pixel (device pixel ratio x zoom)
  const scale = bitmap.width / vw;
  try {
    const sx = Math.max(0, Math.round(rect.left * scale));
    const sy = Math.max(0, Math.round(rect.top * scale));
    const sw = Math.min(bitmap.width - sx, Math.round((rect.right - rect.left) * scale));
    const sh = Math.min(bitmap.height - sy, Math.round((rect.bottom - rect.top) * scale));
    if (sw < 1 || sh < 1) throw new ConvertError('Ausschnitt ist leer', 'capture');
    const out = await encodeJpeg(bitmap, sw, sh, options, { sx, sy, sw, sh });
    return { ...out, format: 'screenshot', kept: false };
  } finally {
    bitmap.close();
  }
}
