// Dependency-free regression checks: `npm test`. All writes stay in a temporary home.
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aideck-')));
const oldHome = process.env.HOME;
process.env.HOME = home;
const env = { ...process.env, HOME: home };
const file = path.join(home, '.ai-deck/claude/s1.json');
const send = input => execFileSync(process.execPath, [path.join(root, 'hook.mjs')], { input: JSON.stringify(input), env });
const fire = (hook_event_name, extra = {}) => send({ session_id: 's1', cwd: '/x/proj', hook_event_name, ...extra });
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const state = () => read(file).state;

try {
fire('SessionStart');                                     assert.equal(state(), 'idle');
fire('UserPromptSubmit');                                 assert.equal(state(), 'working');
fire('PreToolUse', { tool_name: 'Bash' });                assert.equal(state(), 'working');
fire('Notification');                                     assert.equal(state(), 'attention'); // permission prompt
fire('PostToolUse', { tool_name: 'Bash' });               assert.equal(state(), 'working');
fire('PreToolUse', { tool_name: 'AskUserQuestion' });     assert.equal(state(), 'attention');
fire('PostToolUse', { tool_name: 'AskUserQuestion' });    assert.equal(state(), 'working');
fire('PreToolUse', { tool_name: 'ExitPlanMode' });        assert.equal(state(), 'attention');
fire('PermissionRequest', { tool_name: 'Bash' });         assert.equal(state(), 'attention');
fire('StopFailure');                                      assert.equal(state(), 'error');
fire('UserPromptSubmit');                                 assert.equal(state(), 'working');
fire('Stop');                                             assert.equal(state(), 'done');
const since = read(file).since;
fire('Notification');                                     assert.equal(state(), 'done');      // idle ping keeps it done
assert.equal(read(file).since, since);
assert.equal(fs.statSync(file).mode & 0o777, 0o600);
fs.writeFileSync(file, 'null');
fire('UserPromptSubmit');                                 assert.equal(state(), 'working');
fire('SessionEnd');                                       assert.equal(fs.existsSync(file), false);
for (const value of [null, [], 1, 'text']) send(value);
for (const sid of ['../escape', 'x'.repeat(129), 123, {}]) fire('Stop', { session_id: sid });
for (const event of ['toString', 'constructor', '__proto__', 'unknown']) fire(event);
assert.deepEqual(fs.readdirSync(path.dirname(file)), []);
console.log('hooks: transitions, invalid input, atomic files and private permissions ok');

const { rolloutState } = await import('./deck.mjs');
const rollout = path.join(home, 'rollout.jsonl');
const event = (type, extra = {}) => JSON.stringify({ payload: { type, ...extra }, type: 'event_msg', timestamp: '2026-10-08T12:00:00Z' }) + '\n';
const noise = JSON.stringify({ type: 'response_item', payload: 'x'.repeat(600 * 1024) }) + '\n';
fs.writeFileSync(rollout, event('task_started') + noise);
assert.equal(rolloutState(rollout).state, 'working'); // lifecycle event beyond the former 512 KB limit
fs.appendFileSync(rollout, noise);
assert.equal(rolloutState(rollout).state, 'working');
const completion = event('task_complete', { text: 'x'.repeat(600 * 1024) });
fs.appendFileSync(rollout, completion.slice(0, -10));
assert.equal(rolloutState(rollout).state, 'working');
fs.appendFileSync(rollout, completion.slice(-10));
assert.equal(rolloutState(rollout).state, 'done');
const cached = rolloutState(rollout);
assert.strictEqual(rolloutState(rollout), cached);
fs.appendFileSync(rollout, '{broken}\n' + event('toString') + event('error').replace('2026-10-08T12:00:00Z', 'invalid'));
assert.equal(rolloutState(rollout).state, 'done');
fs.writeFileSync(rollout, event('task_started'));
assert.equal(rolloutState(rollout).state, 'working');
assert.equal(event('task_started').length, event('stream_error').length);
fs.writeFileSync(rollout, event('stream_error'));
fs.utimesSync(rollout, new Date(), new Date(Date.now() + 2000));
assert.equal(rolloutState(rollout).state, 'error'); // same-size rewrite
const stat = fs.statSync(rollout);
fs.writeFileSync(rollout + '.new', event('task_started'));
fs.utimesSync(rollout + '.new', stat.atime, stat.mtime);
fs.renameSync(rollout + '.new', rollout);
assert.equal(rolloutState(rollout).state, 'working'); // same-size replacement
fs.writeFileSync(rollout, '');
assert.equal(rolloutState(rollout).state, 'idle');
fs.rmSync(rollout);
assert.equal(rolloutState(rollout).state, 'idle');
assert.equal(rolloutState(null).state, 'idle');
console.log('rollouts: large records, partial writes, append cache, rewrites and missing files ok');

const project = path.join(home, 'repo space \' " $(touch INJECTED) & < >');
fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true });
for (const file of ['render.mjs', 'install.mjs', 'hook.mjs', 'deck.mjs']) fs.copyFileSync(path.join(root, file), path.join(project, file));
fs.symlinkSync(path.join(root, 'node_modules/sharp'), path.join(project, 'node_modules/sharp'));
const { svg, render, pagerSvg } = await import(pathToFileURL(path.join(project, 'render.mjs')));
for (const app of ['claude', 'codex']) for (const eff of ['working', 'attention', 'done', 'idle', 'error']) {
  const text = svg({ app, eff, title: '<&"\0\uFFFF\uD800🎉 test', since: 0 }, 72, 1000);
  const pixels = await render(text);
  assert.equal(pixels.length, 72 * 72 * 3);
  assert.strictEqual(await render(text), pixels);
}
assert.equal((await render(pagerSvg(120, 0, 3, 17))).length, 120 * 120 * 3);
console.log('rendering: all states without icon files, escaped titles and RGB dimensions ok');

