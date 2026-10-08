#!/usr/bin/env node
// Claude Code hook: turns hook events into one status file per session for deck.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.umask(0o077);
const DIR = path.join(os.homedir(), '.ai-deck', 'claude');
const ASKS = new Set(['AskUserQuestion', 'ExitPlanMode']); // tools that block on the user

let input;
try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
if (!input || typeof input !== 'object' || Array.isArray(input)) process.exit(0);
const { session_id: sid, hook_event_name: ev, tool_name: tool, cwd } = input;
if (typeof sid !== 'string' || !/^[\w-]{1,128}$/.test(sid) || typeof ev !== 'string') process.exit(0);

fs.mkdirSync(DIR, { recursive: true });
const file = path.join(DIR, `${sid}.json`);
if (ev === 'SessionEnd') { fs.rmSync(file, { force: true }); process.exit(0); }

let prev = {};
try { prev = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch {}

const state = {
  SessionStart: prev.state ?? 'idle',
  UserPromptSubmit: 'working',
  PostToolUse: 'working',
  PreToolUse: ASKS.has(tool) ? 'attention' : 'working',
  PermissionRequest: 'attention',
  // permission prompt while working; the 60s "idle" ping after Stop must not re-flag a seen session
  Notification: prev.state === 'done' || prev.state === 'idle' ? prev.state : 'attention',
  Stop: 'done',
  StopFailure: 'error', // turn ended on an API error
}[ev];
if (typeof state !== 'string') process.exit(0);

const now = Date.now();
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify({
  sid, cwd: typeof cwd === 'string' ? cwd : prev.cwd, state,
  since: state === prev.state && Number.isFinite(prev.since) ? prev.since : now,
  at: now,
  term: process.env.TERM_PROGRAM ?? prev.term ?? null,
}));
fs.renameSync(tmp, file);
