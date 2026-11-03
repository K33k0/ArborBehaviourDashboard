'use strict';

const $ = id => document.getElementById(id);

function readLocal(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The dashboard still works when browser storage is unavailable.
  }
}

const preferences = readLocal('orme-display', {});
const state = {
  active: ['ace', 'atl', 'attendance'].includes(preferences.tab) ? preferences.tab : 'ace',
  ace: null,
  atl: null,
  attendance_form: null,
  attendance_year: null
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
    : Number(row.awards) > 0;
}

function formKey(row) {
  return JSON.stringify([row.year, row.form]);
}

function trackMovement(feed, data) {
  const day = data.updated?.slice(0, 10);
  if (!day) return;
  const type = feed === 'attendance_form' ? 'attendance' : feed;
  const date = new Date(day + 'T12:00:00Z');
  const weekday = date.getUTCDay();
  const key = 'orme-history-' + feed;
  const history = readLocal(key, {});
  if (!data.stale && weekday >= 1 && weekday <= 5) {
    history[day] = Object.fromEntries(data.groups.filter(row => hasScore(row, type))
      .map(row => [formKey(row), Number(row.average)]));
    const recent = Object.keys(history).sort().slice(-7);
    writeLocal(key, Object.fromEntries(recent.map(item => [item, history[item]])));
  }
  if (weekday < 1 || weekday > 5) return;
  date.setUTCDate(date.getUTCDate() - (weekday === 1 ? 3 : 1));
  data.previous = history[date.toISOString().slice(0, 10)];
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

let minimumBoardHeight = 0;

function fitBoards() {
  const viewport = $('board-viewport');
  const scale = Math.min(1, viewport.clientWidth / 320,
    viewport.clientHeight / Math.max(1, minimumBoardHeight));
  $('boards').style.zoom = scale > 0 ? String(scale) : '1';
}

function drawBoards(groups, type, yearGroups = [], previous = {}) {
  const byYear = new Map();
  for (const row of groups) {
    if (!byYear.has(row.year)) byYear.set(row.year, []);
    byYear.get(row.year).push(row);
  }
  for (const row of yearGroups) {
    if (!byYear.has(row.year)) byYear.set(row.year, []);
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
      el('span', 'year-rank', group.average === null ? '—' : `#${yearIndex + 1}`),
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
    if (!rows.length) list.append(el('div', 'loading', 'Form results unavailable'));
    rows.forEach((row, i) => {
      const valid = hasScore(row, type);
      const line = el('div', 'form-row');
      const name = el('div', 'form-name', row.form);
      name.title = row.form;
      line.append(
        el('div', 'form-rank', valid ? String(i + 1) : '—'),
        name
      );

      const track = el('div', 'bar-track');
      const fill = el('div', 'bar-fill');
      const pct = calculateBarWidth(row, type, values);
      fill.style.setProperty('--pct', `${pct}%`);
      track.append(fill);

      const noAwards = type === 'atl' && row.awards === 0;
      const value = el('div', 'form-value', valid ? number(row.average, type) : noAwards ? 'No awards yet' : '—');
      const prior = previous[formKey(row)];
      if (valid && Number.isFinite(prior)) {
        const precision = type === 'atl' ? 3 : type === 'attendance' ? 1 : 2;
        const delta = Number((row.average - prior).toFixed(precision));
        if (delta) {
          const movement = el('span', 'movement', `${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(precision)}${type === 'attendance' ? 'pp' : ''}`);
          movement.title = 'Score change since the previous weekday';
          value.append(movement);
        }
      }
      line.append(track, value);
      list.append(line);
    });

    board.append(label, list);
    fragment.append(board);
  });

  const boards = $('boards');
  const minimumHeights = years.map(year => Math.max(82, year.rows.length * 19 + 12));
  minimumBoardHeight = minimumHeights.reduce((total, height) => total + height, 0)
    + Math.max(0, years.length - 1) * 5;
  boards.replaceChildren(fragment);
  boards.style.gridTemplateRows = years.length
    ? years.map((year, i) => `minmax(${minimumHeights[i]}px, ${year.rows.length + 2}fr)`).join(' ')
    : '1fr';

  boards.querySelectorAll('.year-board').forEach((section, i) => {
    section.querySelector('.form-list').style.gridTemplateRows =
      `repeat(${Math.max(1, years[i].rows.length)}, minmax(18px, 1fr))`;
  });
  fitBoards();
}

