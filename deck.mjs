#!/usr/bin/env node
// AI Stream Decker: shows Claude Code + ChatGPT/Codex sessions on an Elgato Stream Deck (direct HID, no Elgato app).
import { listStreamDecks, openStreamDeck } from '@elgato-stream-deck/node';
import { svg, pagerSvg, projectSvg, controlSvg, sessionLabels, render } from './render.mjs';
import { PRIORITY as PRI, preferences, prioritySlots, projectGroups, projectId, projectName, waitingSessions, nextWaiting } from './model.mjs';
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
const PREFS_FILE = path.join(DECK_DIR, 'preferences.json');
const DESKTOP_DIR = path.join(HOME, 'Library/Application Support/Claude/claude-code-sessions');
const CODEX_DB = path.join(HOME, '.codex/state_5.sqlite');
const CLAUDE_BUNDLE = 'com.anthropic.claudefordesktop';
const WINDOW = 3 * 86400e3;        // sessions without activity for this long are hidden
const DONE_FRESH = 12 * 3600e3;    // finished sessions stay highlighted this long unless you look at them
const STALE_WORK = 30 * 60e3;      // "working" without any sign of life for this long -> unknown
const HOLD = 700;
const BRIGHTNESS = 70;
const TERMS = { Apple_Terminal: 'Terminal', 'iTerm.app': 'iTerm', vscode: 'Visual Studio Code', ghostty: 'Ghostty', WarpTerminal: 'Warp' };
const CODEX_EVENTS = {
  task_started: 'working', task_complete: 'done', turn_aborted: 'done', error: 'error', stream_error: 'error',
  exec_approval_request: 'attention', apply_patch_approval_request: 'attention', request_user_input: 'attention',
};

