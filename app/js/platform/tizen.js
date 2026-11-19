// Thin wrapper over the Tizen / Samsung web APIs, with desktop-browser fallbacks
// so the UI can also be developed in Chrome.
import { warn } from '../util/log.js';

export const isTizen = typeof window.tizen !== 'undefined';

// keyCode → action. Desktop keys mirror the remote for development in a browser.
const KEYMAP = {
  37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'enter',
  10009: 'back', 8: 'back', 27: 'back',
  10252: 'playpause', 32: 'playpause', 415: 'play', 19: 'pause', 413: 'stop',
  417: 'ff', 412: 'rw', 427: 'pageup', 428: 'pagedown', 33: 'pageup', 34: 'pagedown',
  10232: 'prev', 10233: 'next',
  403: 'red', 404: 'green', 405: 'yellow', 406: 'blue', 457: 'info', 10073: 'info',
};

export function actionFor(e) {
  return KEYMAP[e.keyCode] || null;
}

export function registerKeys() {
  if (!isTizen) return;
  const keys = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward',
    'MediaRewind', 'ChannelUp', 'ChannelDown', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow',
    'ColorF3Blue', 'Info', 'MediaTrackPrevious', 'MediaTrackNext'];
  for (const k of keys) {
    try { tizen.tvinputdevice.registerKey(k); } catch (e) { warn('registerKey failed', k); }
  }
}

export function exitApp() {
  try { tizen.application.getCurrentApplication().exit(); } catch (e) { window.close(); }
}

export function deviceInfo() {
  let model = 'Browser';
  let name = 'SamSUCKS';
  try { model = webapis.productinfo.getRealModel() || webapis.productinfo.getModel(); } catch (e) {}
  try { name = 'Samsung ' + (webapis.productinfo.getModel() || 'TV'); } catch (e) {}
  // PMS has a built-in "Tizen" profile (the official app) that rejects our
  // transcode requests with 400; "Samsung" gets the generic profile plus our
  // own X-Plex-Client-Profile-Extra.
  return { model, name, platform: isTizen ? 'Samsung' : 'Web' };
}

export function supports4K() {
  try { return webapis.productinfo.isUdPanelSupported(); } catch (e) { return false; }
}

// Keep the screen saver from kicking in during playback.
export function setScreenSaver(on) {
  try {
    webapis.appcommon.setScreenSaver(on ? webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_ON
      : webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF);
  } catch (e) {}
}
