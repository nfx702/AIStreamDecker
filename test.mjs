// Dependency-free regression checks: `npm test`. All writes stay in a temporary home.
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { preferences, stableSlots, projectGroups, waitingSessions, nextWaiting } from './model.mjs';

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

const { rolloutState, codexSessions, claudeSessions, terminalTarget } = await import('./deck.mjs');
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
assert.equal(rolloutState(rollout).state, 'unknown');
fs.rmSync(rollout);
assert.equal(rolloutState(rollout).state, 'unknown');
assert.equal(rolloutState(null).state, 'unknown');
console.log('rollouts: large records, partial writes, append cache, rewrites and missing files ok');

fs.mkdirSync(path.join(home, '.codex'));
const dbFile = path.join(home, '.codex/state_5.sqlite');
let db = new DatabaseSync(dbFile);
db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, name TEXT, title TEXT, rollout_path TEXT, archived INTEGER, source TEXT, updated_at_ms INTEGER)');
fs.writeFileSync(rollout, event('task_started'));
db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, 0, ?, ?)').run('c1', '/work/Shop', '', 'Checkout testen', rollout, 'cli', Date.now());
assert.equal(codexSessions(Date.now())[0].state, 'working');
const lastOk = codexSessions(Date.now())[0].lastOk;
fs.rmSync(rollout);
assert.equal(codexSessions(Date.now())[0].state, 'unknown');
assert.equal(codexSessions(Date.now())[0].lastOk, lastOk);
db.exec('ALTER TABLE threads RENAME TO migrating');
assert.equal(codexSessions(Date.now())[0].key, 'codex:c1');
assert.equal(codexSessions(Date.now())[0].state, 'unknown');
db.exec('ALTER TABLE migrating RENAME TO threads');
fs.writeFileSync(rollout, event('request_user_input'));
assert.equal(codexSessions(Date.now())[0].state, 'attention');
db.close();
fs.rmSync(dbFile);
assert.equal(codexSessions(Date.now())[0].state, 'unknown');
fs.rmSync(path.join(home, '.codex'), { recursive: true });
fire('UserPromptSubmit');
assert.equal(claudeSessions(Date.now(), null)[0].state, 'working');
fs.writeFileSync(file, '{broken');
assert.equal(claudeSessions(Date.now(), null)[0].state, 'unknown');
fire('PermissionRequest');
assert.equal(claudeSessions(Date.now(), null)[0].state, 'attention');
fire('SessionEnd');
assert.deepEqual(claudeSessions(Date.now(), null), []);
const desktopDir = path.join(home, 'Library/Application Support/Claude/claude-code-sessions');
const desktopFile = path.join(desktopDir, 'account/project/local_1.json');
fs.mkdirSync(path.dirname(desktopFile), { recursive: true });
const desktop = { cliSessionId: 'desktop1', sessionId: 'local_1', cwd: '/work/Shop', title: 'Desktop', lastActivityAt: Date.now() };
fs.writeFileSync(desktopFile, JSON.stringify(desktop));
const desktopSession = claudeSessions(Date.now(), null)[0];
assert.equal(desktopSession.state, 'idle');
fs.writeFileSync(desktopFile, '{broken');
assert.equal(claudeSessions(Date.now(), null)[0].state, 'unknown');
assert.equal(claudeSessions(Date.now(), null)[0].lastOk, desktopSession.lastOk);
fs.renameSync(desktopDir, desktopDir + '.unavailable');
assert.equal(claudeSessions(Date.now(), null)[0].key, desktopSession.key);
assert.equal(claudeSessions(Date.now(), null)[0].state, 'unknown');
fs.renameSync(desktopDir + '.unavailable', desktopDir);
fs.writeFileSync(desktopFile, JSON.stringify(desktop));
assert.equal(claudeSessions(Date.now(), null)[0].state, 'idle');
fs.unlinkSync(desktopFile);
assert.deepEqual(claudeSessions(Date.now(), null), []);
console.log('sources: unreadable logs and database migrations retain sessions and recover');

