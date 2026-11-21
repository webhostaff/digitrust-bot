'use strict';

// Keep configured targets selectable even when an invite service is offline.
async function panelChoices(guard, routing, timeoutMs = 6000) {
  const live = (await guard.fetchGuardPanelsNamed(timeoutMs).catch(() => null)) || [];
  const byId = new Map();
  for (const p of [...guard.rememberedPanels(), ...live]) {
    if (p && p.id) byId.set(p.id, p);
  }
  for (const p of routing.placeholderPanels()) {
    if (!byId.has(p.id) && ![...byId.values()].some(r => r.name === p.name)) byId.set(p.id, p);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const PAGE_SIZE = 20;
function panelChoicePage(panels, token, current, requestedPage = 0) {
  const pages = Math.max(1, Math.ceil(panels.length / PAGE_SIZE));
  const page = Math.min(pages - 1, Math.max(0, Math.trunc(Number(requestedPage)) || 0));
  const icons = { running: '🟢', stopped: '⚪', paused: '⏸', waiting: '⏳', noBot: '🏷', offline: '⚠️' };
  const rows = panels.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((p, offset) => [{
    text: `${p.id === current ? '📍 ' : ''}${icons[p.state] || '•'} ${p.name}${p.placeholder ? ' (no bot yet)' : ''}`.slice(0, 60),
    callback_data: `cgb_cpp_${token}_${page * PAGE_SIZE + offset}`,
  }]);
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '⬅️', callback_data: `cgb_cpg_${token}_${page - 1}` });
    nav.push({ text: `${page + 1}/${pages}`, callback_data: `cgb_cpg_${token}_${page}` });
    if (page + 1 < pages) nav.push({ text: '➡️', callback_data: `cgb_cpg_${token}_${page + 1}` });
    rows.push(nav);
  }
  rows.push([{ text: '❌ Cancel', callback_data: `cgb_cpd_${token}_x_0` }]);
  return { inline_keyboard: rows };
}

module.exports = { panelChoices, panelChoicePage };