// Renders docs/preview.gif with every key state, animated: `node preview.mjs`
import sharp from 'sharp';
import fs from 'node:fs';
import { svg, pagerSvg } from './render.mjs';

const SIZE = 144, GAP = 10, FPS = 12, SECONDS = 4;
const t0 = 1_800_000_000_000;
const tiles = [
  { app: 'claude', eff: 'attention', title: 'Checkout refactor', since: t0 - 95e3 },
  { app: 'claude', eff: 'working', title: 'Stream Deck Session Monitor', since: t0 - 12 * 60e3 },
  { app: 'codex', eff: 'working', title: 'McDart', since: t0 - 3 * 60e3 },
  { app: 'codex', eff: 'done', title: 'Scentsy Feed täglich kontrollieren', since: t0 - 3 * 3600e3 },
  { app: 'claude', eff: 'idle', title: 'Home Assistant Mini-PC', since: t0 - 26 * 3600e3 },
  { app: 'codex', eff: 'error', title: 'Deploy pipeline', since: t0 - 7 * 60e3 },
];

const frames = [];
for (let f = 0; f < FPS * SECONDS; f++) {
  const now = t0 + (f * 1000) / FPS;
  const imgs = [...tiles.map(s => svg(s, SIZE, now)), pagerSvg(SIZE, 0, 3, 17)];
  const bufs = await Promise.all(imgs.map(t => sharp(Buffer.from(t)).png().toBuffer()));
  frames.push(await sharp({ create: { width: imgs.length * (SIZE + GAP) + GAP, height: SIZE + 2 * GAP, channels: 4, background: '#1b1b1f' } })
    .composite(bufs.map((input, i) => ({ input, left: GAP + i * (SIZE + GAP), top: GAP }))).png().toBuffer());
}
fs.mkdirSync('docs', { recursive: true });
await sharp(frames, { join: { animated: true } }).gif({ delay: Array(frames.length).fill(Math.round(1000 / FPS)), loop: 0 }).toFile('docs/preview.gif');
await sharp(frames[3]).toFile('docs/preview.png');
console.log('wrote docs/preview.gif, docs/preview.png');
