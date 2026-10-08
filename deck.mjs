#!/usr/bin/env node
// AI Stream Decker: shows Claude Code + ChatGPT/Codex sessions on an Elgato Stream Deck (direct HID, no Elgato app).
import { listStreamDecks, openStreamDeck } from '@elgato-stream-deck/node';
import { svg, pagerSvg, render } from './render.mjs';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const readJson = f => { try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- seen state (which "done" sessions you already looked at) ----------
let seen = readJson(SEEN_FILE);
let firstRun = !seen;
seen ??= {};
function saveSeen() {
  fs.mkdirSync(DECK_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${SEEN_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(seen), { mode: 0o600 });
  fs.renameSync(tmp, SEEN_FILE);
}
function markSeen(key) {
  seen[key] = Date.now();
  for (const k in seen) if (Date.now() - seen[k] > 2 * WINDOW) delete seen[k];
  saveSeen();
}

// ---------- Claude Code (hook files + desktop session store) ----------
const desktopCache = new Map(); // file -> { mtime, data }
function desktopSessions() {
  const byCli = new Map();
  const files = new Set();
  for (const a of ls(DESKTOP_DIR)) for (const b of ls(path.join(DESKTOP_DIR, a))) for (const f of ls(path.join(DESKTOP_DIR, a, b))) {
    if (!/^local_.*\.json$/.test(f)) continue;
    const file = path.join(DESKTOP_DIR, a, b, f);
    files.add(file);
    let mtime; try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
    let c = desktopCache.get(file);
    if (c?.mtime !== mtime) desktopCache.set(file, c = { mtime, data: readJson(file) });
    if (c.data?.cliSessionId) byCli.set(c.data.cliSessionId, c.data);
  }
  for (const file of desktopCache.keys()) if (!files.has(file)) desktopCache.delete(file);
  return byCli;
}

function claudeSessions(now, front) {
  const desk = desktopSessions();
  // the desktop session focused most recently is the one on screen when Claude is the front app
  let onScreen = null;
  if (front === CLAUDE_BUNDLE) for (const d of desk.values()) if (!onScreen || d.lastFocusedAt > onScreen.lastFocusedAt) onScreen = d;
  const out = [];
  const hooks = new Map(ls(HOOK_DIR).filter(f => f.endsWith('.json')).map(f => readJson(path.join(HOOK_DIR, f)))
    .filter(h => h && typeof h.sid === 'string' && Object.hasOwn(PRI, h.state) && Number.isFinite(h.at) && Number.isFinite(h.since)).map(h => [h.sid, h]));
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
      title: d?.title || path.basename(typeof h.cwd === 'string' ? h.cwd : '') || 'Claude',
      seenAt: d?.lastFocusedAt ?? 0, onScreen: !!d && d === onScreen,
      open: d ? ['open', [`claude://code/continue?session=${encodeURIComponent(d.sessionId)}`]] : ['open', ['-a', Object.hasOwn(TERMS, h.term) ? TERMS[h.term] : 'Terminal']],
    });
  }
  return out;
}

