// Key artwork: one SVG per (session, animation phase), rasterized by sharp and cached.
import sharp from 'sharp';
import fs from 'node:fs';

const icon = n => { try { return fs.readFileSync(new URL(`./assets/${n}.png`, import.meta.url)).toString('base64'); } catch { return null; } };
const ICON = { claude: icon('claude'), codex: icon('chatgpt'), gpt: icon('chatgpt') };
const P = 257.1; // perimeter of the rounded border rect (4 * (69 - 22) + 2π * 11)
// palette of OpenAI x Work Louder "Codex Micro" (inactive / unread / thinking / needs approval / error), saturated a bit for the LCD
const COLOR = { attention: '#ffa77a', done: '#7cf27a', working: '#7cc8ff', idle: '#d8d8de', error: '#ff6b6b' };

const esc = t => String(t).toWellFormed().replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
export const ago = ms => (ms < 60e3 ? '<1m' : ms < 3600e3 ? `${Math.floor(ms / 60e3)}m` : ms < 86400e3 ? `${Math.floor(ms / 3600e3)}h` : `${Math.floor(ms / 86400e3)}d`);

export function wrap(title, width = 12, max = 2) {
  const lines = [''];
  for (const w of String(title).replace(/\s+/g, ' ').trim().split(' ')) {
    const cur = lines[lines.length - 1];
    if (!cur) lines[lines.length - 1] = w;
    else if ((cur + ' ' + w).length <= width) lines[lines.length - 1] += ' ' + w;
    else lines.push(w);
  }
  const out = lines.map(l => (l.length > width ? l.slice(0, width - 1) + '…' : l));
  if (out.length > max) { out.length = max; out[max - 1] = out[max - 1].slice(0, width - 1) + '…'; }
  return out;
}

// animation phase quantized to `steps` per `period` ms, so identical frames hit the cache
const phase = (now, period, steps) => Math.floor((now % period) / (period / steps)) / steps;
const border = (attrs) => `<rect x="1.5" y="1.5" width="69" height="69" rx="11" fill="none" ${attrs}/>`;

function stateLayer(st, now) {
  const c = COLOR[st];
  if (st === 'working') {
    const head = phase(now, 2000, 24) * P;
    const comet = [[95, 8, 0.18], [55, 4.5, 0.5], [20, 2.5, 1]].map(([len, w, op]) =>
      border(`stroke="${op === 1 ? '#effbff' : c}" stroke-width="${w}" stroke-opacity="${op}" stroke-linecap="round" stroke-dasharray="${len} ${P - len}" stroke-dashoffset="${(len - head).toFixed(1)}"`)).join('');
    return { tint: 0.32, layer: border(`stroke="${c}" stroke-opacity="0.22" stroke-width="2"`) + `<g filter="url(#glow)">${comet}</g>` + comet, badge: '' };
  }
  if (st === 'attention' || st === 'error') {
    const p = 0.5 + 0.5 * Math.cos(2 * Math.PI * phase(now, 900, 8));
    return {
      tint: 0.25 + 0.55 * p,
      layer: border(`stroke="${c}" stroke-width="${(2 + 2.5 * p).toFixed(2)}"`),
      wiggle: 10 * Math.sin(4 * Math.PI * phase(now, 900, 8)),
      badge: st === 'error'
        ? `<circle cx="61" cy="11" r="8.5" fill="${c}"/><path d="M57.5 7.5l7 7m0-7l-7 7" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>`
        : `<circle cx="61" cy="11" r="8.5" fill="${c}"/><text x="61" y="15.5" text-anchor="middle" font-size="13" font-weight="900" fill="#3a1a0a">?</text>`,
    };
  }
  if (st === 'done') {
    const p = 0.5 + 0.5 * Math.cos(2 * Math.PI * phase(now, 2400, 12));
    return {
      tint: 0.2 + 0.2 * p,
      layer: border(`stroke="${c}" stroke-width="2.5" stroke-opacity="${(0.5 + 0.5 * p).toFixed(2)}"`),
      badge: `<circle cx="61" cy="11" r="8.5" fill="${c}"/><path d="M56.8 11.2l2.9 2.9 5.4-5.6" fill="none" stroke="#0b3a0b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
    };
  }
  // idle: dimmed, slowly "snoring"
  const z = Math.round(phase(now, 4000, 4) * 4);
  const zzz = [...'zzz'].slice(0, z).map((ch, i) => `<text x="${55 + i * 5}" y="${16 - i * 4}" font-size="${7 + i * 2}" font-weight="700" fill="${c}" fill-opacity="0.8">${ch}</text>`).join('');
  return { tint: 0.12, layer: '', badge: zzz, dim: true };
}

export function svg(s, size, now) {
  const { tint, layer, badge, wiggle = 0, dim } = stateLayer(s.eff, now);
  const c = COLOR[s.eff];
  const lines = wrap(s.title);
  const y0 = lines.length === 1 ? 57 : 52;
  const title = lines.map((l, i) => `<text x="36" y="${y0 + i * 10.5}" text-anchor="middle" font-size="9.5" font-weight="700" fill="${dim ? '#9a9aa0' : '#fff'}">${esc(l)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 72 72" font-family="Helvetica Neue, Helvetica, Arial">
<defs><radialGradient id="g" cx="50%" cy="28%" r="75%"><stop offset="0" stop-color="${c}" stop-opacity="${tint.toFixed(2)}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>
<filter id="gray"><feColorMatrix type="saturate" values="0"/></filter><filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3"/></filter></defs>
<rect width="72" height="72" fill="#060608"/><rect width="72" height="72" fill="url(#g)"/>${layer}
<g ${dim ? 'filter="url(#gray)" opacity="0.45"' : ''} transform="rotate(${wiggle.toFixed(1)} 36 23)">${ICON[s.app] ? `<image href="data:image/png;base64,${ICON[s.app]}" x="22" y="9" width="28" height="28"/>` : `<text x="36" y="31" text-anchor="middle" font-size="22" font-weight="700" fill="#fff">${s.app === 'claude' ? 'C' : 'AI'}</text>`}</g>
<text x="6" y="12" font-size="8.5" font-weight="600" fill="${dim ? '#77777d' : '#d0d0d6'}">${esc(ago(now - s.since))}</text>${badge}${title}</svg>`;
}

export function pagerSvg(size, page, pages, hidden) {
  const dots = Array.from({ length: pages }, (_, i) =>
    `<circle cx="${36 + (i - (pages - 1) / 2) * 9}" cy="60" r="${i === page ? 3 : 2}" fill="${i === page ? '#fff' : '#55555c'}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 72 72" font-family="Helvetica Neue, Helvetica, Arial">
<rect width="72" height="72" fill="#101014"/>${border('stroke="#3a3a40" stroke-width="1.5"')}
<path d="${page === pages - 1 ? 'M42 20l-10 9 10 9' : 'M31 20l10 9-10 9'}" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
<text x="36" y="47" text-anchor="middle" font-size="9" font-weight="600" fill="#9a9aa0">${page === 0 ? `+${hidden} more` : `${page + 1} / ${pages}`}</text>${dots}</svg>`;
}

const cache = new Map();
export async function render(svgText) {
  let b = cache.get(svgText);
  if (!b) {
    b = await sharp(Buffer.from(svgText)).removeAlpha().raw().toBuffer();
    if (cache.size >= 1024) cache.delete(cache.keys().next().value);
    cache.set(svgText, b);
  }
  return b;
}
