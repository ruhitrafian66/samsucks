// Where selecting things goes. Kept in one place so screens don't import each other.
import * as router from './router.js';
import { DetailScreen } from './screens/detail.js';
import { LibraryScreen } from './screens/library.js';
import { PlayerScreen } from './screens/player.js';
import { SearchScreen } from './screens/search.js';
import { SettingsScreen } from './screens/settings.js';

export function openItem(item) {
  if (item.type === 'clip') { playItem(item); return; }
  router.push(DetailScreen(item));
}

export function playItem(item, opts) {
  if (item.type === 'show' || item.type === 'season') {
    // Play on a show means "the next episode"; the detail screen resolves it.
    router.push(DetailScreen(item, { autoplay: true }));
    return;
  }
  router.push(PlayerScreen(item, opts || {}));
}

export function openLibrary(section, opts) {
  router.push(LibraryScreen(section, opts));
}

export function openSearch() {
  router.push(SearchScreen());
}

export function openSettings() {
  router.push(SettingsScreen());
}
