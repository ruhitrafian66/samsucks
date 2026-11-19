// A whole library as a virtualized poster grid, loaded page by page.
// Yellow cycles the sort; red toggles unwatched-only; CH▲/CH▼ jump by letter
// (title sort) or by page. `filters` narrows it, e.g. { actor: id } for a cast member.
import { h, setText } from '../util/dom.js';
import { Grid } from '../ui/grid.js';
import { useAmbience } from '../ui/backdrop.js';
import { session } from '../session.js';
import { prefetch } from '../ui/images.js';
import { tileImage } from '../ui/tile.js';
import { isFast } from '../input.js';
import { openItem, playItem } from '../nav.js';
import { error } from '../util/log.js';
import { metaLine } from '../util/format.js';

const PAGE = 140;
const SORTS = [
  { id: 'titleSort', label: 'A–Z' },
  { id: 'addedAt:desc', label: 'Recently added' },
  { id: 'originallyAvailableAt:desc', label: 'Release date' },
  { id: 'audienceRating:desc', label: 'Rating' },
];

export function LibraryScreen(section, { filters = null } = {}) {
  const el = h('div', 'screen library');
  const ambience = useAmbience();
  const head = h('header', 'lib-head', el);
  h('h1', 'lib-title', head).textContent = section.title;
  const count = h('div', 'lib-count', head);
  const sortEl = h('div', 'lib-sort', head);
  const focusInfo = h('div', 'lib-focus', el);
  const hint = h('div', 'lib-hint', el);
  hint.innerHTML = '<i class="key-red"></i> Unwatched &nbsp;&nbsp; <i class="key-yellow"></i> Sort &nbsp;&nbsp; CH ▲▼ Jump';

  let sortIndex = 0;
  let unwatchedOnly = false;
  let pages = new Map();     // page -> 'loading' | true
  let items = [];
  let letters = [];          // [{ title: 'A', start: 0 }]
  let generation = 0;

  const type = section.type === 'show' ? 2 : 1;
  const noun = section.type === 'show' ? 'show' : 'movie';

  function activeFilters() {
    const f = Object.assign({}, filters);
    if (unwatchedOnly) f[type === 2 ? 'unwatchedLeaves' : 'unwatched'] = 1;
    return f;
  }

  // Declared before it is built: Grid renders once inside its constructor, and that render
  // calls onNeed while `grid` is still unset.
  let grid = null;
  grid = new Grid({
    top: 200, height: 880, total: 0,
    getItem: i => items[i],
    onFocus: (item, index) => {
      // Warm posters for the row just past the recycled pool, with the URL its tiles will ask for.
      if (!isFast()) {
        const start = (Math.floor(index / grid.cols) + grid.poolRows - 1) * grid.cols;
        for (let i = start; i < start + grid.cols; i++) {
          if (items[i]) prefetch(tileImage(items[i], 'grid'));
        }
      }
      if (!item) { setText(focusInfo, ''); return; }
      setText(focusInfo, item.title + '   ' + metaLine(item));
      ambience.set(item.UltraBlurColors);
    },
    onSelect: item => openItem(item),
    onNeed: (start, end) => {
      if (!grid) return; // the constructor's render: reload() below asks for the first page
      for (let p = Math.floor(start / PAGE); p <= Math.floor(end / PAGE); p++) loadPage(p);
    },
  });
  el.appendChild(grid.el);

  async function loadPage(p) {
    if (pages.has(p)) return;
    if (grid.total && p * PAGE >= grid.total) return;
    pages.set(p, 'loading');
    const gen = generation;
    try {
      const res = await session.server.items(section.key, p * PAGE, PAGE, { sort: SORTS[sortIndex].id, type, filters: activeFilters() });
      if (gen !== generation) return;
      res.items.forEach((it, i) => { items[p * PAGE + i] = it; });
      pages.set(p, true);
      setText(count, res.total + (unwatchedOnly ? ' unwatched ' : ' ') + noun + (res.total === 1 ? '' : 's'));
      if (grid.total !== res.total) grid.setTotal(res.total);
      else grid.refresh();
      if (p === 0 && res.items[0]) grid.onFocus(grid.current());
    } catch (e) {
      pages.delete(p);
      error('library page failed', section.title, p, e);
    }
  }

  async function loadLetters() {
    letters = [];
    if (SORTS[sortIndex].id !== 'titleSort') return;
    try {
      const mc = await session.server.get('/library/sections/' + section.key + '/firstCharacter', Object.assign({ type }, activeFilters()));
      let start = 0;
      letters = (mc.Directory || []).map(d => {
        const l = { title: d.title, start };
        start += d.size;
        return l;
      });
    } catch (e) { /* letter jump just won't work */ }
  }

  function reload() {
    generation++;
    pages = new Map();
    items = [];
    setText(sortEl, (unwatchedOnly ? 'Unwatched  ·  ' : '') + 'Sorted by ' + SORTS[sortIndex].label);
    setText(count, '');
    setText(focusInfo, '');
    grid.total = 0;
    grid.index = 0;
    grid.refresh();
    loadPage(0);
    loadLetters();
  }
  reload();

  function jump(dir) {
    if (letters.length) {
      const i = grid.index;
      let li = letters.findIndex((l, k) => i >= l.start && (k === letters.length - 1 || i < letters[k + 1].start));
      li = Math.max(0, Math.min(letters.length - 1, li + dir));
      grid.focusIndex(letters[li].start);
      setText(focusInfo, letters[li].title);
    } else {
      grid.focusIndex(grid.index + dir * grid.cols * 3);
    }
  }

  return {
    el,
    name: 'library',
    onShow() { ambience.restore(); },
    onKey(action) {
      switch (action) {
        case 'left': grid.move(-1, 0); return true;
        case 'right': grid.move(1, 0); return true;
        case 'up': grid.move(0, -1); return true;
        case 'down': grid.move(0, 1); return true;
        case 'pageup': jump(-1); return true;
        case 'pagedown': jump(1); return true;
        case 'enter': grid.select(); return true;
        case 'play': case 'playpause': if (grid.current()) playItem(grid.current()); return true;
        case 'red': unwatchedOnly = !unwatchedOnly; reload(); return true;
        case 'yellow': sortIndex = (sortIndex + 1) % SORTS.length; reload(); return true;
        case 'back':
          if (grid.index > grid.cols * 2) { grid.focusIndex(0); return true; }
          return false;
      }
      return false;
    },
  };
}
