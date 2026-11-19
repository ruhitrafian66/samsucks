// Video backend: Samsung AVPlay (hardware decode, plays straight to the video
// plane under the web layer) on the TV, <video> in a desktop browser.
//
// listener: { onTime(ms), onBuffering(bool), onEnd(), onError(msg), onSubtitle(text, durationMs) }

function avplayBackend(container, listener) {
  const av = webapis.avplay;
  const obj = document.createElement('object');
  obj.type = 'application/avplayer';
  obj.className = 'av-object';
  container.appendChild(obj);
  let opened = false;

  const api = {
    // startMs: where playback should begin. Returns whether AVPlay accepted it.
    open(url, { uhd = false, startMs = 0 } = {}) {
      api.close();
      av.open(url);
      opened = true;
      av.setDisplayRect(0, 0, 1920, 1080);
      av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
      if (uhd) {
        try { av.setStreamingProperty('SET_MODE_4K', 'TRUE'); } catch (e) { /* not a UHD panel */ }
      }
      av.setListener({
        onbufferingstart: () => listener.onBuffering(true),
        onbufferingprogress: () => {},
        onbufferingcomplete: () => listener.onBuffering(false),
        oncurrentplaytime: ms => listener.onTime(ms),
        onstreamcompleted: () => listener.onEnd(),
        onerror: e => listener.onError(String(e)),
        onevent: () => {},
        onsubtitlechange: (duration, text) => listener.onSubtitle(text, Number(duration)),
        ondrmevent: () => {},
      });
      // A seekTo() in IDLE sets AVPlay's start position, so prepare fills the buffer once,
      // there, instead of at 0:00 and again after a seek. It comes last: Samsung allows no
      // other call until a seekTo() is over, and its guide follows this one with prepare only.
      // No callbacks are passed, because in IDLE none may come.
      if (startMs > 0) {
        try { av.seekTo(Math.floor(startMs)); return true; } catch (e) { /* the caller seeks after prepare instead */ }
      }
      return false;
    },
    prepare() {
      return new Promise((resolve, reject) => av.prepareAsync(resolve, e => reject(new Error(String(e && e.name || e)))));
    },
    play() { av.play(); },
    pause() { av.pause(); },
    seek(ms) {
      return new Promise((resolve, reject) => av.seekTo(Math.max(0, Math.floor(ms)), resolve, e => reject(new Error(String(e && e.name || e)))));
    },
    time() {
      try { return av.getCurrentTime(); } catch (e) { return 0; }
    },
    state() {
      try { return av.getState(); } catch (e) { return 'NONE'; }
    },
    // AVPlay can't list its tracks in every state (after prepareAsync, not before it is
    // playing), so `ready` says whether this is the real list or just nothing yet.
    tracks() {
      let info = [];
      try { info = av.getTotalTrackInfo() || []; } catch (e) {}
      return {
        ready: info.length > 0,
        audio: info.filter(t => t.type === 'AUDIO').map(t => t.index),
        text: info.filter(t => t.type === 'TEXT').map(t => t.index),
      };
    },
    // Index of the audio track playing now, or null when AVPlay won't say.
    currentAudio() {
      try {
        const cur = (av.getCurrentStreamInfo() || []).filter(s => s.type === 'AUDIO')[0];
        return cur && cur.index >= 0 ? cur.index : null;
      } catch (e) { return null; }
    },
    // Only works while playing: in READY, AVPlay switches tracks for Smooth Streaming only.
    selectAudio(avIndex) {
      try { av.setSelectTrack('AUDIO', avIndex); return true; } catch (e) { return false; }
    },
    selectText(avIndex) {
      try {
        if (avIndex == null) { av.setSilentSubtitle(true); return true; }
        av.setSelectTrack('TEXT', avIndex);
        av.setSilentSubtitle(false);
        return true;
      } catch (e) { return false; }
    },
    suspend() { try { av.suspend(); } catch (e) {} },
    restore() { try { av.restore(); } catch (e) {} },
    close() {
      if (!opened) return;
      opened = false;
      try { av.stop(); } catch (e) {}
      try { av.close(); } catch (e) {}
    },
    destroy() {
      api.close();
      if (obj.parentNode) obj.parentNode.removeChild(obj);
    },
  };
  return api;
}

function videoBackend(container, listener) {
  const v = document.createElement('video');
  v.className = 'av-object';
  container.appendChild(v);
  v.addEventListener('timeupdate', () => listener.onTime(v.currentTime * 1000));
  v.addEventListener('waiting', () => listener.onBuffering(true));
  v.addEventListener('playing', () => listener.onBuffering(false));
  v.addEventListener('ended', () => listener.onEnd());
  v.addEventListener('error', () => listener.onError('video error ' + (v.error && v.error.code)));
  return {
    open(url) { v.src = url; return false; },   // no start position here: the caller seeks after prepare
    prepare() {
      return new Promise((resolve, reject) => {
        v.addEventListener('loadedmetadata', resolve, { once: true });
        v.addEventListener('error', () => reject(new Error('load failed')), { once: true });
        v.load();
      });
    },
    play() { v.play(); },
    pause() { v.pause(); },
    seek(ms) { v.currentTime = ms / 1000; return Promise.resolve(); },
    time() { return v.currentTime * 1000; },
    state() { return v.paused ? 'PAUSED' : 'PLAYING'; },
    tracks() { return { ready: true, audio: [], text: [] }; },
    currentAudio() { return null; },
    selectAudio() { return false; },
    selectText(avIndex) { return avIndex == null; },   // nothing to silence; no tracks to pick
    suspend() {},
    restore() {},
    close() { v.removeAttribute('src'); v.load(); },
    destroy() { v.removeAttribute('src'); if (v.parentNode) v.parentNode.removeChild(v); },
  };
}

export function createPlayer(container, listener) {
  if (typeof webapis !== 'undefined' && webapis.avplay) return avplayBackend(container, listener);
  return videoBackend(container, listener);
}
