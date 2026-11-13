// data-v を持つ値にカーソルを当てると、10進・16進・2進を並べて出す
import { hex } from '../core/defs';

export function installValueTooltip() {
  const tip = document.createElement('div');
  tip.className = 'vtip';
  tip.hidden = true;
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let cur: Element | null = null;

  const place = (e: MouseEvent) => {
    const r = tip.getBoundingClientRect();
    let x = e.clientX + 14;
    let y = e.clientY + 18;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 12;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  };

  document.addEventListener('mouseover', (e) => {
    const t = (e.target as Element | null)?.closest?.('[data-v]') ?? null;
    if (t === cur) return;
    cur = t;
    if (!t) {
      tip.hidden = true;
      return;
    }
    const bits = Number(t.getAttribute('data-bits') ?? 32);
    const u = Number(t.getAttribute('data-v')) >>> 0;
    tip.innerHTML = valueTable(u, bits);
    tip.hidden = false;
    place(e);
  });
  document.addEventListener('mousemove', (e) => {
    if (cur) place(e);
  });
  document.addEventListener('scroll', () => {
    tip.hidden = true;
    cur = null;
  }, true);
}

function valueTable(u: number, bits: number): string {
  const mask = bits === 32 ? 0xffffffff : (1 << bits) - 1;
  const v = (u & mask) >>> 0;
  const signed = bits === 32 ? v | 0 : v >= 1 << (bits - 1) ? v - (1 << bits) : v;
  const bin = v.toString(2).padStart(bits, '0').replace(/(.{4})(?=.)/g, '$1 ');
  const hx = hex(v, bits / 4);
  let dec = String(signed);
  if (signed < 0) dec += `（符号なしなら ${v}）`;
  const ch = bits === 8 && v >= 32 && v < 127 ? `<tr><th>文字</th><td>'${String.fromCharCode(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}'</td></tr>` : '';
  return `<table><tr><th>10進</th><td>${dec}</td></tr><tr><th>16進</th><td>${hx}</td></tr><tr><th>2進</th><td>${bin}</td></tr>${ch}</table><div class="vtip-note">${bits} ビット</div>`;
}
