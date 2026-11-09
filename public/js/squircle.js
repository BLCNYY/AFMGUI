// Continuous-corner ("squircle") rectangle path, the corner style used across
// Apple's UI. Based on the corner-smoothing construction popularised by
// Figma (MIT-licensed figma-squircle by Pham Hoang Tien).

const rad = (deg) => (deg * Math.PI) / 180;

function corner(radius, smoothing, budget) {
  let r = Math.min(radius, budget);
  let p = (1 + smoothing) * r;
  const arcMeasure = 90 * (1 - smoothing);
  const arc = Math.sin(rad(arcMeasure / 2)) * r * Math.SQRT2;
  const alpha = (90 - arcMeasure) / 2;
  const p3ToP4 = r * Math.tan(rad(alpha / 2));
  const beta = 45 * smoothing;
  const c = p3ToP4 * Math.cos(rad(beta));
  const d = c * Math.tan(rad(beta));
  let b = (p - arc - c - d) / 3;
  let a = 2 * b;
  if (p > budget) {
    // Keep the smoothing, shrink the straight-ish part so it fits.
    const p1ToP3Max = budget - d - arc - c;
    const minA = p1ToP3Max / 6;
    const maxB = p1ToP3Max - minA;
    b = Math.min(b, maxB);
    a = p1ToP3Max - b;
    p = Math.min(p, budget);
  }
  return { a, b, c, d, p, arc, r };
}

const f = (n) => Math.round(n * 1000) / 1000;

export function squirclePath(width, height, radius, smoothing = 0.6, inset = 0) {
  const w = Math.max(0, width - inset * 2);
  const h = Math.max(0, height - inset * 2);
  const k = corner(radius, smoothing, Math.min(w, h) / 2);
  const { a, b, c, d, p, arc, r } = k;
  const o = inset;
  return [
    `M ${f(o + w - p)} ${f(o)}`,
    `c ${f(a)} 0 ${f(a + b)} 0 ${f(a + b + c)} ${f(d)}`,
    `a ${f(r)} ${f(r)} 0 0 1 ${f(arc)} ${f(arc)}`,
    `c ${f(d)} ${f(c)} ${f(d)} ${f(b + c)} ${f(d)} ${f(a + b + c)}`,
    `L ${f(o + w)} ${f(o + h - p)}`,
    `c 0 ${f(a)} 0 ${f(a + b)} ${f(-d)} ${f(a + b + c)}`,
    `a ${f(r)} ${f(r)} 0 0 1 ${f(-arc)} ${f(arc)}`,
    `c ${f(-c)} ${f(d)} ${f(-(b + c))} ${f(d)} ${f(-(a + b + c))} ${f(d)}`,
    `L ${f(o + p)} ${f(o + h)}`,
    `c ${f(-a)} 0 ${f(-(a + b))} 0 ${f(-(a + b + c))} ${f(-d)}`,
    `a ${f(r)} ${f(r)} 0 0 1 ${f(-arc)} ${f(-arc)}`,
    `c ${f(-d)} ${f(-c)} ${f(-d)} ${f(-(b + c))} ${f(-d)} ${f(-(a + b + c))}`,
    `L ${f(o)} ${f(o + p)}`,
    `c 0 ${f(-a)} 0 ${f(-(a + b))} ${f(d)} ${f(-(a + b + c))}`,
    `a ${f(r)} ${f(r)} 0 0 1 ${f(arc)} ${f(-arc)}`,
    `c ${f(c)} ${f(-d)} ${f(b + c)} ${f(-d)} ${f(a + b + c)} ${f(-d)}`,
    'Z',
  ].join(' ');
}

// One observer for every squircle on the page. Targets are held weakly, so
// message bubbles that leave the DOM are cleaned up on their own.
const updaters = new WeakMap();
const observer = new ResizeObserver((entries) => {
  for (const entry of entries) updaters.get(entry.target)?.();
});

// Draws a squircle background behind `el` and keeps it in sync with its size.
export function attachSquircle(el, { radius = 26, smoothing = 0.6 } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'squircle-bg');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('class', 'squircle-path');
  svg.append(path);
  el.prepend(svg);
  const update = () => {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (!w || !h) return;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    path.setAttribute('d', squirclePath(w, h, radius, smoothing, 0.5));
  };
  updaters.set(el, update);
  observer.observe(el);
  update();
  return update;
}
