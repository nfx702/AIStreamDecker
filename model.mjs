import path from 'node:path';

export const PRIORITY = { attention: 5, error: 4, unknown: 3, done: 2, working: 1, idle: 0 };
export const projectId = cwd => typeof cwd === 'string' && path.isAbsolute(cwd) ? path.normalize(cwd) : '';
export const projectName = cwd => cwd ? path.basename(cwd) || cwd : 'Allgemein';

export function preferences(value) {
  const pins = [], keys = new Set(), slots = new Set();
  for (const p of Array.isArray(value?.pins) ? value.pins : []) {
    if (!p || typeof p.view !== 'string' || !(p.view === 'all' || p.view.startsWith('project:')) ||
        typeof p.key !== 'string' || !/^(claude|codex):.+$/.test(p.key) ||
        !Number.isInteger(p.slot) || p.slot < 0 || p.slot > 4095) continue;
    const key = JSON.stringify([p.view, p.key]), slot = JSON.stringify([p.view, p.slot]);
    if (keys.has(key) || slots.has(slot)) continue;
    keys.add(key); slots.add(slot);
    pins.push({ view: p.view, key: p.key, slot: p.slot, title: typeof p.title === 'string' ? p.title : 'Angeheftet', app: p.key.split(':')[0] });
  }
  const seconds = value?.pageResetSeconds;
  return { pageResetSeconds: Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400 ? seconds : 0, pins };
}

// Slots are retained across every page. Missing pinned sessions keep their reserved position.
export function stableSlots(items, previous = [], pins = []) {
  const live = new Set(items.map(s => s.key)), placed = new Set();
  const slots = Array(Math.max(previous.length, ...pins.map(p => p.slot + 1), 0)).fill(null);
  for (const p of pins) { slots[p.slot] = p.key; placed.add(p.key); }
  previous.forEach((key, i) => {
    if (live.has(key) && !placed.has(key) && slots[i] === null) { slots[i] = key; placed.add(key); }
  });
  for (const { key } of items) if (!placed.has(key)) {
    const free = slots.indexOf(null);
    if (free < 0) slots.push(key); else slots[free] = key;
    placed.add(key);
  }
  while (slots.length && slots.at(-1) === null) slots.pop();
  return slots;
}

export function projectGroups(sessions, pins = []) {
  const groups = new Map();
  const add = cwd => {
    const key = `project:${cwd}`;
    if (!groups.has(key)) groups.set(key, { key, kind: 'project', title: projectName(cwd), project: cwd, working: 0, attention: 0, unknown: 0, total: 0, eff: 'idle' });
    return groups.get(key);
  };
  for (const s of sessions) {
    const g = add(projectId(s.cwd));
    g.total++;
    if (['working', 'attention', 'unknown'].includes(s.eff)) g[s.eff]++;
    if (PRIORITY[s.eff] > PRIORITY[g.eff]) g.eff = s.eff;
  }
  for (const p of pins) if (p.view.startsWith('project:')) add(p.view.slice(8));
  const result = [...groups.values()];
  for (const g of result) if (result.some(other => other !== g && projectName(other.project) === projectName(g.project))) {
    g.title = `${projectName(path.dirname(g.project))} / ${projectName(g.project)}`;
  }
  return result.sort((a, b) => PRIORITY[b.eff] - PRIORITY[a.eff] || a.title.localeCompare(b.title));
}

export function waitingSessions(sessions) {
  return sessions.filter(s => s.eff === 'attention').sort((a, b) => a.since - b.since || a.key.localeCompare(b.key));
}

export function nextWaiting(sessions, previous) {
  const waiting = waitingSessions(sessions);
  const i = waiting.findIndex(s => s.key === previous?.key && s.since === previous.since);
  return waiting[(i + 1) % waiting.length] ?? null;
}