assert.deepEqual(preferences(null), { pageResetSeconds: 0, pins: [] });
assert.equal(preferences({ pageResetSeconds: 20 }).pageResetSeconds, 20);
const pin = { view: 'all', key: 'claude:b', slot: 4, title: 'B', app: 'claude' };
assert.deepEqual(preferences({ pageResetSeconds: -1, pins: [pin, pin, { ...pin, slot: 1e9 }, null] }), { pageResetSeconds: 0, pins: [pin] });
const list = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((key, i) => ({ key: `claude:${key}`, cwd: i < 3 ? '/work/Shop' : '/work/Tools', eff: i < 2 ? 'attention' : 'working', since: i + 1 }));
const slots = stableSlots(list);
assert.deepEqual(stableSlots([...list].reverse(), slots), slots);
const pinned = stableSlots(list, slots, [pin]);
assert.equal(pinned[4], 'claude:b');
assert.equal(new Set(pinned.filter(Boolean)).size, list.length);
assert.equal(stableSlots(list.filter(s => s.key !== pin.key), pinned, [pin])[4], pin.key);
assert.deepEqual(stableSlots([], [], [pin]), [null, null, null, null, pin.key]);
const summaries = projectGroups(list);
assert.deepEqual(summaries.map(g => [g.title, g.working, g.attention]), [['Shop', 1, 2], ['Tools', 4, 0]]);
assert.equal(projectGroups([], [{ ...pin, view: 'project:/work/Shop' }])[0].key, 'project:/work/Shop');
assert.equal(waitingSessions(list)[0].key, 'claude:a');
assert.equal(nextWaiting(list).key, 'claude:a');
assert.equal(nextWaiting(list, list[0]).key, 'claude:b');
assert.equal(nextWaiting(list.filter(s => s.key !== 'claude:a'), list[0]).key, 'claude:b');
assert.equal(nextWaiting([]), null);
console.log('model: all-page stability, reserved pins, project counts, optional reset and inbox order ok');

const iterm = terminalTarget({ term: 'iTerm.app', terminalSession: 'w0t0p0:TEST-ID' });
assert.deepEqual(iterm.open, ['open', ['iterm2:reveal?sessionid=w0t0p0%3ATEST-ID']]);
assert.equal(iterm.exact, true);
const terminal = terminalTarget({ term: 'Apple_Terminal', tty: '/dev/ttys001' });
assert.equal(terminal.open[0], 'osascript');
assert.equal(terminal.open[1].at(-1), '/dev/ttys001');
assert.equal(terminal.open[1][1].includes('/dev/ttys001'), false);
assert.equal(terminalTarget({ term: 'Apple_Terminal', tty: '/dev/ttys0" & do shell script "bad' }).exact, false);
if (process.platform === 'darwin') execFileSync('osacompile', ['-o', path.join(home, 'focus.scpt'), '-e', terminal.open[1][1]], { stdio: 'pipe' });
execFileSync(process.execPath, [path.join(root, 'hook.mjs')], { input: JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart' }), env: { ...env, TERM_PROGRAM: 'iTerm.app', ITERM_SESSION_ID: 'w0t0p0:TEST-ID' } });
assert.equal(read(file).terminalSession, 'w0t0p0:TEST-ID');
fire('SessionEnd');
console.log('terminals: native iTerm link, argument-safe Terminal targeting and hook metadata ok');

const project = path.join(home, 'repo space \' " $(touch INJECTED) & < >');
fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true });
for (const file of ['render.mjs', 'install.mjs', 'hook.mjs', 'deck.mjs', 'model.mjs']) fs.copyFileSync(path.join(root, file), path.join(project, file));
fs.symlinkSync(path.join(root, 'node_modules/sharp'), path.join(project, 'node_modules/sharp'));
const { svg, render, pagerSvg, projectSvg, sessionLabels } = await import(pathToFileURL(path.join(project, 'render.mjs')));
for (const app of ['claude', 'codex']) for (const eff of ['working', 'attention', 'done', 'idle', 'error', 'unknown']) {
  const text = svg({ app, eff, title: '<&"\0\uFFFF\uD800🎉 test', since: 0 }, 72, 1000);
  const pixels = await render(text);
  assert.equal(pixels.length, 72 * 72 * 3);
  assert.strictEqual(await render(text), pixels);
}
assert.equal((await render(pagerSvg(120, 0, 3, 17))).length, 120 * 120 * 3);
assert.equal((await render(projectSvg(summaries[0], 72))).length, 72 * 72 * 3);
assert.match(pagerSvg(72, 11, 12), /12 \/ 12/);
assert.doesNotMatch(pagerSvg(72, 11, 12), /<circle/);
const labels = sessionLabels([{ key: 'a', title: 'Shop Checkout Fehler beheben', projectLabel: 'Shop' }, { key: 'b', title: 'Shop Checkout Fehler testen', projectLabel: 'Shop' }]);
assert.notDeepEqual(labels.get('a'), labels.get('b'));
const identical = sessionLabels([{ key: 'a', title: 'Gleiche Aufgabe' }, { key: 'b', title: 'Gleiche Aufgabe' }]);
assert.notDeepEqual(identical.get('a'), identical.get('b'));
for (const eff of ['working', 'idle', 'error', 'unknown', 'done']) {
  const s = { app: 'codex', title: 'Ruhe', eff, since: 1, lastOk: 1 };
  assert.equal(svg(s, 72, 10000), svg(s, 72, 10300));
}
assert.notEqual(svg({ app: 'codex', title: 'Frage', eff: 'attention', since: 1 }, 72, 10000), svg({ app: 'codex', title: 'Frage', eff: 'attention', since: 1 }, 72, 10300));
assert.notEqual(svg({ app: 'codex', title: 'Fertig', eff: 'done', since: 9500 }, 72, 10000), svg({ app: 'codex', title: 'Fertig', eff: 'done', since: 9500 }, 72, 10300));
console.log('rendering: all states without icon files, escaped titles and RGB dimensions ok');

