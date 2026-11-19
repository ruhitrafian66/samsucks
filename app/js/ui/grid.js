// Vertical, virtualized poster grid for whole libraries.
// Each row is its own compositor layer, so scrolling only re-rasterizes the one
// row that gets recycled with new posters. The track moves by transform; the
// focus ring moves horizontally on its own layer.
import { h, setTransform } from '../util/dom.js';
import { createTile, fillTile, KINDS } from './tile.js';

export class Grid {
  constructor({ cols = 7, kind = 'grid', gapX = 41, gapY = 28, captionH = 70, top = 0, height = 1080, getItem, total = 0, onFocus, onSelect, onNeed }) {
    this.cols = cols;
    this.size = KINDS[kind];
    this.stepX = this.size.w + gapX;
    this.stepY = this.size.h + captionH + gapY;
    this.getItem = getItem;
    this.total = total;
    this.onFocus = onFocus;
    this.onSelect = onSelect;
    this.onNeed = onNeed;
    this.index = 0;
    this.scrollRow = 0;

    this.el = h('div', 'grid');
    this.el.style.top = top + 'px';
    this.el.style.height = height + 'px';
    this.track = h('div', 'grid-track', this.el);
    this.ring = h('div', 'ring on', this.track);
    this.ring.style.width = (this.size.w + 16) + 'px';
    this.ring.style.height = (this.size.h + 16) + 'px';

    this.visibleRows = Math.ceil(height / this.stepY) + 1;
    this.poolRows = this.visibleRows + 2;
    this.rows = [];
    for (let r = 0; r < this.poolRows; r++) {
      const rowEl = h('div', 'grid-row', this.track);
      const tiles = [];
      for (let c = 0; c < cols; c++) {
        const tile = createTile(kind, { caption: true });
        setTransform(tile.el, 'translateX(' + c * this.stepX + 'px)');
        rowEl.appendChild(tile.el);
        tiles.push(tile);
      }
      this.rows.push({ el: rowEl, tiles, row: -1 });
    }
    this.render();
  }

  get rowCount() {
    return Math.ceil(this.total / this.cols);
  }

  setTotal(total) {
    this.total = total;
    this.refresh();
  }

  current() {
    return this.getItem(this.index);
  }

  // Data for some rows arrived: re-fill whatever is on screen.
  refresh() {
    for (const r of this.rows) r.row = -1;
    this.render();
  }

  move(dx, dy) {
    const col = this.index % this.cols;
    let next = this.index;
    if (dx) {
      if (col + dx < 0 || col + dx >= this.cols) return false;
      next += dx;
    }
    if (dy) next += dy * this.cols;
    if (next < 0) return false;
    if (next >= this.total) {
      // Moving down into a short last row lands on its last item.
      if (dy > 0 && Math.floor(next / this.cols) < this.rowCount) next = this.total - 1;
      else return false;
    }
    if (next === this.index) return false;
    this.focusIndex(next);
    return true;
  }

  focusIndex(i) {
    this.index = Math.max(0, Math.min(this.total - 1, i));
    this.render();
    if (this.onFocus) this.onFocus(this.current(), this.index);
  }

  select() {
    const item = this.current();
    if (item && this.onSelect) this.onSelect(item, this.index);
  }

  // Put grid row r in its pool slot, unless it is there already.
  placeRow(r) {
    const slot = this.rows[r % this.poolRows];
    if (slot.row === r) return;
    slot.row = r;
    slot.el.style.visibility = '';
    setTransform(slot.el, 'translateY(' + r * this.stepY + 'px)');
    for (let c = 0; c < this.cols; c++) {
      const i = r * this.cols + c;
      const tile = slot.tiles[c];
      if (i < this.total) {
        tile.el.style.visibility = '';
        fillTile(tile, this.getItem(i) || null);
      } else {
        tile.el.style.visibility = 'hidden';
      }
    }
  }

  render() {
    const focusRow = Math.floor(this.index / this.cols);
    // Keep the focused row second from the top (first row at the very top).
    this.scrollRow = Math.max(0, focusRow - 1);
    const firstRow = Math.max(0, this.scrollRow - 1);
    const lastRow = Math.min(this.rowCount, firstRow + this.poolRows);

    // Images download in the order the tiles are filled (see images.js): the focused
    // row, then the rows below it, then the rows above.
    const from = Math.min(focusRow, lastRow);
    for (let r = from; r < lastRow; r++) this.placeRow(r);
    for (let r = from - 1; r >= firstRow; r--) this.placeRow(r);
    for (const slot of this.rows) {
      if (slot.row < firstRow || slot.row >= lastRow) {
        slot.row = -1;
        slot.el.style.visibility = 'hidden';
      }
    }
    if (this.onNeed) this.onNeed(firstRow * this.cols, lastRow * this.cols + this.cols * 4);

    setTransform(this.track, 'translateY(' + (-this.scrollRow * this.stepY) + 'px)');
    const col = this.index % this.cols;
    setTransform(this.ring, 'translate(' + (col * this.stepX - 8) + 'px,' + (focusRow * this.stepY - 8) + 'px)');
  }
}