function render() {
  const type = state.active;
  const formFeed = state[type === 'attendance' ? 'attendance_form' : type];
  const yearFeed = type === 'attendance' ? state.attendance_year : null;
  const groups = formFeed?.groups ?? [];
  const years = yearFeed?.groups ?? [];
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

  if (!groups.length && !years.length) {
    $('boards').replaceChildren(el(
      'div', 'loading',
      'No ' + info.label + ' data available yet. Check the Python console.'
    ));
    $('boards').style.gridTemplateRows = '1fr';
    minimumBoardHeight = 0;
    fitBoards();
    $('status').textContent = 'Waiting for ' + info.label + ' data';
    $('status').parentElement.classList.add('error');
    $('updated').textContent = 'No successful update';
    return;
  }

  drawBoards(groups, type, years, formFeed?.previous);
  const feeds = type === 'attendance' ? [['Forms', formFeed], ['Years', yearFeed]] : [[info.label, formFeed]];
  const current = feeds.every(([, feed]) => feed?.updated && !feed.stale);
  $('status').textContent = current ? info.label + ' data up to date' : 'Some results are stale or unavailable';
  $('status').parentElement.classList.toggle('error', !current);
  $('updated').textContent = feeds.map(([label, feed]) => {
    if (!feed?.updated) return label + ' unavailable';
    const time = new Date(feed.updated).toLocaleString('en-GB', {
      dateStyle: 'medium', timeStyle: 'short'
    });
    return `${label} ${time}${feed.stale ? ' (stale)' : ''}`;
  }).join(' · ');
}

async function fetchOne(feed) {
  try {
    const response = await fetch('/api/' + feed, {
      cache: 'no-store', signal: AbortSignal.timeout(45_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.groups)) throw new Error('Invalid response from ' + feed);
    if (feed !== 'attendance_year') trackMovement(feed, data);
    state[feed] = data.updated || !state[feed]?.updated ? data : { ...state[feed], stale: true };
  } catch (error) {
    console.error(feed + ' update failed:', error);
    if (state[feed]) state[feed].stale = true;
  }
  if (feed === state.active || (state.active === 'attendance' && feed.startsWith('attendance_'))) render();
}

function refresh() {
  // Python controls :15/:45 Arbor fetches; browser checks cached results.
  return Promise.all(['ace', 'atl', 'attendance_form', 'attendance_year'].map(fetchOne));
}

let rotationTimer = null;
const autoRotate = $('auto-rotate');
const rotationSpeed = $('rotation-speed');
const fullscreen = $('fullscreen');
autoRotate.checked = preferences.autoRotate !== false;
rotationSpeed.value = ['15', '30', '60'].includes(preferences.speed) ? preferences.speed : '30';

function savePreferences() {
  writeLocal('orme-display', {
    tab: preferences.tab,
    autoRotate: autoRotate.checked,
    speed: rotationSpeed.value
  });
}

function rotateTab() {
  const order = ['ace', 'atl', 'attendance'];
  state.active = order[(order.indexOf(state.active) + 1) % order.length];
  render();
}

function restartRotation() {
  clearInterval(rotationTimer);
  rotationTimer = null;
  if (autoRotate.checked) {
    rotationTimer = setInterval(rotateTab, Number(rotationSpeed.value) * 1000);
  }
}

for (const control of [autoRotate, rotationSpeed]) {
  control.addEventListener('change', () => {
    savePreferences();
    restartRotation();
  });
}

fullscreen.hidden = !document.fullscreenEnabled;
fullscreen.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (error) {
    fullscreen.title = 'Fullscreen unavailable: ' + error.message;
  }
});
document.addEventListener('fullscreenchange', () => {
  fullscreen.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
});

document.querySelectorAll('.tab').forEach(button => {
  button.addEventListener('click', () => {
    state.active = button.dataset.type;
    preferences.tab = state.active;
    savePreferences();
    render();
    restartRotation(); // Manual selection gets a full 30 seconds if enabled.
  });
});

new ResizeObserver(fitBoards).observe($('board-viewport'));
render();
refresh();
setInterval(refresh, REFRESH_MS);
restartRotation();
