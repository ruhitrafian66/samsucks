// Poster / landscape tiles. A tile node is created once and re-filled as it is
// recycled; fill() only touches the DOM for fields that changed.
import { h, setText, show, setTransform, toggleClass } from '../util/dom.js';
import { load } from './images.js';
import { session } from '../session.js';
import { progress, episodeLabel } from '../util/format.js';

// Frame sizes: what rows and grids lay their tiles out by.
export const KINDS = {
  poster: { w: 220, h: 330 },
  wide: { w: 400, h: 225 },
  grid: { w: 216, h: 324 },
  episode: { w: 384, h: 216 },
  person: { w: 200, h: 200 },
};

// The size requested from the server goes by the picture's shape, not by the frame: a poster
// is the same picture in a row (220 wide) and in the library grid (216 wide), and asking for
// both sizes makes the server convert it twice and the TV download and cache it twice.
const POSTER = { w: 220, h: 330 };
const STILL = { w: 400, h: 225 };
const REQUEST = { poster: POSTER, grid: POSTER, wide: STILL, episode: STILL, person: { w: 200, h: 200 } };

export function createTile(kind, { caption = false } = {}) {
  const size = KINDS[kind];
  const el = h('div', 'tile tile-' + kind);
  const frame = h('div', 'tile-frame', el);
  frame.style.width = size.w + 'px';
  frame.style.height = size.h + 'px';
  const img = h('img', 'tile-img', frame);
  const ph = h('div', 'tile-ph', frame);
  img.alt = '';
  const badge = h('div', 'tile-badge', frame);
  const bar = h('div', 'tile-bar', frame);
  const fill = h('i', '', bar);
  let cap = null;
  let sub = null;
  if (caption) {
    cap = h('div', 'tile-cap', el);
    cap.style.width = size.w + 'px';
    sub = h('div', 'tile-sub', el);
    sub.style.width = size.w + 'px';
  }
  return { el, img, ph, badge, bar, fill, cap, sub, kind, size, item: null };
}

function artFor(item, kind) {
  if (kind === 'wide' || kind === 'episode') {
    if (item.type === 'episode') return item.thumb || item.art;
    return item.art || item.thumb;
  }
  if (item.type === 'episode') return item.grandparentThumb || item.parentThumb || item.thumb;
  if (item.type === 'season') return item.thumb || item.parentThumb;
  return item.thumb;
}

// The URL a tile of this kind loads for an item. Anything that warms the image cache ahead
// of a tile must use it too, or it fetches a picture no tile will ask for.
export function tileImage(item, kind) {
  const server = session.server;
  if (!server) return '';
  const size = REQUEST[kind];
  return server.image(artFor(item, kind), size.w, size.h);
}

function titleFor(item, kind) {
  if (item.type === 'episode' && kind !== 'episode') return item.grandparentTitle || item.title;
  return item.title;
}

function subFor(item, kind) {
  if (item.type === 'episode') {
    return kind === 'episode' ? episodeLabel(item).replace(' · ', '') + '  ' + item.title
      : episodeLabel(item) + '  ' + item.title;
  }
  if (item.type === 'season') return item.leafCount ? item.leafCount + ' episodes' : '';
  if (item.type === 'person') return item.role || '';
  return item.year || '';
}

export function fillTile(tile, item) {
  if (tile.item === item) return;
  tile.item = item;
  if (!item) {
    load(tile.img, '');
    setText(tile.ph, '');
    show(tile.bar, false);
    show(tile.badge, false);
    if (tile.cap) { setText(tile.cap, ''); setText(tile.sub, ''); }
    return;
  }
  const kind = tile.kind;
  // The web layer is 1920x1080, so the picture is asked for at about the pixels it covers:
  // one size per shape (see REQUEST), which the <img> scales to its frame (object-fit: cover).
  load(tile.img, tileImage(item, kind));
  setText(tile.ph, titleFor(item, kind));

  const p = progress(item);
  show(tile.bar, p > 0.01);
  if (p > 0.01) setTransform(tile.fill, 'scaleX(' + p.toFixed(3) + ')');

  // Unwatched episode count on shows/seasons, check on watched items.
  let badge = '';
  if ((item.type === 'show' || item.type === 'season') && item.leafCount) {
    const left = item.leafCount - (item.viewedLeafCount || 0);
    badge = left > 0 ? String(left) : '✓';
  } else if (item.viewCount && !item.viewOffset && item.type !== 'show') {
    badge = '✓';
  }
  show(tile.badge, !!badge);
  setText(tile.badge, badge);
  toggleClass(tile.badge, 'done', badge === '✓');

  if (tile.cap) {
    setText(tile.cap, kind === 'episode' ? item.title : titleFor(item, kind));
    setText(tile.sub, kind === 'episode' ? episodeLabel(item) + (item.duration ? '  ·  ' + Math.round(item.duration / 60000) + 'm' : '') : subFor(item, kind));
  }
}
