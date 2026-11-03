'use strict';

const $ = id => document.getElementById(id);

const state = {
  active: 'ace',
  ace: null,
  atl: null,
  attendance: null
};

const config = {
  ace: {
    label: 'ACE',
    subtitle: 'Average ACE points per pupil · This week',
    detail: 'RANKED BY ACE POINTS PER PUPIL · TOP FORM',
    unit: 'ACE pts / pupil'
  },
  atl: {
    label: 'AtL',
    subtitle: 'Average AtL score per award · This week · Lower is better',
    detail: 'RANKED BY LOWEST AVERAGE AtL · TOP FORM',
    unit: 'AtL average'
  },
  attendance: {
    label: 'Attendance',
    subtitle: 'Weekly statutory attendance · Highest is better',
    detail: 'RANKED BY WEEKLY ATTENDANCE % · TOP FORM',
    unit: 'attendance'
  }
};

// AtL chart: best form = 100%, worst form = 70%.
const MIN_ATL_BAR = 70;
const ROTATION_MS = 30_000;
const REFRESH_MS = 60_000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function number(value, type) {
  return Number(value).toFixed(type === 'atl' ? 3 : type === 'attendance' ? 1 : 2) + (type === 'attendance' ? '%' : '');
}

function hasScore(row, type) {
  const average = Number(row.average);
  if (!Number.isFinite(average)) return false;
  if (row.average == null) return false;
  if (type === 'attendance') return average >= 0 && average <= 100;
  return type === 'ace'
    ? Number(row.pupils) > 0
    : Number(row.awards) > 0 && average > 0;
}

function calculateYearAverage(rows, type) {
  if (type === 'attendance') return null; // year rate comes directly from Arbor
  const valid = rows.filter(row => hasScore(row, type));
  const totalPoints = valid.reduce((sum, row) => sum + Number(row.points), 0);
  const denominator = valid.reduce(
    (sum, row) => sum + Number(type === 'ace' ? row.pupils : row.awards), 0
  );
  return denominator > 0 ? totalPoints / denominator : null;
}

function sortByScore(a, b, type) {
  const aValid = hasScore(a, type);
  const bValid = hasScore(b, type);
  if (!aValid && !bValid) return String(a.form).localeCompare(String(b.form));
  if (!aValid) return 1;
  if (!bValid) return -1;
  const difference = type === 'atl'
    ? Number(a.average) - Number(b.average)
    : Number(b.average) - Number(a.average);
  return difference || String(a.form).localeCompare(String(b.form));
}

function calculateBarWidth(row, type, values) {
  if (!hasScore(row, type)) return 0;
  const average = Number(row.average);

  if (type === 'attendance') return Math.max(0, Math.min(100, average));

  if (type === 'ace') {
    // ACE unchanged: each year's highest-scoring form fills its bar.
    const max = Math.max(1, ...values);
    return Math.max(0, Math.min(100, average / max * 100));
  }

  // AtL: compressed visual range. Lower score is better.
  const best = Math.min(...values);
  const worst = Math.max(...values);
  if (worst === best) return 100;
  const percentage = MIN_ATL_BAR +
    ((worst - average) / (worst - best)) * (100 - MIN_ATL_BAR);
  return Math.max(MIN_ATL_BAR, Math.min(100, percentage));
}

