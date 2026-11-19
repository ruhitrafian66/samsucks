// Image loading tuned for a slow TV CPU:
//  - a few downloads at a time, newest draw first (what's on screen now
//    matters more than what scrolled past); inside one draw they start in the
//    order they were asked for, so rows and grids ask for the focused tile first,
//  - requests for nodes that were recycled before loading are dropped,
//  - decode() runs off the main thread before the image is attached, so
//    attaching never stalls a frame.
const MAX_ACTIVE = 6;
const LOADED_MAX = 800;

// The next job to start is the last one. From the front: prefetches, then the
// jobs of each draw, oldest draw first, each draw's jobs last-asked first.
const queue = [];
let active = 0;
let draw = 0;         // number of the draw that load() calls belong to right now
let drawing = false;  // true from a draw's first load() until its pass has ended
const loaded = new Map(); // url -> true, in insertion order for LRU trimming

// A draw is every load() made in one synchronous pass: a row or a grid rendering,
// or a whole screen being built. The microtask runs once that pass has ended.
function currentDraw() {
  if (!drawing) {
    drawing = true;
    draw++;
    Promise.resolve().then(() => { drawing = false; });
  }
  return draw;
}

function remember(url) {
  loaded.delete(url);
  loaded.set(url, true);
  if (loaded.size > LOADED_MAX) loaded.delete(loaded.keys().next().value);
}

function attach(img, url, instant) {
  img.src = url;
  if (instant) {
    img.classList.add('in', 'now');
  } else {
    img.classList.remove('now');
    img.classList.add('in');
  }
}

function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const job = queue.pop();
    if (job.img._want !== job.url) continue;
    active++;
    const loader = new Image();
    loader.src = job.url;
    const done = ok => {
      active--;
      if (ok) {
        remember(job.url);
        if (job.img._want === job.url) attach(job.img, job.url, false);
      }
      pump();
    };
    if (loader.decode) loader.decode().then(() => done(true), () => done(false));
    else { loader.onload = () => done(true); loader.onerror = () => done(false); }
  }
}

// Point an <img> at a URL. Empty url clears it.
export function load(img, url) {
  if (img._want === url) return;
  img._want = url;
  if (!url) {
    img.classList.remove('in');
    img.removeAttribute('src');
    return;
  }
  if (loaded.has(url)) {
    attach(img, url, true);
    return;
  }
  img.classList.remove('in');
  const job = { img, url, draw: currentDraw() };
  // Behind what this draw has already asked for, ahead of every older draw.
  let at = queue.length;
  while (at > 0 && queue[at - 1].draw === job.draw) at--;
  queue.splice(at, 0, job);
  if (queue.length > 200) queue.splice(0, queue.length - 200);
  pump();
}

// Warm the cache without a target element (e.g. the next page of a grid).
export function prefetch(url) {
  if (!url || loaded.has(url)) return;
  const sink = { _want: url, classList: { add() {}, remove() {} } };
  queue.unshift({ img: sink, url });
  pump();
}
