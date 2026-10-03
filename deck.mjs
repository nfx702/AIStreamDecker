#!/usr/bin/env node
// AI Stream Decker: shows Claude Code + ChatGPT/Codex sessions on an Elgato Stream Deck (direct HID, no Elgato app).
import { listStreamDecks, openStreamDeck } from '@elgato-stream-deck/node';
import { svg, pagerSvg, render } from './render.mjs';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const DECK_DIR = path.join(HOME, '.ai-deck');
const HOOK_DIR = path.join(DECK_DIR, 'claude');
const SEEN_FILE = path.join(DECK_DIR, 'seen.json');
const DESKTOP_DIR = path.join(HOME, 'Library/Application Support/Claude/claude-code-sessions');
const CODEX_DB = path.join(HOME, '.codex/state_5.sqlite');
const CLAUDE_BUNDLE = 'com.anthropic.claudefordesktop';
const WINDOW = 3 * 86400e3;        // sessions without activity for this long are hidden
const DONE_FRESH = 12 * 3600e3;    // finished sessions stay highlighted this long unless you look at them
const PAGE_RESET = 20e3;           // jump back to page 1 after this long without a key press
const STALE_WORK = 30 * 60e3;      // "working" without any sign of life for this long -> idle
const BRIGHTNESS = 70;
const PRI = { attention: 4, error: 3, done: 2, working: 1, idle: 0 };
const TERMS = { Apple_Terminal: 'Terminal', 'iTerm.app': 'iTerm', vscode: 'Visual Studio Code', ghostty: 'Ghostty', WarpTerminal: 'Warp' };
const CODEX_EVENTS = {
  task_started: 'working', task_complete: 'done', turn_aborted: 'done', error: 'error', stream_error: 'error',
  exec_approval_request: 'attention', apply_patch_approval_request: 'attention', request_user_input: 'attention',
};

const ls = d => { try { return fs.readdirSync(d); } catch { return []; } };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- seen state (which "done" sessions you already looked at) ----------
let seen = readJson(SEEN_FILE);
const firstRun = !seen;
seen ??= {};
function markSeen(key) {
  seen[key] = Date.now();
  for (const k in seen) if (Date.now() - seen[k] > 2 * WINDOW) delete seen[k];
  fs.mkdirSync(DECK_DIR, { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen));
}

// ---------- Claude Code (hook files + desktop session store) ----------
const desktopCache = new Map(); // file -> { mtime, data }
function desktopSessions() {
  const byCli = new Map();
  for (const a of ls(DESKTOP_DIR)) for (const b of ls(path.join(DESKTOP_DIR, a))) for (const f of ls(path.join(DESKTOP_DIR, a, b))) {
    if (!/^local_.*\.json$/.test(f)) continue;
    const file = path.join(DESKTOP_DIR, a, b, f);
    let mtime; try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
    let c = desktopCache.get(file);
    if (c?.mtime !== mtime) desktopCache.set(file, c = { mtime, data: readJson(file) });
    if (c.data?.cliSessionId) byCli.set(c.data.cliSessionId, c.data);
  }
  return byCli;
}

function claudeSessions(now, front) {
  const desk = desktopSessions();
  // the desktop session focused most recently is the one on screen when Claude is the front app
  let onScreen = null;
  if (front === CLAUDE_BUNDLE) for (const d of desk.values()) if (!onScreen || d.lastFocusedAt > onScreen.lastFocusedAt) onScreen = d;
  const out = [];
  const hooks = new Map(ls(HOOK_DIR).map(f => readJson(path.join(HOOK_DIR, f))).filter(Boolean).map(h => [h.sid, h]));
  for (const [sid, d] of desk) {
    if (!hooks.has(sid) && !d.isArchived && now - (d.lastActivityAt ?? 0) < WINDOW)
      hooks.set(sid, { sid, cwd: d.cwd, state: 'idle', since: d.lastActivityAt, at: d.lastActivityAt });
  }
  for (const h of hooks.values()) {
    if (now - h.at > WINDOW) continue;
    const d = desk.get(h.sid);
    if (d?.isArchived) continue;
    // ponytail: no process liveness check, a crashed session just turns idle after STALE_WORK
    const state = h.state === 'working' && now - h.at > STALE_WORK ? 'idle' : h.state;
    out.push({
      key: `claude:${h.sid}`, app: 'claude', state, since: h.since,
      title: d?.title || path.basename(h.cwd || '') || 'Claude',
      seenAt: d?.lastFocusedAt ?? 0, onScreen: !!d && d === onScreen,
      open: d ? ['open', [`claude://code/continue?session=${d.sessionId}`]] : ['open', ['-a', TERMS[h.term] ?? 'Terminal']],
    });
  }
  return out;
}

// ---------- ChatGPT / Codex (thread db + rollout tail) ----------
let db;
const rolloutCache = new Map(); // path -> { size, v }
function rolloutState(p) {
  let st; try { st = fs.statSync(p); } catch { return { state: 'idle', since: 0, mtime: 0 }; }
  const c = rolloutCache.get(p);
  if (c?.size === st.size) return c.v;
  const len = Math.min(st.size, 512 * 1024);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(p, 'r');
  fs.readSync(fd, buf, 0, len, st.size - len);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n');
  let v = { state: 'idle', since: st.mtimeMs, mtime: st.mtimeMs };
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\{"timestamp":"([^"]+)".*?"type":"event_msg","payload":\{"type":"([a-z_]+)"/);
    if (m && CODEX_EVENTS[m[2]]) { v = { state: CODEX_EVENTS[m[2]], since: Date.parse(m[1]), mtime: st.mtimeMs }; break; }
  }
  rolloutCache.set(p, { size: st.size, v });
  return v;
}

