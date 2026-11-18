// Languages offered for online subtitle search (ISO 639-1 code, name).
import * as store from './store.js';

export const LANGUAGES = [
  ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
  ['pt', 'Portuguese'], ['nl', 'Dutch'], ['sv', 'Swedish'], ['no', 'Norwegian'], ['da', 'Danish'],
  ['fi', 'Finnish'], ['pl', 'Polish'], ['ru', 'Russian'], ['tr', 'Turkish'], ['ar', 'Arabic'],
  ['hi', 'Hindi'], ['bn', 'Bengali'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'],
];

export function languageIndex(code) {
  const i = LANGUAGES.findIndex(l => l[0] === code);
  return i < 0 ? 0 : i;
}

export function subtitleLanguage() {
  return LANGUAGES[languageIndex(store.get('subSearchLang', 'en'))];
}

// Step the saved search language by dir (±1), wrapping; returns the new [code, name].
export function stepSubtitleLanguage(dir) {
  const n = LANGUAGES.length;
  const next = LANGUAGES[(languageIndex(store.get('subSearchLang', 'en')) + dir + n) % n];
  store.set('subSearchLang', next[0]);
  return next;
}
