// Self-check for hook.mjs state transitions: `node test.mjs`
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aideck-'));
const file = path.join(home, '.ai-deck/claude/s1.json');
const fire = (hook_event_name, extra = {}) =>
  execFileSync(process.execPath, [new URL('./hook.mjs', import.meta.url).pathname],
    { input: JSON.stringify({ session_id: 's1', cwd: '/x/proj', hook_event_name, ...extra }), env: { ...process.env, HOME: home } });
const state = () => JSON.parse(fs.readFileSync(file, 'utf8')).state;

fire('SessionStart');                                     assert.equal(state(), 'idle');
fire('UserPromptSubmit');                                 assert.equal(state(), 'working');
fire('PreToolUse', { tool_name: 'Bash' });                assert.equal(state(), 'working');
fire('Notification');                                     assert.equal(state(), 'attention'); // permission prompt
fire('PostToolUse', { tool_name: 'Bash' });               assert.equal(state(), 'working');
fire('PreToolUse', { tool_name: 'AskUserQuestion' });     assert.equal(state(), 'attention');
fire('PostToolUse', { tool_name: 'AskUserQuestion' });    assert.equal(state(), 'working');
fire('PermissionRequest', { tool_name: 'Bash' });         assert.equal(state(), 'attention');
fire('StopFailure');                                      assert.equal(state(), 'error');
fire('UserPromptSubmit');                                 assert.equal(state(), 'working');
fire('Stop');                                             assert.equal(state(), 'done');
const since = JSON.parse(fs.readFileSync(file, 'utf8')).since;
fire('Notification');                                     assert.equal(state(), 'done');      // idle ping keeps it done
assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).since, since);
fire('SessionEnd');                                       assert.equal(fs.existsSync(file), false);
fs.rmSync(home, { recursive: true });
console.log('hook ok');
