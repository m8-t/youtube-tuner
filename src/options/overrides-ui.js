// The "Channel rules" table: per-channel exceptions to the global rules.
import { loadOverrides, saveOverrides } from '../storage/overrides.js';
import { el } from './dom.js';

function overrideMode(rule) {
  if (!rule) return 'default';
  return rule.enabled === false ? 'off' : 'custom';
}

function createModeSelect(ruleName, rule) {
  const select = document.createElement('select');
  select.className = `override-${ruleName}-mode`;
  for (const [value, label] of [
    ['default', 'Default'],
    ['off', 'Off'],
    ['custom', 'Custom'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
  select.value = overrideMode(rule);
  return select;
}

function createLimitInput(ruleName, numberKey, rule, labelText) {
  const label = document.createElement('label');
  label.className = `override-limit override-${ruleName}-limit-row`;
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.step = '1';
  input.className = `override-${ruleName}-limit`;
  if (rule?.[numberKey] !== undefined) {
    input.value = rule[numberKey];
    input.dataset.savedValue = rule[numberKey];
  }
  label.append(input, ` ${labelText}`);
  return { label, input };
}

function updateOverrideLimit(row, ruleName) {
  const custom =
    row.querySelector(`.override-${ruleName}-mode`).value === 'custom';
  row.querySelector(`.override-${ruleName}-limit-row`).hidden = !custom;
}

function appendOverrideRow(channelName = '', override = {}) {
  const row = document.createElement('tr');

  const channelCell = document.createElement('td');
  const channel = document.createElement('input');
  channel.type = 'text';
  channel.className = 'override-channel';
  channel.value = channelName;
  channel.placeholder = 'Channel name';
  channelCell.appendChild(channel);

  const watchedCell = document.createElement('td');
  const watchedLabel = document.createElement('label');
  const watched = document.createElement('input');
  watched.type = 'checkbox';
  watched.className = 'override-watched';
  watched.checked = override.watched?.enabled !== false;
  watchedLabel.append(watched, ' Apply watched rule');
  watchedCell.appendChild(watchedLabel);

  const ageCell = document.createElement('td');
  const ageMode = createModeSelect('age', override.age);
  const ageLimit = createLimitInput(
    'age',
    'maxAgeDays',
    override.age,
    'days',
  );
  ageCell.append(ageMode, ageLimit.label);

  const viewCell = document.createElement('td');
  const viewMode = createModeSelect('view', override.view);
  const viewLimit = createLimitInput(
    'view',
    'minViews',
    override.view,
    'views',
  );
  viewCell.append(viewMode, viewLimit.label);

  const actionCell = document.createElement('td');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'override-remove';
  remove.textContent = 'Remove';
  actionCell.appendChild(remove);

  row.append(channelCell, watchedCell, ageCell, viewCell, actionCell);
  el('override-rows').appendChild(row);
  updateOverrideLimit(row, 'age');
  updateOverrideLimit(row, 'view');

  for (const input of row.querySelectorAll('input, select')) {
    input.addEventListener('change', async () => {
      updateOverrideLimit(row, 'age');
      updateOverrideLimit(row, 'view');
      if (channel.value.trim() || channelName) await persistOverrides();
    });
  }
  remove.addEventListener('click', async () => {
    row.remove();
    await persistOverrides();
  });
}

function readRuleOverride(row, ruleName, numberKey) {
  const mode = row.querySelector(`.override-${ruleName}-mode`).value;
  if (mode === 'default') return null;
  if (mode === 'off') return { enabled: false };
  const rule = { enabled: true };
  const input = row.querySelector(`.override-${ruleName}-limit`);
  const value = input.valueAsNumber;
  const savedValue = Number(input.dataset.savedValue);
  if (Number.isInteger(value) && value > 0) {
    rule[numberKey] = value;
  } else if (Number.isInteger(savedValue) && savedValue > 0) {
    rule[numberKey] = savedValue;
  }
  return rule;
}

function readOverrideRows() {
  const overrides = new Map();
  for (const row of el('override-rows').querySelectorAll('tr')) {
    const channelName = row.querySelector('.override-channel').value;
    const override = {};
    if (!row.querySelector('.override-watched').checked) {
      override.watched = { enabled: false };
    }
    const age = readRuleOverride(row, 'age', 'maxAgeDays');
    const view = readRuleOverride(row, 'view', 'minViews');
    if (age) override.age = age;
    if (view) override.view = view;
    overrides.set(channelName, override);
  }
  return overrides;
}

export async function persistOverrides() {
  await saveOverrides(readOverrideRows());
  await renderOverrides();
}

export async function renderOverrides() {
  const overrides = await loadOverrides();
  el('override-rows').textContent = '';
  const sorted = [...overrides]
    .sort(([first], [second]) => first.localeCompare(second));
  for (const [channelName, override] of sorted) {
    appendOverrideRow(channelName, override);
  }
}

export function addOverrideRow() {
  appendOverrideRow();
}

export async function setupOverridesEditor() {
  await renderOverrides();
  el('override-add').addEventListener('click', addOverrideRow);
}