function codexSessions(now) {
  try {
    db ??= new DatabaseSync(CODEX_DB, { readOnly: true });
    const rows = db.prepare(`select id, coalesce(nullif(name,''), nullif(title,''), cwd) as title, rollout_path as p
      from threads where archived = 0 and source not like '{%' and updated_at_ms > ?`).all(now - WINDOW);
    return rows.map(r => {
      const v = rolloutState(r.p);
      const state = v.state === 'working' && now - v.mtime > STALE_WORK ? 'idle' : v.state;
      return { key: `codex:${r.id}`, app: 'codex', title: r.title, state, since: v.since, seenAt: 0, open: ['open', [`codex://threads/${r.id}`]] };
    });
  } catch (e) {
    log('codex read failed:', e.message);
    db = undefined;
    return [];
  }
}

// ---------- model: sessions -> stable key slots ----------
let sessions = new Map();
let slots = [];   // stable session keys of page 1
let pages = [];   // pages[i] = session keys shown on page i
let page = 0, pageAt = 0, hidden = 0;
function effective(s, now) {
  if (s.state !== 'done') return s.state;
  // ponytail: a "done" you ignored for DONE_FRESH is treated as seen, so old history never lights up
  return Math.max(seen[s.key] ?? 0, s.seenAt) >= s.since || now - s.since > DONE_FRESH ? 'idle' : 'done';
}

const frontApp = () => new Promise(res =>
  execFile('/bin/sh', ['-c', 'lsappinfo info -only bundleid "$(lsappinfo front)"'], (e, out) => res(out?.match(/="([^"]+)"/)?.[1] ?? null)));

async function refresh(n) {
  const now = Date.now();
  const list = [...claudeSessions(now, await frontApp()), ...codexSessions(now)];
  if (firstRun && !sessions.size) for (const s of list) if (s.state === 'done') seen[s.key] = now; // don't light up history on first start
  for (const s of list) {
    if (s.onScreen && s.state === 'done' && (seen[s.key] ?? 0) < s.since) markSeen(s.key); // finished while you watched it
    s.eff = effective(s, now);
  }
  list.sort((a, b) => PRI[b.eff] - PRI[a.eff] || b.since - a.since);
  const cap = list.length > n ? n - 1 : n; // last key becomes the pager when everything doesn't fit
  const top = list.slice(0, cap);
  const keep = new Set(top.map(s => s.key));
  slots = Array.from({ length: cap }, (_, i) => (keep.has(slots[i]) ? slots[i] : null));
  for (const s of top) if (!slots.includes(s.key)) slots[slots.indexOf(null)] = s.key; // new sessions take free keys, others stay put
  const rest = list.slice(cap).map(s => s.key);
  hidden = rest.length;
  pages = [slots];
  for (let i = 0; i < rest.length; i += cap) pages.push(rest.slice(i, i + cap));
  if (page >= pages.length || (page && now - pageAt > PAGE_RESET)) page = 0;
  sessions = new Map(list.map(s => [s.key, s]));
  const sig = slots.map((k, i) => k && `${i + 1}:${sessions.get(k).eff}:${sessions.get(k).title}`).filter(Boolean).join(' | ') + (hidden ? ` | +${hidden} more` : '');
  if (sig !== lastSig) log('deck', (lastSig = sig) || '(empty)');
}
let lastSig;

// ---------- device ----------
let deck = null, keys = [], lastSvg = [];

async function connect() {
  for (;;) {
    try {
      const [info] = await listStreamDecks();
      if (info) {
        const d = await openStreamDeck(info.path);
        keys = d.CONTROLS.filter(c => c.type === 'button' && c.feedbackType === 'lcd');
        lastSvg = [];
        await d.clearPanel();
        await d.setBrightness(BRIGHTNESS);
        d.on('down', c => press(typeof c === 'number' ? c : c.index));
        d.on('error', e => { log('deck error:', e?.message ?? e); deck = null; d.close().catch(() => {}); connect(); });
        log(`connected: ${d.PRODUCT_NAME} (${keys.length} keys)`);
        return (deck = d);
      }
    } catch (e) { log('connect failed:', e.message); }
    await new Promise(r => setTimeout(r, 3000));
  }
}

function press(index) {
  if (pages.length > 1 && index === keys.length - 1) { page = (page + 1) % pages.length; pageAt = Date.now(); return; }
  const s = sessions.get(pages[page]?.[index]);
  if (!s) return;
  pageAt = Date.now();
  if (s.eff === 'done') markSeen(s.key);
  log('open', s.key, s.title);
  execFile(s.open[0], s.open[1], e => e && log('open failed:', e.message));
}

let busy = false;
async function draw() {
  const d = deck;
  if (!d || busy) return;
  busy = true;
  try {
    const now = Date.now();
    for (const k of keys) {
      const size = k.pixelSize.width;
      const pager = pages.length > 1 && k.index === keys.length - 1;
      const s = sessions.get(pages[page]?.[k.index]);
      const text = pager ? pagerSvg(size, page, pages.length, hidden) : s ? svg(s, size, now) : null;
      if (text === lastSvg[k.index]) continue;
      if (text) await d.fillKeyBuffer(k.index, await render(text), { format: 'rgb' });
      else await d.clearKey(k.index);
      lastSvg[k.index] = text;
    }
  } catch (e) { log('draw failed:', e.message); }
  busy = false;
}

async function shutdown() {
  const d = deck;
  deck = null;
  try { await d?.clearPanel(); await d?.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await connect();
await refresh(keys.length);
setInterval(() => refresh(keys.length || 15).catch(e => log('refresh failed:', e.message)), 1000);
setInterval(draw, 80);