const bin = path.join(home, 'bin');
fs.mkdirSync(bin);
for (const [name, code] of Object.entries({
  launchctl: 'printf "%s\\n" "$@" >> "$HOME/launchctl.log"\nexit 0',
  lsappinfo: 'exit 0', sips: 'exit 1', open: 'exit 1',
})) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n' + code + '\n', { mode: 0o755 });
const isolated = { ...env, PATH: `${bin}:${process.env.PATH}` };
const install = (...args) => execFileSync(process.execPath, [path.join(project, 'install.mjs'), ...args], { env: isolated, stdio: 'pipe' });
const settingsFile = path.join(home, '.claude/settings.json');
install('--uninstall');
assert.equal(fs.existsSync(settingsFile), false);
install();
const command = read(settingsFile).hooks.Stop[0].hooks[0].command;
execFileSync('/bin/sh', ['-c', command], { env: isolated, cwd: home, input: JSON.stringify({ session_id: 'shell', hook_event_name: 'SessionStart' }) });
assert.equal(fs.existsSync(path.join(home, '.ai-deck/claude/shell.json')), true);
assert.equal(fs.existsSync(path.join(home, 'INJECTED')), false);
const foreign = { type: 'command', command: 'printf keep' };
const original = { env: { EXAMPLE: 'keep' }, hooks: { Stop: [{ matcher: 'Bash', hooks: [foreign, { type: 'command', command: `"/old/node" "${path.join(project, 'hook.mjs')}"` }] }] } };
fs.writeFileSync(settingsFile, JSON.stringify(original));
install();
const installed = read(settingsFile);
assert.deepEqual(installed.hooks.Stop[0], { matcher: 'Bash', hooks: [foreign] });
assert.deepEqual(read(settingsFile + '.bak-aideck'), original);
install();
assert.deepEqual(read(settingsFile), installed);
assert.deepEqual(read(settingsFile + '.bak-aideck'), original);
assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o600);
assert.equal(fs.statSync(path.join(home, '.ai-deck')).mode & 0o777, 0o700);
const plist = path.join(home, 'Library/LaunchAgents/de.nfxmedia.aistreamdecker.plist');
if (process.platform === 'darwin') {
  assert.deepEqual(JSON.parse(execFileSync('plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', plist], { encoding: 'utf8' })), [process.execPath, path.join(project, 'deck.mjs')]);
  assert.equal(execFileSync('plutil', ['-extract', 'WorkingDirectory', 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim(), project);
}
install('--uninstall');
assert.deepEqual(read(settingsFile), { env: original.env, hooks: { Stop: [{ matcher: 'Bash', hooks: [foreign] }] } });
assert.equal(fs.existsSync(plist), false);
fs.writeFileSync(settingsFile, '{broken');
assert.notEqual(spawnSync(process.execPath, [path.join(project, 'install.mjs')], { env: isolated }).status, 0);
assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{broken');
fs.writeFileSync(settingsFile, '{"hooks":[]}');
assert.notEqual(spawnSync(process.execPath, [path.join(project, 'install.mjs')], { env: isolated }).status, 0);
assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{"hooks":[]}');
console.log('installer: fresh home, mixed hooks, stable backup, quoted paths, plist and uninstall ok');

// Run the daemon against an inline device stand-in; no USB or real LaunchAgents are touched.
const driver = path.join(project, 'node_modules/@elgato-stream-deck/node');
fs.mkdirSync(driver, { recursive: true });
fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }));
fs.writeFileSync(path.join(driver, 'index.mjs'), `
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
const home = os.homedir();
const log = (event, detail) => fs.appendFileSync(home + '/device.jsonl', JSON.stringify({ event, detail }) + '\\n');
let opens = 0;
export async function listStreamDecks() { return [{ path: 'pedal' }, { path: 'lcd' }]; }
export async function openStreamDeck(path) {
  const n = path === 'lcd' ? ++opens : 0;
  log('open', path);
  const d = new EventEmitter();
  d.PRODUCT_NAME = path;
  d.CONTROLS = path === 'pedal' ? [] : [0, 4, 9].map(index => ({ type: 'button', feedbackType: 'lcd', index, pixelSize: { width: 72 } }));
  d.clearPanel = async () => { if (n === 1 && process.env.AIDECK_FAILURE === 'init') throw new Error('simulated init failure'); };
  d.close = async () => { log('close', path); };
  d.clearKey = async () => {};
  d.fillKeyBuffer = async (index, buffer) => { if (buffer.length !== 72 * 72 * 3) throw new Error('bad RGB size'); log('draw', index); };
  d.setBrightness = async () => {
    if (n === 1) setTimeout(() => { d.emit('error', new Error('unplugged')); d.emit('error', new Error('duplicate')); }, 150);
    else {
      const file = home + '/.ai-deck/claude/s3.json';
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...s, state: 'done', since: Date.now(), at: Date.now() }));
      setTimeout(() => { d.emit('down', { type: 'encoder', index: 0 }); d.emit('down', d.CONTROLS[2]); }, 250);
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 600);
    }
  };
  return d;
}
`);
for (const failure of ['disconnect', 'init']) {
  fs.rmSync(path.join(home, 'device.jsonl'), { force: true });
  fs.rmSync(path.join(home, '.ai-deck/seen.json'), { force: true });
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(file));
  for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(path.dirname(file), `s${i}.json`), JSON.stringify({ sid: `s${i}`, cwd: `/p/${i}`, state: 'working', at: Date.now(), since: Date.now() - i * 1000 }));
  fs.writeFileSync(path.join(path.dirname(file), 'invalid.json'), JSON.stringify({ sid: 'invalid', cwd: {}, state: 'bogus' }));
  const run = spawnSync(process.execPath, [path.join(project, 'deck.mjs')], { env: { ...isolated, AIDECK_FAILURE: failure }, encoding: 'utf8', timeout: 8000 });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const events = fs.readFileSync(path.join(home, 'device.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.event === 'open' && e.detail === 'lcd').length, 2, run.stdout);
  assert.equal(events.filter(e => e.event === 'close' && e.detail === 'lcd').length, 2, run.stdout);
  assert.deepEqual([...new Set(events.filter(e => e.event === 'draw').map(e => e.detail))].sort((a, b) => a - b), [0, 4, 9]);
  assert.equal((run.stdout.match(/open claude:/g) ?? []).length, 1, run.stdout);
  assert.match(run.stdout, /open claude:s3/);
  assert.doesNotMatch(run.stdout, /draw failed|refresh failed|codex read failed/);
  if (failure === 'disconnect') assert.equal(read(path.join(home, '.ai-deck/seen.json'))['claude:s3'], undefined); // failed open stays unread
}
console.log('daemon: unsupported devices, init failure, reconnect, duplicate errors, encoder filtering and key mapping ok');
} finally {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  fs.rmSync(home, { recursive: true, force: true });
}
