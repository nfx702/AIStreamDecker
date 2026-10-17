// Key artwork: one SVG per (session, animation phase), rasterized by sharp and cached.
import sharp from 'sharp';
import fs from 'node:fs';

const icon = n => { try { return fs.readFileSync(new URL(`./assets/${n}.png`, import.meta.url)).toString('base64'); } catch { return null; } };
const ICON = { claude: icon('claude'), codex: icon('chatgpt'), gpt: icon('chatgpt') };
// palette of OpenAI x Work Louder "Codex Micro" (inactive / unread / thinking / needs approval / error), saturated a bit for the LCD
const COLOR = { attention: '#ffa77a', done: '#7cf27a', working: '#7cc8ff', idle: '#d8d8de', error: '#ff6b6b', unknown: '#c2afff' };

const esc = t => String(t).toWellFormed().replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
export const ago = ms => (ms < 60e3 ? '<1m' : ms < 3600e3 ? `${Math.floor(ms / 60e3)}m` : ms < 86400e3 ? `${Math.floor(ms / 3600e3)}h` : `${Math.floor(ms / 86400e3)}d`);

const chars = text => Array.from(String(text).toWellFormed());
const cut = (text, width) => chars(text).length > width ? chars(text).slice(0, width - 1).join('') + '…' : String(text);

export function wrap(title, width = 11, max = 3) {
  const lines = [''];
  for (const word of String(title).replace(/\s+/g, ' ').trim().split(' ')) {
    const letters = chars(word);
    while (letters.length) {
      const w = letters.splice(0, width).join(''), cur = lines.at(-1);
      if (!cur) lines[lines.length - 1] = w;
      else if (chars(cur + ' ' + w).length <= width) lines[lines.length - 1] += ' ' + w;
      else lines.push(w);
    }
  }
  // Preserve the ending: it often distinguishes "Fehler beheben" from "Fehler testen".
  return lines.length > max ? [...lines.slice(0, max - 1), '…' + chars(lines.at(-1)).slice(-(width - 1)).join('')] : lines;
}

export function sessionLabels(sessions) {
  const labels = new Map(), groups = new Map();
  for (const s of sessions) {
    let title = String(s.title || 'Sitzung');
    const prefix = s.projectLabel;
    if (prefix && title.toLowerCase().startsWith(prefix.toLowerCase() + ' ')) title = title.slice(prefix.length).trim();
    const lines = wrap(title), signature = lines.join('\n');
    labels.set(s.key, lines);
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(s.key);
  }
  for (const keys of groups.values()) if (keys.length > 1) keys.sort().forEach((key, i) => {
    const lines = labels.get(key), tag = ` #${i + 1}`;
    lines[lines.length - 1] = cut(lines.at(-1), Math.max(1, 11 - tag.length)) + tag;
  });
  return labels;
}

// animation phase quantized to `steps` per `period` ms, so identical frames hit the cache
const phase = (now, period, steps) => Math.floor((now % period) / (period / steps)) / steps;
const border = (attrs) => `<rect x="1.5" y="1.5" width="69" height="69" rx="11" fill="none" ${attrs}/>`;

function stateLayer(st, now, since) {
  const c = COLOR[st];
  const animate = st === 'attention' || (st === 'done' && now - since >= 0 && now - since < 4000);
  const p = animate ? 0.5 + 0.5 * Math.cos(2 * Math.PI * phase(now, 1200, 8)) : 0;
  const symbol = { attention: '?', error: '!', done: '✓', working: '•', unknown: '–', idle: '' }[st];
  return {
    tint: st === 'idle' ? 0.06 : 0.14 + 0.18 * p,
    layer: border(`stroke="${c}" stroke-width="${(1.5 + p * 1.5).toFixed(1)}" stroke-opacity="${st === 'idle' ? 0.16 : 0.8}" ${st === 'unknown' ? 'stroke-dasharray="4 3"' : ''}`),
    badge: symbol ? `<text x="63" y="15" text-anchor="middle" font-size="12" font-weight="800" fill="${c}">${symbol}</text>` : '',
    dim: st === 'idle',
  };
}

