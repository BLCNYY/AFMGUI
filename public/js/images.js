// Image preparation: decode, fix orientation, flatten transparency onto white
// (the model sees transparent pixels as black) and downscale.

export const IMAGE_MAX = 1024; // what the model receives
export const THUMB_MAX = 320; // what we keep in chat history

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|avif)$/i;

export function isImageFile(file) {
  return (file.type && file.type.startsWith('image/')) || IMAGE_EXT.test(file.name || '');
}

async function decode(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall through to <img> decoding (e.g. HEIC in Safari) */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function sizeOf(src) {
  return { w: src.naturalWidth || src.width, h: src.naturalHeight || src.height };
}

function render(src, max, quality) {
  let { w, h } = sizeOf(src);
  const scale = Math.min(1, max / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));

  // Halve in steps for a sharper result on big downscales.
  let current = src;
  while (w / 2 > tw * 1.05 && h / 2 > th * 1.05) {
    w = Math.round(w / 2);
    h = Math.round(h / 2);
    const step = document.createElement('canvas');
    step.width = w;
    step.height = h;
    const sctx = step.getContext('2d');
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(current, 0, 0, w, h);
    current = step;
  }

  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, tw, th);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(current, 0, 0, tw, th);
  return canvas.toDataURL('image/jpeg', quality);
}

export async function prepareImage(file) {
  const src = await decode(file);
  const { w, h } = sizeOf(src);
  if (!w || !h) throw new Error('Empty image');
  const full = render(src, IMAGE_MAX, 0.85);
  const thumb = render(src, THUMB_MAX, 0.8);
  src.close?.();
  return { full, thumb };
}
