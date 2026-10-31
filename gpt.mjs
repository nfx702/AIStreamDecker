// ChatGPT chats via the ChatGPT app's local DevTools port.
// The app must run with `--remote-debugging-port=0` (it then writes the chosen port to DevToolsActivePort).
// Only title and sidebar status of the chats the app's sidebar shows are read, never message content.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT_FILE = path.join(os.homedir(), 'Library/Application Support/Codex/DevToolsActivePort');
const BUNDLE = 'com.openai.codex';
const PAGE = 'app://-/index.html';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RETRY = 5000;

// Runs inside the ChatGPT page. `statusState` is exactly what the app renders next to each sidebar row:
// {type: 'loading'} while a turn streams, {type: 'error'}, {type: 'idle', unread: true} for unread replies.
const READ_ROWS = `[...document.querySelectorAll('[data-sidebar-chatgpt-conversation-key]')].map(row => {
  const fiber = row[Object.keys(row).find(k => k.startsWith('__reactFiber'))];
  const find = (f, d) => !f || d > 12 ? null
    : f.memoizedProps?.statusState && f.memoizedProps.conversationId ? f.memoizedProps : find(f.child, d + 1) || find(f.sibling, d);
  const p = find(fiber?.child, 1);
  return p && { id: p.conversationId, title: p.title, status: p.statusState.type, unread: !!p.statusState.unread, updated: p.conversation?.update_time };
}).filter(Boolean)`;

let ws = null, nextId = 0, retryAt = 0;
const pending = new Map();

async function connect() {
  const port = Number.parseInt(fs.readFileSync(PORT_FILE, 'utf8'), 10);
  if (!(port > 0 && port < 65536)) throw new Error('no DevTools port');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
  const page = targets.find(t => t.type === 'page' && t.url === PAGE);
  if (!page) throw new Error('ChatGPT window not found');
  const sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { sock.onopen = resolve; sock.onerror = () => reject(new Error('DevTools connection failed')); });
  sock.onmessage = m => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); pending.delete(d.id); };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    for (const done of pending.values()) done({ error: { message: 'DevTools connection closed' } });
    pending.clear();
  };
  return (ws = sock);
}

async function evaluate(expression) {
  const sock = ws ?? await connect();
  const id = ++nextId;
  const reply = await new Promise(resolve => {
    pending.set(id, resolve);
    sock.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    setTimeout(() => { if (pending.delete(id)) resolve({ error: { message: 'DevTools timeout' } }); }, 2000);
  });
  if (reply.error || reply.result?.exceptionDetails) throw new Error(reply.error?.message ?? 'evaluation failed');
  return reply.result.result.value;
}

const running = () => {
  try { return /ASN:/.test(execFileSync('lsappinfo', ['find', `bundleid=${BUNDLE}`], { encoding: 'utf8', timeout: 500 })); } catch { return false; }
};

export async function openChat(id) {
  if (!ID.test(id)) throw new Error('invalid chat id');
  const clicked = await evaluate(`(() => {
    const b = document.querySelector('[data-sidebar-chatgpt-conversation-key="chatgpt:conversation:${id}"] [role=button]');
    b?.click();
    return !!b;
  })()`);
  if (!clicked) throw new Error('chat is no longer in the ChatGPT sidebar');
  await new Promise((resolve, reject) => execFile('open', ['-b', BUNDLE], { timeout: 5000 }, e => e ? reject(e) : resolve()));
}

const transitions = new Map(); // chat id -> { state, since }
export function toSessions(rows, now) {
  return rows.filter(r => r && typeof r.id === 'string' && ID.test(r.id)).map(r => {
    const state = r.unread ? 'done' : r.status === 'loading' ? 'working' : r.status === 'error' ? 'error' : 'idle';
    const updated = Date.parse(r.updated), prev = transitions.get(r.id);
    // idle shows time since the last message; other states since they began (first sight: last update)
    const since = state === 'idle' && Number.isFinite(updated) ? updated
      : prev?.state === state ? prev.since : prev ? now : Number.isFinite(updated) ? updated : now;
    transitions.set(r.id, { state, since });
    return {
      key: `gpt:${r.id}`, app: 'gpt', title: typeof r.title === 'string' && r.title ? r.title : 'ChatGPT',
      state, since, lastOk: now, seenAt: 0, exact: true, open: () => openChat(r.id),
    };
  });
}

let lastOk = 0;
export async function gptSessions(now) {
  if (!ws && now < retryAt) return offline();
  try {
    const rows = await evaluate(READ_ROWS);
    lastOk = now;
    return toSessions(Array.isArray(rows) ? rows : [], now);
  } catch {
    retryAt = now + RETRY;
    ws?.close();
    return offline();
  }
}

// ChatGPT open but not reachable (started without the debug port, e.g. after an update): say so on one key.
let offlineAt = 0, offlineCache = [];
function offline() {
  if (Date.now() - offlineAt > RETRY) {
    offlineAt = Date.now();
    offlineCache = running() ? [{
      key: 'source:gpt', app: 'gpt', title: 'GPT nicht verbunden', state: 'unknown', since: 0, lastOk,
      seenAt: 0, exact: false, open: ['open', ['-b', BUNDLE]],
    }] : [];
  }
  return offlineCache;
}
