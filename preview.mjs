// Renders the session deck and project overview: `node preview.mjs`
import sharp from 'sharp';
import fs from 'node:fs';
import { svg, pagerSvg, controlSvg, projectSvg, sessionLabels } from './render.mjs';
import { projectGroups } from './model.mjs';

const SIZE = 144, GAP = 10, FPS = 12, SECONDS = 4;
const t0 = 1_800_000_000_000;
const tiles = [
  { app: 'claude', eff: 'attention', projectLabel: 'Shop', title: 'Shop Checkout Fehler beheben', pinned: true, since: t0 - 95e3 },
  { app: 'claude', eff: 'working', projectLabel: 'Deck', title: 'Schnellere Tasten', since: t0 - 12 * 60e3 },
  { app: 'codex', eff: 'working', projectLabel: 'Platform', title: 'API gateway', since: t0 - 3 * 60e3 },
  { app: 'codex', eff: 'done', projectLabel: 'Ops', title: 'Build prüfen', since: t0 - 3000 },
  { app: 'claude', eff: 'idle', projectLabel: 'Home', title: 'Mini-PC starten', since: t0 - 26 * 3600e3 },
  { app: 'codex', eff: 'error', projectLabel: 'Ops', title: 'Deploy pipeline', since: t0 - 7 * 60e3 },
  { app: 'claude', eff: 'unknown', projectLabel: 'Shop', title: 'Shop Checkout Fehler testen', lastOk: t0 - 12 * 60e3 },
  { app: 'codex', eff: 'working', projectLabel: 'Mobile', title: 'Mobile Inbox', pinned: true, since: t0 - 6 * 60e3 },
  { app: 'claude', eff: 'done', projectLabel: 'Shop', title: 'Warenkorb A11y', since: t0 - 3 * 3600e3 },
  { app: 'codex', eff: 'idle', projectLabel: 'Platform', title: 'DB Migration', since: t0 - 60 * 60e3 },
  { app: 'claude', eff: 'attention', projectLabel: 'Docs', title: 'Anleitung prüfen', since: t0 - 45e3 },
  { app: 'codex', eff: 'idle', projectLabel: 'Home', title: 'Sensor prüfen', since: t0 - 90 * 60e3 },
].map((s, i) => ({ ...s, key: `${s.app}:${i}`, cwd: `/projects/${s.projectLabel}` }));
const labels = sessionLabels(tiles);
for (const tile of tiles) tile.lines = labels.get(tile.key);
const inbox = controlSvg(SIZE, 'Braucht mich', ['2', 'wartend'], 'Nächste öffnen', '#ffa77a');
const blank = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><rect width="100%" height="100%" fill="#060608" rx="20"/></svg>`;

async function frame(imgs) {
  const bufs = await Promise.all(imgs.map(t => sharp(Buffer.from(t)).png().toBuffer()));
  return sharp({ create: { width: 5 * SIZE + 6 * GAP, height: 3 * SIZE + 4 * GAP, channels: 4, background: '#1b1b1f' } })
    .composite(bufs.map((input, i) => ({ input, left: GAP + (i % 5) * (SIZE + GAP), top: GAP + Math.floor(i / 5) * (SIZE + GAP) }))).png().toBuffer();
}

const frames = [];
for (let f = 0; f < FPS * SECONDS; f++) {
  const now = t0 + (f * 1000) / FPS;
  frames.push(await frame([...tiles.map(s => svg(s, SIZE, now)), controlSvg(SIZE, 'Projekte', ['Übersicht'], 'Halten: alle'), inbox, pagerSvg(SIZE, 0, 3)]));
}
fs.mkdirSync('docs', { recursive: true });
await sharp(frames, { join: { animated: true } }).gif({ delay: Array(frames.length).fill(Math.round(1000 / FPS)), loop: 0 }).toFile('docs/preview.gif');
await sharp(frames[3]).toFile('docs/preview.png');
const projects = projectGroups(tiles).map(g => projectSvg(g, SIZE));
while (projects.length < 12) projects.push(blank);
fs.writeFileSync('docs/projects.png', await frame([...projects, controlSvg(SIZE, 'Sitzungen', ['Alle öffnen'], 'Halten: alle'), inbox, pagerSvg(SIZE, 0, 1)]));
console.log('wrote docs/preview.gif, docs/preview.png, docs/projects.png');
