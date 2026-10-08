#!/usr/bin/env node
// Installs the Claude Code hooks and the LaunchAgent that keeps deck.mjs running. Re-run safe.
// `--gpt` also installs the experimental ChatGPT accessibility bridge; `--uninstall` removes everything again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.umask(0o077);
const HOME = os.homedir();
const dir = path.dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const uninstall = process.argv.includes('--uninstall');
const gpt = process.argv.includes('--gpt');
const logDir = path.join(HOME, '.ai-deck');
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];
const quote = s => `'${s.replace(/'/g, "'\\''")}'`;
const xml = s => s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

// --- Claude Code hooks ---
const settingsFile = path.join(HOME, '.claude/settings.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Claude settings must be a JSON object');
const hook = path.join(dir, 'hook.mjs');
const command = `${quote(node)} ${quote(hook)}`;
const isDeckHook = command => {
  const match = typeof command === 'string' && command.match(/^(['"])(.*?)\1 (.+)$/s);
  return !!match && path.basename(match[2]) === path.basename(node) && [quote(hook), `"${hook}"`].includes(match[3]);
}; // recognize the original quoting and older Node installations too
settings.hooks ??= {};
if (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) throw new Error('Claude hooks must be a JSON object');
for (const ev of new Set([...EVENTS, ...Object.keys(settings.hooks)])) {
  const groups = (settings.hooks[ev] ?? []).flatMap(g => {
    const hooks = g.hooks?.filter(h => !isDeckHook(h.command));
    return !hooks || hooks.length === g.hooks.length ? [g] : hooks.length ? [{ ...g, hooks }] : [];
  });
  if (!uninstall && EVENTS.includes(ev)) groups.push({ hooks: [{ type: 'command', command, timeout: 5 }] });
  if (groups.length) settings.hooks[ev] = groups; else delete settings.hooks[ev];
}
if (!uninstall || fs.existsSync(settingsFile)) {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  try { fs.copyFileSync(settingsFile, `${settingsFile}.bak-aideck`, fs.constants.COPYFILE_EXCL); }
  catch (e) { if (e.code !== 'ENOENT' && e.code !== 'EEXIST') throw e; }
  const tmp = `${settingsFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, settingsFile);
}
console.log(`${uninstall ? 'removed' : 'installed'} Claude Code hooks`);

// --- app icons (extracted locally, not shipped: they are the vendors' trademarks) ---
if (!uninstall) fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
for (const [name, app] of [['claude', 'Claude'], ['chatgpt', 'ChatGPT']]) {
  const out = path.join(dir, 'assets', `${name}.png`);
  if (uninstall || fs.existsSync(out)) continue;
  const res = `/Applications/${app}.app/Contents/Resources`;
  try {
    const icns = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', `/Applications/${app}.app/Contents/Info.plist`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().replace(/\.icns$/, '');
    execFileSync('sips', ['-s', 'format', 'png', '-Z', '64', `${res}/${icns}.icns`, '--out', out], { stdio: 'ignore' });
  } catch { console.warn(`${app} icon unavailable; using the built-in label`); }
}

// --- LaunchAgents ---
const domain = `gui/${process.getuid()}`;
const gptApp = path.join(dir, 'gpt-ax/AIStreamDeckerGPT.app');
const agents = [
  { label: 'de.nfxmedia.aistreamdecker', args: [node, path.join(dir, 'deck.mjs')], log: 'deck.log' },
  { label: 'de.nfxmedia.gpt-ax', args: [path.join(gptApp, 'Contents/MacOS/gpt-ax')], log: 'gpt-ax.log', optional: true },
];

if (!uninstall && gpt && !fs.existsSync(gptApp)) {
  // only build when missing: an ad-hoc signed rebuild makes macOS drop the Accessibility grant
  execFileSync(path.join(dir, 'gpt-ax/build.sh'), { stdio: 'inherit' });
}

fs.mkdirSync(logDir, { recursive: true });
fs.chmodSync(logDir, 0o700);
if (!uninstall) fs.mkdirSync(path.join(HOME, 'Library/LaunchAgents'), { recursive: true });
for (const a of agents) {
  const plist = path.join(HOME, 'Library/LaunchAgents', `${a.label}.plist`);
  try { execFileSync('launchctl', ['bootout', `${domain}/${a.label}`], { stdio: 'ignore' }); } catch {}
  if (uninstall || (a.optional && !gpt)) { fs.rmSync(plist, { force: true }); continue; }
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${a.label}</string>
  <key>ProgramArguments</key><array>${a.args.map(x => `<string>${xml(x)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${xml(dir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(path.join(logDir, a.log))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logDir, a.log))}</string>
</dict></plist>
`);
  for (let i = 0; ; i++) { // bootout is asynchronous; bootstrap fails with EIO until the old job is gone
    try { execFileSync('launchctl', ['bootstrap', domain, plist], { stdio: 'ignore' }); break; }
    catch (e) { if (i === 20) throw e; execFileSync('sleep', ['0.5']); }
  }
}
console.log(uninstall ? 'removed LaunchAgents' : `LaunchAgents running (logs: ${logDir})`);
if (!uninstall && gpt) console.log(`ChatGPT chats need Accessibility for ${gptApp}\n(System Settings → Privacy & Security → Accessibility → +)`);
