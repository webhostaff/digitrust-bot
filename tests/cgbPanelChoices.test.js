'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { panelChoices, panelChoicePage } = require('../services/cgbPanelChoices');

const known = [
  { id: 'panel-22', name: 'Panel 22', state: 'offline' },
  { id: 'panel-26', name: 'Panel 26', state: 'offline' },
];
const placeholder = { id: 'ph:Panel 8', name: 'Panel 8', state: 'noBot', placeholder: true };
test('offline invite service does not hide Panel 22 or Panel 26 behind Panel 8', async () => {
  const panels = await panelChoices({ fetchGuardPanelsNamed: async () => null, rememberedPanels: () => known }, { placeholderPanels: () => [placeholder] });
  assert.deepEqual(panels.map(p => p.id), ['panel-22', 'panel-26', 'ph:Panel 8']);
  assert.equal(panels[0].state, 'offline');
});
test('partial live response retains configured destinations and live state wins for matching ID', async () => {
  const panels = await panelChoices({ fetchGuardPanelsNamed: async () => [{ id: 'panel-22', name: 'Panel 22 live', state: 'running' }], rememberedPanels: () => known }, { placeholderPanels: () => [] });
  assert.equal(panels.length, 2);
  assert.equal(panels.find(p => p.id === 'panel-22').state, 'running');
  assert.equal(panels.find(p => p.id === 'panel-26').state, 'offline');
});
test('same-name real panels keep different destination IDs; name-only duplicate is suppressed', async () => {
  const panels = await panelChoices({ fetchGuardPanelsNamed: async () => [{ id: 'a', name: 'Panel 8' }, { id: 'b', name: 'Panel 8' }], rememberedPanels: () => [] }, { placeholderPanels: () => [placeholder] });
  assert.deepEqual(panels.map(p => p.id), ['a', 'b']);
});
test('all 45 destinations remain selectable through stable page indices', () => {
  const panels = Array.from({ length: 45 }, (_, i) => ({ id: `panel-${i}`, name: `Panel ${i}`, state: 'running' }));
  const callbacks = [0, 1, 2].flatMap(page => panelChoicePage(panels, '1234abcd', '', page).inline_keyboard.flat().map(b => b.callback_data).filter(v => v.startsWith('cgb_cpp_')));
  assert.deepEqual(callbacks, panels.map((_, i) => `cgb_cpp_1234abcd_${i}`));
});

function flowFixture() {
  const source = fs.readFileSync(require.resolve('../chatgpt-bot'), 'utf8');
  const code = source.slice(source.indexOf('const pendingPanelMoves ='), source.indexOf('/**\n * V157.1:', source.indexOf('const pendingPanelMoves =')));
  const seat = { id: 7, order_id: 17498, email: 'solarcity@example.com', status: 'active', start_date: '2026-09-25', end_date: '2027-08-24' };
  const sent = [], edits = [], moves = [];
  const ctx = {
    require: name => name === 'crypto' ? require('node:crypto') : { placeholderPanels: () => [placeholder] },
    Date, Map, PENDING_EDIT_MS: 600000, panelChoices, panelChoicePage,
    bot: { sendMessage: async (...args) => sent.push(args), editMessageText: async (...args) => edits.push(args), editMessageReplyMarkup: async (...args) => edits.push(args) },
    cgbGuard: { fetchGuardPanelsNamed: async () => null, rememberedPanels: () => known, isPlaceholderPanel: id => id.startsWith('ph:'), panelNameCached: id => id },
    queries: { getCgbSubById: () => seat, getCgbSubscriptionByOrder: () => seat },
    seatPanelNow: async () => 'panel-26', seatPlace: () => ({ panel: 'Panel 26' }), escapeHtml: s => String(s || ''),
    applyPanelMove: async (sub, target, mode) => { moves.push({ subId: sub.id, target, mode }); return ['Moved']; },
  };
  vm.runInNewContext(code + '\nglobalThis.flow = { startPanelChange, handlePanelMoveButton };', ctx);
  return { ...ctx.flow, sent, edits, moves, seat };
}
test('email transfer selects remembered Panel 22 and confirms exactly that destination', async () => {
  const f = flowFixture();
  await f.startPanelChange(1, f.seat);
  const button = f.sent[0][2].reply_markup.inline_keyboard.flat().find(b => b.text.includes('Panel 22'));
  assert.ok(button);
  await f.handlePanelMoveButton(button.callback_data, 1, 2, 3);
  const confirm = f.edits[0][1].reply_markup.inline_keyboard[1][0];
  await f.handlePanelMoveButton(confirm.callback_data, 1, 2, 3);
  assert.deepEqual(f.moves, [{ subId: 7, target: 'panel-22', mode: 'm' }]);
});
test('out-of-range confirmation cannot mutate a seat', async () => {
  const f = flowFixture();
  await f.startPanelChange(1, f.seat);
  const cb = f.sent[0][2].reply_markup.inline_keyboard[0][0].callback_data;
  const token = cb.split('_')[2];
  await f.handlePanelMoveButton(`cgb_cpp_${token}_999`, 1, 2, 3);
  await f.handlePanelMoveButton(`cgb_cpd_${token}_m_999`, 1, 2, 3);
  assert.equal(f.moves.length, 0);
});
test('pagination callback updates the same selector without performing a move', async () => {
  const f = flowFixture();
  await f.startPanelChange(1, f.seat);
  const token = f.sent[0][2].reply_markup.inline_keyboard[0][0].callback_data.split('_')[2];
  await f.handlePanelMoveButton(`cgb_cpg_${token}_0`, 1, 2, 3);
  assert.equal(f.edits[0][0].inline_keyboard[0][0].callback_data, `cgb_cpp_${token}_0`);
  assert.equal(f.moves.length, 0);
});