const bin = path.join(home, 'bin');
fs.mkdirSync(bin);
for (const [name, code] of Object.entries({
  launchctl: 'printf "%s\\n" "$@" >> "$HOME/launchctl.log"\nexit 0',
  lsappinfo: 'exit 0', sips: 'exit 1', open: 'if [ "$AIDECK_FAILURE" = "features" ] || [ "$AIDECK_FAILURE" = "restore" ]; then printf "%s\\n" "$@" >> "$HOME/open.log"; exit 0; fi\nexit 1',
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
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hookFile = id => home + '/.ai-deck/claude/' + id + '.json';
const prefsFile = home + '/.ai-deck/preferences.json';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
let opens = 0;
export async function listStreamDecks() { return [{ path: 'pedal' }, { path: 'lcd' }]; }
export async function openStreamDeck(path) {
  const n = path === 'lcd' ? ++opens : 0;
  log('open', path);
  const d = new EventEmitter();
  d.PRODUCT_NAME = path;
  d.CONTROLS = path === 'pedal' ? [] : [0, 4, 9, 12, 16, 21].map(index => ({ type: 'button', feedbackType: 'lcd', index, pixelSize: { width: 72 } }));
  d.clearPanel = async () => { if (n === 1 && process.env.AIDECK_FAILURE === 'init') throw new Error('simulated init failure'); };
  d.close = async () => { log('close', path); };
  d.clearKey = async () => {};
  d.fillKeyBuffer = async (index, buffer) => { if (buffer.length !== 72 * 72 * 3) throw new Error('bad RGB size'); log('draw', index); };
  d.setBrightness = async () => {
    if (['features', 'restore'].includes(process.env.AIDECK_FAILURE)) {
      const press = async (index, held = false) => {
        d.emit('down', d.CONTROLS[index]);
        await delay(held ? 760 : 30);
        d.emit('up', d.CONTROLS[index]);
        await delay(200);
      };
      (async () => {
        await delay(350);
        if (process.env.AIDECK_FAILURE === 'restore') {
          await press(0); // missing pin is still reserved after restart
          await press(0, true); // unpin the inactive session
        } else {
          await press(4); // oldest waiting session, s1
          await press(4); // app-level fallback for s1 must not block the queue
          write(hookFile('s1'), { ...read(hookFile('s1')), state: 'working', at: Date.now(), since: Date.now() });
          await delay(1100);
          await press(4); // s1 resolved, now s2
          await press(0, true); // pin s2; holding must not open it
          await press(5); // page 2
          await press(0); // s4
          await press(5, true); // back to page 1
          await press(5); // forward to page 2
          write(hookFile('s6'), { ...read(hookFile('s6')), state: 'error', at: Date.now(), since: Date.now() });
          write(hookFile('s7'), { ...read(hookFile('s6')), sid: 's7', state: 'attention' });
          await delay(1100);
          await press(1); // s5 keeps its place despite new high-priority sessions
          await press(3); // projects
          await press(0); // Shop (alphabetically first with attention)
          await press(0, true); // independent project pin
          log('project-pin', read(prefsFile).pins);
          await press(0, true); // remove project pin, retain all-sessions pin
          await press(2); // s3 in Shop
          await press(3); // project overview
          await press(3, true); // all sessions
          fs.unlinkSync(hookFile('s2'));
          await delay(1100);
          await press(0); // inactive pinned session stays in slot 0 and does not open
          write(prefsFile, { ...read(prefsFile), pageResetSeconds: 0.1 });
          await press(5);
          await delay(1200);
          await press(0); // optional reset returns to the reserved pin on page 1
        }
        process.kill(process.pid, 'SIGTERM');
      })().catch(e => { console.error(e); process.exit(1); });
    } else if (n === 1) setTimeout(() => { d.emit('error', new Error('unplugged')); d.emit('error', new Error('duplicate')); }, 150);
    else {
      const file = home + '/.ai-deck/claude/s3.json';
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...s, state: 'done', since: Date.now(), at: Date.now() }));
      setTimeout(() => { d.emit('down', { type: 'encoder', index: 0 }); d.emit('up', { type: 'encoder', index: 0 }); d.emit('down', d.CONTROLS[2]); d.emit('up', d.CONTROLS[2]); }, 250);
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
  assert.deepEqual([...new Set(events.filter(e => e.event === 'draw').map(e => e.detail))].sort((a, b) => a - b), [0, 4, 9, 12, 16, 21]);
  assert.equal((run.stdout.match(/open claude:/g) ?? []).length, 1, run.stdout);
  assert.match(run.stdout, /open claude:s3/);
  assert.doesNotMatch(run.stdout, /draw failed|refresh failed|codex read failed/);
  if (failure === 'disconnect') assert.equal(read(path.join(home, '.ai-deck/seen.json'))['claude:s3'], undefined); // failed open stays unread
}
console.log('daemon: unsupported devices, init failure, reconnect, duplicate errors, encoder filtering and key mapping ok');

fs.rmSync(path.dirname(file), { recursive: true, force: true });
fs.mkdirSync(path.dirname(file));
const started = Date.now();
for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(path.dirname(file), `s${i}.json`), JSON.stringify({
  sid: `s${i}`, cwd: `/work/${i <= 3 ? 'Shop' : 'Tools'}`, state: i <= 2 ? 'attention' : 'working', at: started,
  since: started - (i <= 2 ? (3 - i) * 1000 : i * 1000), term: i === 1 ? 'vscode' : 'iTerm.app', terminalSession: `w0t0p0:s${i}`,
}));
const runFeatures = mode => {
  const run = spawnSync(process.execPath, [path.join(project, 'deck.mjs')], { env: { ...isolated, AIDECK_FAILURE: mode }, encoding: 'utf8', timeout: 20000 });
  assert.equal(run.status, 0, run.error?.message || run.stderr + run.stdout);
  assert.doesNotMatch(run.stdout, /draw failed|refresh failed|key failed|pin failed|open failed/);
  return run;
};
const features = runFeatures('features');
assert.deepEqual([...features.stdout.matchAll(/open claude:(s\d+)/g)].map(m => m[1]), ['s1', 's2', 's2', 's4', 's5', 's3'], features.stdout);
assert.deepEqual(fs.readFileSync(path.join(home, 'open.log'), 'utf8').trim().split('\n'), ['-a', 'Visual Studio Code', ...['s2', 's2', 's4', 's5', 's3'].map(id => `iterm2:reveal?sessionid=w0t0p0%3A${id}`)]);
const prefsFile = path.join(home, '.ai-deck/preferences.json');
assert.deepEqual(read(prefsFile).pins.map(({ view, key, slot }) => ({ view, key, slot })), [{ view: 'all', key: 'claude:s2', slot: 0 }]);
assert.equal(fs.statSync(prefsFile).mode & 0o777, 0o600);
const projectPin = fs.readFileSync(path.join(home, 'device.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find(e => e.event === 'project-pin');
assert.deepEqual(projectPin.detail.map(p => p.view).sort(), ['all', 'project:/work/Shop']);
assert.doesNotMatch(runFeatures('restore').stdout, /open claude:/);
assert.deepEqual(read(prefsFile).pins, []);
console.log('features: inbox, paging, stable overflow, projects, per-view pins, persistence and optional page reset ok');
} finally {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  fs.rmSync(home, { recursive: true, force: true });
}