function drawBoards(groups, type, yearGroups = []) {
  const byYear = new Map();
  for (const row of groups) {
    if (!byYear.has(row.year)) byYear.set(row.year, []);
    byYear.get(row.year).push(row);
  }

  const years = [...byYear].map(([year, rows]) => ({
    year, rows, average: type === 'attendance'
      ? (yearGroups.find(item => Number(item.year) === Number(year))?.average ?? null)
      : calculateYearAverage(rows, type)
  }));

  years.sort((a, b) => {
    if (a.average === null && b.average === null) return Number(a.year) - Number(b.year);
    if (a.average === null) return 1;
    if (b.average === null) return -1;
    const difference = type === 'atl'
      ? a.average - b.average
      : b.average - a.average;
    return difference || Number(a.year) - Number(b.year);
  });

  const fragment = document.createDocumentFragment();

  years.forEach((group, yearIndex) => {
    const rows = [...group.rows].sort((a, b) => sortByScore(a, b, type));
    const values = rows.filter(row => hasScore(row, type))
      .map(row => Number(row.average));
    const topForm = rows.find(row => hasScore(row, type))?.form ?? '—';

    const board = el('section', 'year-board' + (
      yearIndex === 0 && group.average !== null ? ' winning-year' : ''
    ));

    const label = el('div', 'year-label');
    const topLine = el('div', 'year-topline');
    topLine.append(
      el('span', 'year-rank', `#${yearIndex + 1}`),
      el('span', 'year-small', 'YEAR GROUP')
    );
    label.append(topLine, el('div', 'year-number', `Year ${group.year}`));

    const score = el('div', 'year-score');
    score.append(
      el('strong', '', group.average === null ? '—' : number(group.average, type)),
      el('span', '', ` ${config[type].unit}`)
    );
    label.append(score, el('div', 'leader', `Top form: ${topForm}`));

    const list = el('div', 'form-list');
    rows.forEach((row, i) => {
      const valid = hasScore(row, type);
      const line = el('div', 'form-row');
      line.append(
        el('div', 'form-rank', valid ? String(i + 1) : '—'),
        el('div', 'form-name', row.form)
      );

      const track = el('div', 'bar-track');
      const fill = el('div', 'bar-fill');
      const pct = calculateBarWidth(row, type, values);
      fill.style.setProperty('--pct', `${pct}%`);
      track.append(fill);

      line.append(track, el('div', 'form-value', valid ? number(row.average, type) : '—'));
      line.title = type === 'ace'
        ? `${row.form}: ${row.points} ACE points / ${row.pupils} pupils`
        : type === 'atl'
          ? `${row.form}: ${row.points} AtL points / ${row.awards} awards`
          : `${row.form}: ${number(row.average, type)} weekly attendance`; 
      list.append(line);
    });

    board.append(label, list);
    fragment.append(board);
  });

  const boards = $('boards');
  boards.replaceChildren(fragment);
  boards.style.gridTemplateRows = years.length
    ? years.map(year => `minmax(0, ${year.rows.length + 2}fr)`).join(' ')
    : '1fr';

  boards.querySelectorAll('.year-board').forEach((section, i) => {
    section.querySelector('.form-list').style.gridTemplateRows =
      `repeat(${years[i].rows.length}, minmax(0, 1fr))`;
  });
}

function render() {
  const type = state.active;
  const data = state[type];
  const info = config[type];

  $('page-title').replaceChildren(
    document.createTextNode(info.label + ' '),
    el('span', '', 'Form Leaderboard')
  );
  $('subtitle').textContent = info.subtitle;
  $('metric-description').textContent = info.detail;

  document.querySelectorAll('.tab').forEach(button => {
    const active = button.dataset.type === type;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });

  if (!data || !data.groups?.length) {
    $('boards').replaceChildren(el(
      'div', 'loading',
      'No ' + info.label + ' data available yet. Check the Python console.'
    ));
    $('boards').style.gridTemplateRows = '1fr';
    $('status').textContent = 'Waiting for ' + info.label + ' data';
    $('status').parentElement.classList.add('error');
    $('updated').textContent = 'No successful update';
    return;
  }

  drawBoards(data.groups, type, data.years || []);
  $('status').textContent = data.stale
    ? 'Showing previous results'
    : info.label + ' data up to date';
  $('status').parentElement.classList.toggle('error', Boolean(data.stale));
  $('updated').textContent = data.updated
    ? `Arbor refreshed ${new Date(data.updated).toLocaleString('en-GB', {
        dateStyle: 'medium', timeStyle: 'short'
      })}`
    : 'Waiting for first update';
}

async function fetchOne(type) {
  try {
    const endpoints = type === 'attendance'
      ? ['/api/attendance_form', '/api/attendance_year']
      : ['/api/' + type];
    const results = await Promise.all(endpoints.map(async endpoint => {
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      if (!Array.isArray(json.groups)) throw new Error('Invalid response from ' + endpoint);
      return json;
    }));
    state[type] = type === 'attendance'
      ? { groups: results[0].groups, years: results[1].groups,
          stale: results.some(r => r.stale),
          updated: results.map(r => r.updated).filter(Boolean).sort()[0] || null }
      : results[0];
  } catch (error) {
    console.error(type + ' update failed:', error);
    if (state[type]) state[type].stale = true;
  }
  if (type === state.active) render();
}

function refresh() {
  // Python controls :15/:45 Arbor fetches; browser checks cached results.
  return Promise.all([fetchOne('ace'), fetchOne('atl'), fetchOne('attendance')]);
}

// Rotation affects only the visible leaderboard, never Arbor data refreshes.
// Default: enabled. Switch state is not persisted across page reloads.
let rotationTimer = null;
const autoRotate = $('auto-rotate');

function rotateTab() {
  const order = ['ace', 'atl', 'attendance'];
  state.active = order[(order.indexOf(state.active) + 1) % order.length];
  render();
}

function restartRotation() {
  clearInterval(rotationTimer);
  rotationTimer = null;
  if (autoRotate.checked) {
    rotationTimer = setInterval(rotateTab, ROTATION_MS);
  }
}

autoRotate.addEventListener('change', restartRotation);

document.querySelectorAll('.tab').forEach(button => {
  button.addEventListener('click', () => {
    state.active = button.dataset.type;
    render();
    restartRotation(); // Manual selection gets a full 30 seconds if enabled.
  });
});

refresh();
setInterval(refresh, REFRESH_MS);
restartRotation();
