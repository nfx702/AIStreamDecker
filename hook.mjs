#!/usr/bin/env node
// Claude Code hook: turns hook events into one status file per session for deck.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.ai-deck', 'claude');
const ASKS = new Set(['AskUserQuestion', 'ExitPlanMode']); // tools that block on the user

let input;
try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
const { session_id: sid, hook_event_name: ev, tool_name: tool, cwd } = input;
if (!sid || !/^[\w-]+$/.test(sid)) process.exit(0);

fs.mkdirSync(DIR, { recursive: true });
const file = path.join(DIR, `${sid}.json`);
if (ev === 'SessionEnd') { fs.rmSync(file, { force: true }); process.exit(0); }

let prev = {};
try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}

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
if (!state) process.exit(0);

const now = Date.now();
fs.writeFileSync(file, JSON.stringify({
  sid, cwd, state,
  since: state === prev.state ? prev.since : now,
  at: now,
  term: process.env.TERM_PROGRAM ?? prev.term ?? null,
}));