const readJson = f => { try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };
const log = (...a) => console.log(new Date().toISOString(), ...a);
function writeJson(file, value) {
  fs.mkdirSync(DECK_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------- seen state (which "done" sessions you already looked at) ----------
let seen = readJson(SEEN_FILE);
let firstRun = !seen;
seen ??= {};
function saveSeen() {
  writeJson(SEEN_FILE, seen);
}
function markSeen(key, at = Date.now()) {
  seen[key] = at;
  for (const k in seen) if (Date.now() - seen[k] > 2 * WINDOW) delete seen[k];
  saveSeen();
}

export function terminalTarget(h) {
  const fallback = ['open', ['-a', Object.hasOwn(TERMS, h.term) ? TERMS[h.term] : 'Terminal']];
  if (h.term === 'iTerm.app' && typeof h.terminalSession === 'string' && /^[\w:.-]{1,256}$/.test(h.terminalSession)) {
    return { open: ['open', [`iterm2:reveal?sessionid=${encodeURIComponent(h.terminalSession)}`]], fallback, exact: true };
  }
  if (h.term === 'Apple_Terminal' && typeof h.tty === 'string' && /^\/dev\/ttys?\d+$/.test(h.tty)) {
    // Pass the tty as an argument, never interpolate session data into AppleScript.
    return { open: ['osascript', ['-e', `on run argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is item 1 of argv then
          set selected tab of w to t
          set miniaturized of w to false
          set index of w to 1
          activate
          return
        end if
      end repeat
    end repeat
  end tell
  error "Terminal tab no longer exists"
end run`, h.tty]], fallback, exact: true };
  }
  return { open: fallback, exact: false };
}

// ---------- Claude Code (hook files + desktop session store) ----------
const desktopCache = new Map(); // file -> { mtime, data, lastOk }
const hookCache = new Map();
let lastClaude = [];
function desktopSessions() {
  const byCli = new Map();
  const files = new Set(), unavailable = [];
  const ls = dir => { try { return fs.readdirSync(dir); } catch { unavailable.push(dir); return []; } };
  const remember = (c, readError = false) => {
    if (c?.data?.cliSessionId) byCli.set(c.data.cliSessionId, { ...c.data, lastReadAt: c.lastOk, readError });
  };
  for (const a of ls(DESKTOP_DIR)) for (const b of ls(path.join(DESKTOP_DIR, a))) for (const f of ls(path.join(DESKTOP_DIR, a, b))) {
    if (!/^local_.*\.json$/.test(f)) continue;
    const file = path.join(DESKTOP_DIR, a, b, f);
    files.add(file);
    let c = desktopCache.get(file);
    let mtime; try { mtime = fs.statSync(file).mtimeMs; } catch { remember(c, true); continue; }
    if (c?.mtime !== mtime) {
      const data = readJson(file);
      if (typeof data?.cliSessionId === 'string' && typeof data?.sessionId === 'string') desktopCache.set(file, c = { mtime, data });
      else { remember(c, true); continue; }
    }
    if (c) c.lastOk = Date.now();
    remember(c);
  }
  for (const [file, c] of desktopCache) if (!files.has(file)) {
    if (unavailable.some(dir => file.startsWith(dir + path.sep))) remember(c, true);
    else desktopCache.delete(file);
  }
  return byCli;
}

export function claudeSessions(now, front) {
  const desk = desktopSessions();
  // the desktop session focused most recently is the one on screen when Claude is the front app
  let onScreen = null;
  if (front === CLAUDE_BUNDLE) for (const d of desk.values()) if (!onScreen || d.lastFocusedAt > onScreen.lastFocusedAt) onScreen = d;
  const out = [];
  let files;
  try { files = fs.readdirSync(HOOK_DIR).filter(f => f.endsWith('.json')); }
  catch (e) {
    if (lastClaude.length) return lastClaude.map(s => ({ ...s, state: 'unknown' }));
    files = [];
  }
  const hooks = new Map();
  for (const file of files) {
    let h = readJson(path.join(HOOK_DIR, file));
    if (h && typeof h.sid === 'string' && Object.hasOwn(PRI, h.state) && Number.isFinite(h.at) && Number.isFinite(h.since)) {
      h = { ...h, lastOk: now }; hookCache.set(file, h);
    } else h = hookCache.has(file) ? { ...hookCache.get(file), state: 'unknown' } : null;
    if (h) hooks.set(h.sid, h);
  }
  for (const file of hookCache.keys()) if (!files.includes(file)) hookCache.delete(file);
  for (const [sid, d] of desk) {
    if (!hooks.has(sid) && !d.isArchived && now - (d.lastActivityAt ?? 0) < WINDOW)
      hooks.set(sid, { sid, cwd: d.cwd, state: 'idle', since: d.lastActivityAt, at: d.lastActivityAt, lastOk: d.lastReadAt });
  }
  for (const h of hooks.values()) {
    if (now - h.at > WINDOW) continue;
    const d = desk.get(h.sid);
    if (d?.isArchived) continue;
    const stale = h.state === 'working' && now - h.at > STALE_WORK;
    const state = stale || d?.readError ? 'unknown' : h.state;
    out.push({
      key: `claude:${h.sid}`, app: 'claude', state, since: h.since, cwd: h.cwd || d?.cwd,
      lastOk: d?.readError ? d.lastReadAt : stale ? h.at : h.lastOk ?? 0,
      title: d?.title || path.basename(typeof h.cwd === 'string' ? h.cwd : '') || 'Claude',
      seenAt: d?.lastFocusedAt ?? 0, onScreen: !!d && d === onScreen,
      ...(d ? { open: ['open', [`claude://code/continue?session=${encodeURIComponent(d.sessionId)}`]], exact: true } : terminalTarget(h)),
    });
  }
  return (lastClaude = out);
}

// ---------- ChatGPT / Codex (thread db + rollout tail) ----------
let db, threadQuery;
let lastCodex = [], codexError;
const rolloutCache = new Map(); // path -> { size, mtime, ino, offset (last newline), v }
export function rolloutState(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const st = fs.fstatSync(fd), c = rolloutCache.get(p);
    if (c?.size === st.size && c.mtime === st.mtimeMs && c.ino === st.ino) { c.v.lastOk = Date.now(); return c.v; }
    const append = c && c.ino === st.ino && st.size > c.size;
    const floor = append ? c.offset : 0;
    let v = { ...(append ? c.v : { state: 'unknown', since: st.mtimeMs }), mtime: st.mtimeMs, lastOk: Date.now() };
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
          v = { state: CODEX_EVENTS[type], since, mtime: st.mtimeMs, lastOk: Date.now() };
          break scan;
        }
      }
      end = start;
    }
    rolloutCache.set(p, { size: st.size, mtime: st.mtimeMs, ino: st.ino, offset, v });
    return v;
  } catch { return { ...rolloutCache.get(p)?.v, state: 'unknown', lastOk: rolloutCache.get(p)?.v.lastOk ?? 0 }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function codexSessions(now) {
  try {
    if (!fs.existsSync(CODEX_DB)) {
      if (!lastCodex.length && !fs.existsSync(path.dirname(CODEX_DB))) return [];
      throw new Error('Codex database is unavailable');
    }
    db ??= new DatabaseSync(CODEX_DB, { readOnly: true });
    threadQuery ??= db.prepare(`select id, cwd, coalesce(nullif(name,''), nullif(title,''), cwd) as title, rollout_path as p
      from threads where archived = 0 and source not like '{%' and updated_at_ms > ?`);
    const rows = threadQuery.all(now - WINDOW);
    const paths = new Set(rows.map(r => r.p));
    for (const p of rolloutCache.keys()) if (!paths.has(p)) rolloutCache.delete(p);
    codexError = null;
    return (lastCodex = rows.map(r => {
      const v = rolloutState(r.p);
      const stale = v.state === 'working' && now - v.mtime > STALE_WORK;
      return { key: `codex:${r.id}`, app: 'codex', title: r.title, cwd: r.cwd, state: stale ? 'unknown' : v.state, since: v.since, lastOk: stale ? v.mtime : v.lastOk, seenAt: 0, exact: true, open: ['open', [`codex://threads/${encodeURIComponent(r.id)}`]] };
    }));
  } catch (e) {
    if (codexError !== e.message) log('codex read failed:', (codexError = e.message));
    try { db?.close(); } catch {}
    db = threadQuery = undefined;
    return lastCodex.length ? lastCodex.map(s => ({ ...s, state: 'unknown' })) : [
      { key: 'source:codex', app: 'codex', title: 'Codex nicht lesbar', state: 'unknown', lastOk: 0, seenAt: 0, open: ['open', ['-b', 'com.openai.codex']] },
    ];
  }
}

// ---------- model: sessions -> stable key slots ----------
let sessions = new Map();
let prefs = preferences(readJson(PREFS_FILE));
const layouts = new Map(), notices = new Map();
let view = 'all', page = 0, pageAt = 0, pageCount = 1, visible = [], groups = [], lastInbox;
function effective(s, now) {
  if (s.state !== 'done') return s.state;
  // ponytail: a "done" you ignored for DONE_FRESH is treated as seen, so old history never lights up
  return Math.max(seen[s.key] ?? 0, s.seenAt) >= s.since || now - s.since > DONE_FRESH ? 'idle' : 'done';
}

const frontApp = () => new Promise(res =>
  execFile('/bin/sh', ['-c', 'lsappinfo info -only bundleid "$(lsappinfo front)"'], { timeout: 1000 }, (e, out) => res(out?.match(/="([^"]+)"/)?.[1] ?? null)));

async function refresh(n) {
  const now = Date.now();
  const saved = readJson(PREFS_FILE);
  if (saved) prefs = preferences(saved);
  const list = [...claudeSessions(now, await frontApp()), ...codexSessions(now)];
  if (firstRun) {
    for (const s of list) if (s.state === 'done') seen[s.key] = now; // don't light up history on first start
    saveSeen();
    firstRun = false;
  }
  for (const s of list) {
    if (s.onScreen && s.state === 'done' && (seen[s.key] ?? 0) < s.since) markSeen(s.key); // finished while you watched it
    s.eff = effective(s, now);
    s.projectLabel = projectName(projectId(s.cwd));
  }
  const labels = sessionLabels(list);
  for (const s of list) s.lines = labels.get(s.key);
  list.sort((a, b) => PRI[b.eff] - PRI[a.eff] || b.since - a.since);
  sessions = new Map(list.map(s => [s.key, s]));
  groups = projectGroups(list, prefs.pins);
  for (const [key, notice] of notices) if (now > notice.until) notices.delete(key);
  if (prefs.pageResetSeconds && page && !heldKeys.size && now - pageAt > prefs.pageResetSeconds * 1000) page = 0;
  buildView(n);
  const sig = `${view} ${page + 1}/${pageCount} ` + visible.map(s => s && `${s.kind}:${s.key ?? ''}:${s.eff ?? ''}:${s.title ?? ''}`).join(' | ');
  if (sig !== lastSig) log('deck', (lastSig = sig) || '(empty)');
}
let lastSig;

function buildView(n = keys.length) {
  if (n < 4) return;
  const cap = n - 3;
  const items = view === 'projects' ? groups : [...sessions.values()].filter(s => view === 'all' || `project:${projectId(s.cwd)}` === view);
  const pins = prefs.pins.filter(p => p.view === view);
  const slots = prioritySlots(items, layouts.get(view), pins, cap);
  layouts.set(view, slots);
  pageCount = Math.max(1, Math.ceil(slots.length / cap));
  page = Math.min(page, pageCount - 1);
  const byKey = new Map(items.map(s => [s.key, s]));
  visible = Array.from({ length: cap }, (_, index) => {
    const slot = page * cap + index, key = slots[slot], pin = pins.find(p => p.key === key);
    const s = byKey.get(key) ?? (pin && { key, title: pin.title, app: pin.app, eff: 'idle', inactive: true });
    return s ? { ...s, kind: s.kind ?? 'session', pinned: !!pin, slot, view, notice: notices.get(key)?.text } : null;
  });
  visible.push(
    { kind: 'projects', view },
    { kind: 'inbox', count: waitingSessions([...sessions.values()]).length, view },
    { kind: 'pager', page, pages: pageCount, view },
  );
}

const runOpen = target => new Promise((resolve, reject) =>
  execFile(target[0], target[1], { timeout: 5000 }, e => e ? reject(e) : resolve()));

async function openSession(s) {
  if (!s?.open || s.inactive) return false;
  const openedAt = Date.now();
  log('open', s.key, s.title);
  try {
    await runOpen(s.open);
    if (s.exact === false) notices.set(s.key, { text: 'Nur App geöffnet', until: Date.now() + 6000 });
    else if (s.eff === 'done') markSeen(s.key, openedAt);
    return true;
  } catch (e) {
    log('open failed:', e.message);
    let text = 'Öffnen fehlgeschl.';
    let opened = false;
    if (s.fallback) try { await runOpen(s.fallback); text = 'Nur App geöffnet'; opened = true; } catch {}
    notices.set(s.key, { text, until: Date.now() + 6000 });
    return opened;
  } finally { buildView(); }
}

let inboxBusy = false;
async function activate(item, held = false) {
  if (!item || item.view !== view) return;
  pageAt = Date.now();
  if (item.kind === 'projects') { view = held || view === 'projects' ? 'all' : 'projects'; page = 0; }
  else if (item.kind === 'project') { view = item.key; page = 0; }
  else if (item.kind === 'pager') page = (page + (held ? -1 : 1) + pageCount) % pageCount;
  else if (item.kind === 'inbox') {
    if (inboxBusy) return;
    inboxBusy = true;
    try {
      const s = nextWaiting([...sessions.values()], lastInbox);
      if (s && await openSession(s)) lastInbox = { key: s.key, since: s.since };
    } finally { inboxBusy = false; }
  } else if (held && /^(claude|codex):/.test(item.key)) {
    const pins = prefs.pins.filter(p => !(p.view === view && p.key === item.key));
    if (!item.pinned) pins.push({ view, key: item.key, slot: item.slot, title: item.title, app: item.app });
    const next = preferences({ ...prefs, pins });
    try { writeJson(PREFS_FILE, next); prefs = next; }
    catch (e) { log('pin failed:', e.message); notices.set(item.key, { text: 'Speichern fehlgeschl.', until: Date.now() + 6000 }); }
  } else await openSession(item);
  buildView();
}

// ---------- device ----------
let deck = null, keys = [], lastSvg = [], displayed = [];
const heldKeys = new Map();
function releaseKeys() {
  for (const held of heldKeys.values()) clearTimeout(held.timer);
  heldKeys.clear();
}

async function connect() {
  for (const info of await listStreamDecks()) {
    let d, failed = false;
    try {
      d = await openStreamDeck(info.path);
      d.on('error', e => {
        if (failed) return;
        failed = true;
        log('deck error:', e?.message ?? e);
        if (deck === d) { deck = null; releaseKeys(); }
        d.close().catch(() => {});
      });
      const controls = d.CONTROLS.filter(c => c.type === 'button' && c.feedbackType === 'lcd');
      if (controls.length < 4) { failed = true; await d.close(); continue; }
      await d.clearPanel();
      await d.setBrightness(BRIGHTNESS);
      if (failed) continue;
      keys = controls;
      lastSvg = [];
      displayed = [];
      d.on('down', c => { if (deck === d) press(c, false); });
      d.on('up', c => { if (deck === d) press(c, true); });
      log(`connected: ${d.PRODUCT_NAME} (${keys.length} keys)`);
      return (deck = d);
    } catch (e) {
      log('connect failed:', e.message);
      if (!failed) { failed = true; await d?.close().catch(() => {}); }
    }
  }
}

function press(control, up) {
  if (typeof control !== 'number' && (control?.type !== 'button' || control.feedbackType !== 'lcd')) return;
  const index = keys.findIndex(k => k.index === (typeof control === 'number' ? control : control.index));
  if (index < 0) return;
  if (up) {
    const held = heldKeys.get(index);
    if (!held) return;
    clearTimeout(held.timer); heldKeys.delete(index);
    if (!held.done) activate(held.item).catch(e => log('key failed:', e.message));
  } else if (!heldKeys.has(index) && displayed[index]) {
    pageAt = Date.now();
    const held = { item: displayed[index], done: false };
    held.timer = setTimeout(() => { held.done = true; activate(held.item, true).catch(e => log('key failed:', e.message)); }, HOLD);
    heldKeys.set(index, held);
  }
}

let busy = false;
async function draw() {
  const d = deck;
  if (!d || busy) return;
  busy = true;
  try {
    const now = Date.now();
    const frames = lastSvg, items = visible, controls = keys, shown = displayed;
    for (const [index, k] of controls.entries()) {
      if (deck !== d) break;
      const size = k.pixelSize.width;
      const s = items[index];
      const text = !s ? null : s.kind === 'pager' ? pagerSvg(size, s.page, s.pages)
        : s.kind === 'projects' ? controlSvg(size, s.view === 'projects' ? 'Sitzungen' : 'Projekte', [s.view === 'projects' ? 'Alle öffnen' : 'Übersicht'], 'Halten: alle')
        : s.kind === 'inbox' ? controlSvg(size, 'Braucht mich', [String(s.count), s.count ? 'wartend' : 'Kein Warten'], s.count ? 'Nächste öffnen' : '', s.count ? '#ffa77a' : '#7cf27a')
        : s.kind === 'project' ? projectSvg(s, size) : svg(s, size, now);
      if (text === frames[index]) { shown[index] = s; continue; }
      if (text) {
        const buffer = await render(text);
        if (deck !== d) break;
        await d.fillKeyBuffer(k.index, buffer, { format: 'rgb' });
      }
      else await d.clearKey(k.index);
      frames[index] = text;
      shown[index] = s;
    }
  } catch (e) { log('draw failed:', e.message); }
  busy = false;
}

async function shutdown() {
  const d = deck;
  deck = null;
  releaseKeys();
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
