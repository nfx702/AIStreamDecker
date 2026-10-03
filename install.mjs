#!/usr/bin/env node
// Installs the Claude Code hooks and the LaunchAgent that keeps deck.mjs running. Re-run safe.
// `--gpt` also installs the experimental ChatGPT accessibility bridge; `--uninstall` removes everything again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
const dir = path.dirname(new URL(import.meta.url).pathname);
const node = process.execPath;
const uninstall = process.argv.includes('--uninstall');
const gpt = process.argv.includes('--gpt');
const logDir = path.join(HOME, '.ai-deck');
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];

// --- Claude Code hooks ---
const settingsFile = path.join(HOME, '.claude/settings.json');
const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
fs.copyFileSync(settingsFile, `${settingsFile}.bak-aideck`);
const command = `"${node}" "${path.join(dir, 'hook.mjs')}"`;
settings.hooks ??= {};
for (const ev of new Set([...EVENTS, ...Object.keys(settings.hooks)])) {
  const groups = (settings.hooks[ev] ?? []).filter(g => !g.hooks?.some(h => h.command?.includes('hook.mjs') && h.command.includes(dir)));
  if (!uninstall && EVENTS.includes(ev)) groups.push({ hooks: [{ type: 'command', command, timeout: 5 }] });
  if (groups.length) settings.hooks[ev] = groups; else delete settings.hooks[ev];
}
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
console.log(`${uninstall ? 'removed' : 'installed'} Claude Code hooks (backup: ${settingsFile}.bak-aideck)`);

// --- app icons (extracted locally, not shipped: they are the vendors' trademarks) ---
fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
for (const [name, app] of [['claude', 'Claude'], ['chatgpt', 'ChatGPT']]) {
  const out = path.join(dir, 'assets', `${name}.png`);
  if (uninstall || fs.existsSync(out)) continue;
  const res = `/Applications/${app}.app/Contents/Resources`;
  const icns = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', `/Applications/${app}.app/Contents/Info.plist`]).toString().trim().replace(/\.icns$/, '');
  execFileSync('sips', ['-s', 'format', 'png', '-Z', '64', `${res}/${icns}.icns`, '--out', out], { stdio: 'ignore' });
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
for (const a of agents) {
  const plist = path.join(HOME, 'Library/LaunchAgents', `${a.label}.plist`);
  try { execFileSync('launchctl', ['bootout', `${domain}/${a.label}`], { stdio: 'ignore' }); } catch {}
  if (uninstall || (a.optional && !gpt)) { fs.rmSync(plist, { force: true }); continue; }
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${a.label}</string>
  <key>ProgramArguments</key><array>${a.args.map(x => `<string>${x}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${dir}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(logDir, a.log)}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, a.log)}</string>
</dict></plist>
`);
  for (let i = 0; ; i++) { // bootout is asynchronous; bootstrap fails with EIO until the old job is gone
    try { execFileSync('launchctl', ['bootstrap', domain, plist], { stdio: 'ignore' }); break; }
    catch (e) { if (i === 20) throw e; execFileSync('sleep', ['0.5']); }
  }
}
console.log(uninstall ? 'removed LaunchAgents' : `LaunchAgents running (logs: ${logDir})`);
if (!uninstall && gpt) console.log(`ChatGPT chats need Accessibility for ${gptApp}\n(System Settings → Privacy & Security → Accessibility → +)`);