export function svg(s, size, now) {
  const st = Object.hasOwn(COLOR, s.eff) ? s.eff : 'unknown';
  const { tint, layer, badge, dim } = stateLayer(st, now, s.since);
  const c = COLOR[st], lines = s.lines ?? wrap(s.title);
  const y0 = lines.length === 1 ? 42 : lines.length === 2 ? 35 : 29;
  const title = lines.map((l, i) => `<text x="36" y="${y0 + i * 11.5}" text-anchor="middle" font-size="10.5" font-weight="700" fill="${dim ? '#babac2' : '#fff'}">${esc(l)}</text>`).join('');
  const age = ago(Math.max(0, now - (s.since || now)));
  const footer = s.notice || (s.inactive ? 'Nicht aktiv' : st === 'unknown' ? (s.lastOk ? `Stand ${ago(Math.max(0, now - s.lastOk))}` : 'Keine Daten') : `${{ attention: 'Wartet', error: 'Fehler', done: 'Fertig', working: 'Aktiv', idle: 'Ruht' }[st]} ${age}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 72 72" font-family="Helvetica Neue, Helvetica, Arial">
<defs><radialGradient id="g" cx="50%" cy="28%" r="75%"><stop offset="0" stop-color="${c}" stop-opacity="${tint.toFixed(2)}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>
<filter id="gray"><feColorMatrix type="saturate" values="0"/></filter></defs>
<rect width="72" height="72" fill="#060608"/><rect width="72" height="72" fill="url(#g)"/>${layer}
<g ${dim ? 'filter="url(#gray)" opacity="0.6"' : ''}>${ICON[s.app] ? `<image href="data:image/png;base64,${ICON[s.app]}" x="6" y="6" width="12" height="12"/>` : `<text x="12" y="15" text-anchor="middle" font-size="8" font-weight="700" fill="#fff">${s.app === 'claude' ? 'C' : 'AI'}</text>`}</g>
<text x="21" y="14" font-size="6.7" fill="#b0b0bc">${esc(cut(st === 'unknown' ? 'Unbekannt' : s.projectLabel || (s.app === 'claude' ? 'Claude' : 'Codex'), 9))}</text>
<text x="6" y="65" font-size="6.5" fill="${s.notice ? '#ffa77a' : c}">${esc(cut(footer, s.pinned ? 15 : 18))}</text>
${s.pinned ? '<path d="M60 59h5l-1 3 2 2h-3v4h-1v-4h-3l2-2z" fill="#e5d5a0"/>' : ''}${badge}${title}</svg>`;
}

export function controlSvg(size, title, lines = [], footer = '', color = '#b9c3d3') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 72 72" font-family="Helvetica Neue, Helvetica, Arial">
<rect width="72" height="72" fill="#10151e"/>${border(`stroke="${color}" stroke-opacity="0.45" stroke-width="1.5"`)}
<text x="36" y="15" text-anchor="middle" font-size="8" font-weight="700" fill="${color}">${esc(cut(title, 13))}</text>
${lines.slice(0, 3).map((line, i) => `<text x="36" y="${31 + i * 11}" text-anchor="middle" font-size="10" font-weight="700" fill="#fff">${esc(cut(line, 12))}</text>`).join('')}
<text x="36" y="65" text-anchor="middle" font-size="6.5" fill="${color}">${esc(cut(footer, 19))}</text></svg>`;
}

export function pagerSvg(size, page, pages) {
  return controlSvg(size, 'Seite', [`${page + 1} / ${pages}`, pages > 1 ? 'Weiter ›' : 'Eine Seite'], pages > 1 ? 'Halten: zurück' : '');
}

export function projectSvg(group, size) {
  const lines = wrap(group.title, 12, 2);
  if (group.unknown) lines.push(`${group.unknown} unbekannt`);
  return controlSvg(size, 'Projekt', lines, `${group.working} aktiv · ${group.attention} wartet`, COLOR[group.eff]);
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