// ---------- ChatGPT / Codex (thread db + rollout tail) ----------
let db, threadQuery;
const rolloutCache = new Map(); // path -> { size, mtime, ino, offset (last newline), v }
export function rolloutState(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const st = fs.fstatSync(fd), c = rolloutCache.get(p);
    if (c?.size === st.size && c.mtime === st.mtimeMs && c.ino === st.ino) return c.v;
    const append = c && c.ino === st.ino && st.size > c.size;
    const floor = append ? c.offset : 0;
    let v = { ...(append ? c.v : { state: 'idle', since: st.mtimeMs }), mtime: st.mtimeMs };
    let end = st.size, carry = '', offset = floor;
    // ponytail: cold reads scan backwards; index events if startup I/O becomes costly. Later reads only cover appended records.
    scan: while (end > floor) {
      const start = Math.max(floor, end - 512 * 1024);
      const buf = Buffer.alloc(end - start);
      const bytes = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, start));
      if (offset === floor && bytes.lastIndexOf(10) >= 0) offset = start + bytes.lastIndexOf(10) + 1;
      const lines = (bytes.toString('utf8') + carry).split('\n');
      carry = start > floor ? lines.shift() : '';
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('event_msg')) continue;
        let event; try { event = JSON.parse(lines[i]); } catch { continue; }
        const type = event?.payload?.type, since = Date.parse(event?.timestamp);
        if (event?.type === 'event_msg' && Object.hasOwn(CODEX_EVENTS, type) && Number.isFinite(since)) {
          v = { state: CODEX_EVENTS[type], since, mtime: st.mtimeMs };
          break scan;
        }
      }
      end = start;
    }
    rolloutCache.set(p, { size: st.size, mtime: st.mtimeMs, ino: st.ino, offset, v });
    return v;
  } catch { return { state: 'idle', since: 0, mtime: 0 }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function codexSessions(now) {
  try {
    if (!db && !fs.existsSync(CODEX_DB)) return [];
    db ??= new DatabaseSync(CODEX_DB, { readOnly: true });
    threadQuery ??= db.prepare(`select id, coalesce(nullif(name,''), nullif(title,''), cwd) as title, rollout_path as p
      from threads where archived = 0 and source not like '{%' and updated_at_ms > ?`);
    const rows = threadQuery.all(now - WINDOW);
    const paths = new Set(rows.map(r => r.p));
    for (const p of rolloutCache.keys()) if (!paths.has(p)) rolloutCache.delete(p);
    return rows.map(r => {
      const v = rolloutState(r.p);
      const state = v.state === 'working' && now - v.mtime > STALE_WORK ? 'idle' : v.state;
      return { key: `codex:${r.id}`, app: 'codex', title: r.title, state, since: v.since, seenAt: 0, open: ['open', [`codex://threads/${encodeURIComponent(r.id)}`]] };
    });
  } catch (e) {
    log('codex read failed:', e.message);
    try { db?.close(); } catch {}
    db = threadQuery = undefined;
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
  execFile('/bin/sh', ['-c', 'lsappinfo info -only bundleid "$(lsappinfo front)"'], { timeout: 1000 }, (e, out) => res(out?.match(/="([^"]+)"/)?.[1] ?? null)));

async function refresh(n) {
  const now = Date.now();
  const list = [...claudeSessions(now, await frontApp()), ...codexSessions(now)];
  if (firstRun) {
    for (const s of list) if (s.state === 'done') seen[s.key] = now; // don't light up history on first start
    saveSeen();
    firstRun = false;
  }
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
  for (const info of await listStreamDecks()) {
    let d, failed = false;
    try {
      d = await openStreamDeck(info.path);
      d.on('error', e => {
        if (failed) return;
        failed = true;
        log('deck error:', e?.message ?? e);
        if (deck === d) deck = null;
        d.close().catch(() => {});
      });
      const controls = d.CONTROLS.filter(c => c.type === 'button' && c.feedbackType === 'lcd');
      if (controls.length < 2) { failed = true; await d.close(); continue; }
      await d.clearPanel();
      await d.setBrightness(BRIGHTNESS);
      if (failed) continue;
      keys = controls;
      lastSvg = [];
      d.on('down', c => { if (deck === d) press(c); });
      log(`connected: ${d.PRODUCT_NAME} (${keys.length} keys)`);
      return (deck = d);
    } catch (e) {
      log('connect failed:', e.message);
      if (!failed) { failed = true; await d?.close().catch(() => {}); }
    }
  }
}

function press(control) {
  if (typeof control !== 'number' && (control?.type !== 'button' || control.feedbackType !== 'lcd')) return;
  const index = keys.findIndex(k => k.index === (typeof control === 'number' ? control : control.index));
  if (index < 0) return;
  if (pages.length > 1 && index === keys.length - 1) { page = (page + 1) % pages.length; pageAt = Date.now(); return; }
  const s = sessions.get(pages[page]?.[index]);
  if (!s) return;
  pageAt = Date.now();
  log('open', s.key, s.title);
  execFile(s.open[0], s.open[1], { timeout: 5000 }, e => {
    if (e) return log('open failed:', e.message);
    if (s.eff === 'done') try { markSeen(s.key); } catch (e) { log('mark seen failed:', e.message); }
  });
}

let busy = false;
async function draw() {
  const d = deck;
  if (!d || busy) return;
  busy = true;
  try {
    const now = Date.now();
    const frames = lastSvg, visible = pages[page], controls = keys;
    const currentPage = page, pageCount = pages.length, more = hidden;
    for (const [index, k] of controls.entries()) {
      if (deck !== d) break;
      const size = k.pixelSize.width;
      const pager = pageCount > 1 && index === controls.length - 1;
      const s = sessions.get(visible?.[index]);
      const text = pager ? pagerSvg(size, currentPage, pageCount, more) : s ? svg(s, size, now) : null;
      if (text === frames[index]) continue;
      if (text) {
        const buffer = await render(text);
        if (deck !== d) break;
        await d.fillKeyBuffer(k.index, buffer, { format: 'rgb' });
      }
      else await d.clearKey(k.index);
      frames[index] = text;
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
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  let refreshing = false;
  const tick = async () => {
    if (refreshing) return;
    refreshing = true;
    try { if (!deck) await connect(); if (deck) await refresh(keys.length); }
    catch (e) { log('refresh failed:', e.message); }
    finally { refreshing = false; }
  };
  await tick();
  setInterval(tick, 1000);
  setInterval(draw, 80);
}
