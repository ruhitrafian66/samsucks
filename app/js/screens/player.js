// Playback. Direct play whenever the TV can decode the file (hardware, zero
// server load); otherwise ask Plex for HLS with the video passed through and
// only the audio/container converted. Seeking previews locally and only
// commits once the user stops pressing, because AVPlay seeks are slow.
import { DEV } from '../config.js';
import { h, setText, setTransform, toggleClass } from '../util/dom.js';
import { createPlayer } from '../platform/player.js';
import { setScreenSaver, supports4K } from '../platform/tizen.js';
import { session } from '../session.js';
import { clock, episodeLabel, uuid } from '../util/format.js';
import * as icons from '../ui/icons.js';
import * as router from '../router.js';
import { log, warn, error } from '../util/log.js';
import { request } from '../plex/client.js';
import { parseSubtitles, CueTrack } from '../player/subtitles.js';
import { subtitleLanguage, stepSubtitleLanguage } from '../util/languages.js';
import * as store from '../util/store.js';

// What a 2022 Samsung (Tizen 6.5) decodes natively. No DTS on 2018+ models.
const DIRECT = {
  container: { mp4: 1, m4v: 1, mov: 1, mkv: 1, webm: 1, ts: 1, mpegts: 1, avi: 1 },
  video: { h264: 1, hevc: 1, vp9: 1, av1: 1, mpeg4: 1, mpeg2video: 1, vc1: 1 },
  audio: { aac: 1, ac3: 1, eac3: 1, mp3: 1, mp2: 1, flac: 1, opus: 1, vorbis: 1, pcm: 1 },
};
const TEXT_SUBS = { srt: 1, subrip: 1, ass: 1, ssa: 1, mov_text: 1, vtt: 1, webvtt: 1, smi: 1 };

const OSD_HIDE_MS = 4000;
const CONTROLS_HIDE_MS = 8000; // longer while a control button has focus
const JUMP_BACK_MS = 10000;
const JUMP_FWD_MS = 10000;
const UPNEXT_SECONDS = 10;
// The button row under the seek bar, left to right.
const CONTROLS = ['prev', 'back', 'play', 'fwd', 'next', 'tracks', 'settings'];
const SEEK_COMMIT_MS = 900;
const TIMELINE_MS = 10000;
const TRACK_TRIES = 20;       // time ticks to keep offering AVPlay the audio/subtitle choice
const START_SLACK_MS = 5000;  // AVPlay starts on a keyframe near the position asked for, not on it
const START_WAIT_MS = 10000;  // a prepare with a start position gets this long, then one try without it
const SKIP_SHOW_MS = 10000;   // how long "Skip Intro" stays up on its own
const TRACK_ROWS = 10;        // options a panel column shows at once; ten end above the subtitles, drawn over the panel
const SEARCH_ROWS = 8;        // subtitle search results visible at once
const MARKER_LABEL = { intro: 'Skip Intro', credits: 'Skip Credits', commercial: 'Skip Ad' };

const SUB_SIZES = [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['xlarge', 'Extra large']];
const DELAY_STEP_MS = 500;
const FILE_OPTS_KEPT = 100;

// Per-file playback choices (how to play it, subtitle timing), remembered by ratingKey.
function loadFileOpts(key) {
  return Object.assign({ mode: 'auto', delay: 0 }, store.get('fileOpts', {})[key]);
}

function saveFileOpts(key, opts) {
  if (!key) return;
  const all = store.get('fileOpts', {});
  if (opts.mode === 'auto' && !opts.delay) delete all[key];
  else all[key] = { mode: opts.mode, delay: opts.delay, t: Date.now() };
  // Keep only the most recently changed files so this never grows without bound.
  const keys = Object.keys(all);
  if (keys.length > FILE_OPTS_KEPT) {
    keys.sort((a, b) => all[a].t - all[b].t).slice(0, keys.length - FILE_OPTS_KEPT).forEach(k => { delete all[k]; });
  }
  store.set('fileOpts', all);
}

function subSizeIndex() {
  const i = SUB_SIZES.findIndex(z => z[0] === store.get('subSize', 'medium'));
  return i < 0 ? 1 : i;
}

function delayLabel(ms) {
  return (ms > 0 ? '+' : ms < 0 ? '−' : '') + (Math.abs(ms) / 1000).toFixed(1) + 's';
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The promise's own outcome, or a rejection when it takes longer than ms.
function within(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer in ' + ms / 1000 + ' s')), ms);
    promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

function streamsOf(part, type) {
  return (part && part.Stream || []).filter(s => s.streamType === type);
}

function isEmbeddedText(sub) {
  return !!sub && sub.index != null && !sub.key && !!TEXT_SUBS[sub.codec];
}

// External .srt/.ass/.vtt files: we fetch and draw these ourselves.
function isSidecarText(sub) {
  return !!sub && !!sub.key && !!TEXT_SUBS[sub.codec];
}

// An external text file matching an embedded text subtitle (same language, same SDH/forced
// flags), e.g. one extracted next to the MKV. Plex can't hand embedded subs out on their own,
// so over HLS the only other way to show them is burning in, which re-encodes the video.
function sidecarTwin(part, sub) {
  const same = s => isSidecarText(s) && s.languageCode === sub.languageCode && !!s.forced === !!sub.forced;
  const candidates = streamsOf(part, 3).filter(same);
  return candidates.find(s => !!s.hearingImpaired === !!sub.hearingImpaired) || candidates[0] || null;
}

function subtitleLabel(s) {
  const title = s.displayTitle && s.displayTitle !== 'Unknown' ? s.displayTitle : (s.language || '');
  const kind = (s.codec || '').toUpperCase() + (s.key ? ' · external' : '');
  // Downloaded subtitles all read "English"; the release name tells them apart.
  if (title && s.key && s.providerTitle && s.title) return title + ' · ' + s.title;
  return title ? title + (s.key ? ' · external' : '') : kind || 'Subtitle';
}

// Release-name words: "Feed.2026.1080p.WEB.H264-GRP.mkv" -> feed, 2026, 1080p, web, h264, grp.
function releaseTokens(name) {
  return String(name || '').toLowerCase()
    .replace(/\.(mkv|mp4|m4v|avi|mov|ts|webm|srt|ass|ssa|vtt|sub)$/, '')
    .replace(/\b([hx])[ .]?(26[45])\b/g, 'h$2')   // x264, H.264, h 264 are the same thing
    .split(/[^a-z0-9]+/).filter(Boolean);
}

// How strictly a search result matches the file being played, strictest first:
// 3 = the provider matched the file itself, 2 = same release name, then the share of
// release-name words in common (0..1). Subtitles timed for another release drift.
function matchStrictness(result, fileTokens) {
  if (result.perfectMatch) return 3;
  const sub = releaseTokens(result.title);
  if (!sub.length || !fileTokens.length) return 0;
  const inFile = {};
  fileTokens.forEach(t => { inFile[t] = 1; });
  const seen = {};
  let common = 0;
  let unique = 0;
  sub.forEach(t => { if (!seen[t]) { seen[t] = 1; unique++; if (inFile[t]) common++; } });
  const fileUnique = Object.keys(inFile).length;
  if (common === unique && common === fileUnique) return 2;
  return common / (unique + fileUnique - common);
}

function cleanSubtitle(text) {
  return String(text || '')
    .replace(/\{\\[^}]*\}/g, '')        // ASS override tags
    .replace(/<[^>]+>/g, '')            // <i>, <font> ...
    .replace(/\\N/g, '\n');
}

export function PlayerScreen(initial, { offset = null } = {}) {
  const el = h('div', 'screen player');
  const stage = h('div', 'player-stage', el);
  const subs = h('div', 'subs', el);
  const spinner = h('div', 'spinner', el);

  const osd = h('div', 'osd', el);
  const osdTop = h('div', 'osd-top', osd);
  const osdTitle = h('div', 'osd-title', osdTop);
  const osdSub = h('div', 'osd-sub', osdTop);
  const osdBottom = h('div', 'osd-bottom', osd);
  const bar = h('div', 'osd-bar', osdBottom);
  const barFill = h('div', 'osd-fill', bar);
  const knob = h('div', 'osd-knob', bar);
  const seekLabel = h('div', 'osd-seek', knob);
  const times = h('div', 'osd-times', osdBottom);
  const tNow = h('span', 'osd-now', times);
  const tInfo = h('span', 'osd-info', times);
  const tLeft = h('span', 'osd-left', times);
  const hintEl = h('div', 'osd-hint', osdBottom);
  const controls = h('div', 'osd-controls', osdBottom);
  const transport = h('div', 'osd-transport', controls);
  const extras = h('div', 'osd-extras', controls);
  const btn = {};
  [['prev', icons.previous], ['back', icons.back10], ['play', icons.pause], ['fwd', icons.forward10], ['next', icons.next],
    ['tracks', icons.subtitles], ['settings', icons.gear]].forEach(([id, icon], i) => {
    btn[id] = h('div', 'osd-btn osd-btn-' + id, i < 5 ? transport : extras);
    btn[id].innerHTML = icon;
  });

  const panel = h('div', 'tracks hidden', el);
  const skipEl = h('div', 'skip hidden', el);
  const upnext = h('div', 'upnext hidden', el);
  const errorEl = h('div', 'player-error hidden', el);

  let item = initial;
  let media = null;
  let part = null;
  let mode = 'direct';
  let triedFallback = false;
  let base = 0;             // HLS restarts at an offset; AVPlay time is relative to it
  let position = offset || 0;
  let duration = initial.duration || 0;
  let paused = false;
  let started = false;
  let alive = true;
  let audioStream = null;
  let subStream = null;
  let seekTarget = null;
  let seekCount = 0;
  let lastSeekAt = 0;
  let seekTimer = 0;
  let osdTimer = 0;
  let timelineTimer = 0;
  let subTimer = 0;
  let lastText = 0;
  let upnextTimer = 0;
  let upnextFocus = 0;      // 0 = Play now, 1 = Cancel
  let nextItem = null;
  let prevItem = null;
  let neighbours = null;    // promise: resolves once prevItem/nextItem are known
  let ended = false;
  let ctrl = -1;            // focused control button (index into CONTROLS); -1 = the seek bar
  let cueTrack = null;
  let cueTimer = 0;
  let cueFor = null;
  let markers = [];
  let marker = null;        // the intro/credits marker playback is inside, if any
  let markerAt = 0;
  let trackTries = 0;       // > 0 while the audio/subtitle choice still has to reach AVPlay
  let audioSet = false;
  let textSet = false;
  let opening = 0;          // counts open() calls, so one that was overtaken can tell
  const fileOpts = loadFileOpts(initial.ratingKey);
  el.classList.add('subs-' + SUB_SIZES[subSizeIndex()][0]);
  const playSession = uuid();

  const player = createPlayer(stage, {
    onTime(ms) {
      if (!started) return;
      position = base + ms;
      // Nobody sees the bar while the controls are hidden; showOsd() draws it when they appear.
      if (seekTarget == null && el.classList.contains('osd-on')) renderProgress(position);
      checkMarker();
      if (trackTries) tryTracks();
    },
    onBuffering(on) { toggleClass(spinner, 'on', on); },
    onEnd() { finished(); },
    onError(msg) { failed(msg); },
    onSubtitle(text, ms) {
      clearTimeout(subTimer);
      setText(subs, cleanSubtitle(text));
      if (ms > 0) subTimer = setTimeout(() => setText(subs, ''), ms);
    },
  });

  // --- OSD --------------------------------------------------------------

  // textNow: also write the clock text now, instead of at most once in 900 ms.
  function renderProgress(ms, textNow) {
    const p = duration ? Math.max(0, Math.min(1, ms / duration)) : 0;
    setTransform(barFill, 'scaleX(' + p.toFixed(4) + ')');
    setTransform(knob, 'translateX(' + Math.round(p * 1728) + 'px)');
    const now = Date.now();
    if (textNow || now - lastText > 900) {
      lastText = now;
      setText(tNow, clock(ms));
      setText(tLeft, '−' + clock(duration - ms));
      const ends = new Date(now + (duration - ms));
      let hh = ends.getHours();
      const ampm = hh >= 12 ? 'PM' : 'AM';
      hh = hh % 12 || 12;
      const mm = ends.getMinutes();
      setText(tInfo, 'Ends at ' + hh + ':' + (mm < 10 ? '0' : '') + mm + ' ' + ampm);
    }
  }

  // Time ticks draw the bar only while it is visible, so every way of showing the OSD comes
  // through here and draws it first: the position, or the seek preview while there is one.
  function showOsd(sticky) {
    toggleClass(el, 'osd-on', true);
    clearTimeout(osdTimer);
    if (!sticky && !paused) osdTimer = setTimeout(hideOsd, ctrl >= 0 ? CONTROLS_HIDE_MS : OSD_HIDE_MS);
    renderProgress(seekTarget == null ? position : seekTarget, true);
    renderControls();
    renderSkip();
  }

  function hideOsd() {
    clearTimeout(osdTimer);
    toggleClass(el, 'osd-on', false);
    ctrl = -1;
    renderControls();
    renderSkip();
  }

  // --- Control buttons --------------------------------------------------

  function controlEnabled(id) {
    if (id === 'prev') return !!prevItem;
    if (id === 'next') return !!nextItem;
    if (id === 'tracks' || id === 'settings') return !!part;
    return started;
  }

  function controlHint(id) {
    const ep = e => episodeLabel(e) + '   ' + e.title;
    switch (id) {
      case 'prev': return 'Previous episode' + (prevItem ? '  ·  ' + ep(prevItem) : '');
      case 'next': return 'Next episode' + (nextItem ? '  ·  ' + ep(nextItem) : '');
      case 'back': return 'Back 10 seconds';
      case 'fwd': return 'Forward 10 seconds';
      case 'play': return paused ? 'Play' : 'Pause';
      case 'tracks': return 'Audio & subtitles';
      case 'settings': return 'Playback settings';
    }
    return '';
  }

  function renderControls() {
    const episode = item.type === 'episode';
    if (ctrl >= 0 && !controlEnabled(CONTROLS[ctrl])) ctrl = CONTROLS.indexOf('play');
    CONTROLS.forEach((id, i) => {
      toggleClass(btn[id], 'focus', i === ctrl);
      toggleClass(btn[id], 'disabled', !controlEnabled(id));
    });
    // Films have no neighbours: leave the two buttons out rather than permanently greyed.
    toggleClass(btn.prev, 'hidden', !episode);
    toggleClass(btn.next, 'hidden', !episode);
    const icon = paused ? icons.play : icons.pause;
    if (btn.play._icon !== icon) { btn.play._icon = icon; btn.play.innerHTML = icon; }
    toggleClass(el, 'bar-focus', ctrl < 0);
    setText(hintEl, ctrl >= 0 ? controlHint(CONTROLS[ctrl]) : '▼ Controls');
  }

  function moveControl(dir) {
    for (let i = ctrl + dir; i >= 0 && i < CONTROLS.length; i += dir) {
      const id = CONTROLS[i];
      if (controlEnabled(id) && !btn[id].classList.contains('hidden')) { ctrl = i; break; }
    }
    showOsd();
  }

  function activateControl(id) {
    if (!controlEnabled(id)) return;
    switch (id) {
      case 'prev': jumpTo(prevItem); break;
      case 'next': jumpTo(nextItem); break;
      case 'back': seekTo(-JUMP_BACK_MS); break;
      case 'fwd': seekTo(JUMP_FWD_MS); break;
      case 'play': if (seekTarget != null) commitSeek(); else togglePause(); break;
      case 'tracks': openPanel(0); break;
      case 'settings': openPanel(2); break;
    }
  }

  // Leave this episode for another one; teardown reports where this one stopped.
  function jumpTo(target) {
    if (!target) return;
    clearInterval(upnextTimer);
    router.replace(PlayerScreen(target, { offset: 0 }));
  }

  // --- Skip intro / credits ---------------------------------------------

  // The button shows for a few seconds when a marker starts, and again whenever the
  // controls are up inside it. While it shows, OK skips.
  function skipVisible() {
    return !!marker && !paused && seekTarget == null && ctrl < 0 && panel.classList.contains('hidden') &&
      (Date.now() - markerAt < SKIP_SHOW_MS || el.classList.contains('osd-on'));
  }

  function renderSkip() {
    const on = skipVisible();
    toggleClass(skipEl, 'hidden', !on);
    if (on) setText(skipEl, MARKER_LABEL[marker.type] || 'Skip');
  }

  function checkMarker() {
    let now = null;
    for (const m of markers) {
      if (position >= m.startTimeOffset && position < m.endTimeOffset - 1000) { now = m; break; }
    }
    if (now !== marker) {
      marker = now;
      markerAt = Date.now();
    }
    if (marker || !skipEl.classList.contains('hidden')) renderSkip();
  }

  function skipMarker() {
    const m = marker;
    marker = null;
    renderSkip();
    // Credits that run to the end of the file: go straight to what's next.
    if (m.type === 'credits' && (m.final || m.endTimeOffset >= duration - 5000)) { finished(); return; }
    seekTarget = Math.min(duration - 3000, m.endTimeOffset);
    commitSeek();
  }

  function renderTitles() {
    if (item.type === 'episode') {
      setText(osdTitle, item.grandparentTitle);
      setText(osdSub, episodeLabel(item) + '   ' + item.title);
    } else {
      setText(osdTitle, item.title);
      setText(osdSub, item.year || '');
    }
  }

  // --- Timeline ---------------------------------------------------------

  function report(state) {
    if (!item.ratingKey) return;
    if (DEV && window.__ss && window.__ss.muteTimeline) return;
    session.server.timeline({
      ratingKey: item.ratingKey,
      key: '/library/metadata/' + item.ratingKey,
      state,
      time: Math.floor(position),
      duration: Math.floor(duration),
      'X-Plex-Session-Identifier': playSession,
    });
  }

  function startTimeline() {
    clearInterval(timelineTimer);
    timelineTimer = setInterval(() => report(paused ? 'paused' : 'playing'), TIMELINE_MS);
  }

  // --- Opening ----------------------------------------------------------

  // What we'd do left to ourselves; the per-file "Playback" setting can override it.
  function decideMode() {
    if (fileOpts.mode === 'direct' || fileOpts.mode === 'hls') return fileOpts.mode;
    return autoMode();
  }

  function autoMode() {
    const directOk = DIRECT.container[media.container] && DIRECT.video[media.videoCodec] &&
      (!audioStream || DIRECT.audio[audioStream.codec]);
    const subsOk = !subStream || isEmbeddedText(subStream) || isSidecarText(subStream);
    return directOk && subsOk ? 'direct' : 'hls';
  }

  // useStart: let AVPlay begin at atMs by itself (direct play only); open() clears it to retry.
  async function open(atMs, useStart = true) {
    const server = session.server;
    const t0 = Date.now();
    const turn = ++opening;
    started = false;
    trackTries = 0;
    toggleClass(spinner, 'on', true);
    errorEl.classList.add('hidden');
    let url;
    if (mode === 'direct') {
      base = 0;
      url = server.url(part.key);
    } else {
      base = atMs;
      if (isEmbeddedText(subStream)) {
        const twin = sidecarTwin(part, subStream);
        if (twin) {
          log('using external twin of embedded subtitle:', twin.displayTitle);
          subStream = twin;
        }
      }
      // Burn in only what we can't draw ourselves (image subs, embedded text).
      const burn = subStream && !isSidecarText(subStream);
      const build = (withSubs) => server.transcodeUrl(item, {
        session: playSession, offsetMs: atMs,
        audioStreamID: audioStream && audioStream.id,
        subtitleStreamID: withSubs ? subStream.id : undefined,
      });
      // PMS 1.42+ rejects start.m3u8 unless a decision was made for the session first.
      const decide = async () => (await request(url.replace('/start.m3u8', '/decision'))).MediaContainer || {};
      url = build(burn);
      let mc = await decide();
      // Burning subtitles means re-encoding the video. A server that can only remux refuses
      // that, so play without the subtitle rather than not at all.
      if (burn && mc.generalDecisionCode >= 2000) {
        warn('server cannot burn in subtitles, playing without them:', mc.transcodeDecisionText);
        url = build(false);
        mc = await decide();
      }
      if (mc.generalDecisionCode && mc.generalDecisionCode >= 2000) throw new Error(mc.generalDecisionText || 'Server refused to convert this file');
    }
    log('play', mode, item.title, media.container + '/' + media.videoCodec + '/' + (audioStream && audioStream.codec), 'at', clock(atMs));
    // A resumed direct play hands AVPlay the position before prepare, so it fills its buffer
    // once, there, rather than at 0:00 during prepare and a second time after a seek.
    const startSet = player.open(url, {
      uhd: media.videoResolution === '4k' && supports4K(),
      startMs: useStart && mode === 'direct' ? atMs : 0,
    });
    try {
      // The start position is new to this TV, so a prepare that it stalls is not waited on for ever.
      await (startSet ? within(player.prepare(), START_WAIT_MS) : player.prepare());
    } catch (e) {
      // With a start position set, that is the first suspect: once more without it, before
      // failed() gives up on direct play for a file that the seek after prepare can resume.
      if (!startSet || !alive || turn !== opening) throw e;
      warn('prepare failed with a start position (' + e.message + '), opening again without it');
      return open(atMs, false);
    }
    if (!alive) return;
    if (mode === 'direct') {
      // AVPlay's own subtitles can be silenced before the first frame; track choices can't.
      if (!isEmbeddedText(subStream)) player.selectText(null);
      if (atMs > 0) {
        // Where AVPlay stands now says whether it took the start position. A TV that ignored
        // it is still at 0 and gets the seek it always got.
        const at = player.time();
        if (at > 0 && Math.abs(at - atMs) <= START_SLACK_MS) {
          log('start position taken by AVPlay: at ' + clock(at) + ' after prepare, no seek');
        } else {
          log('seek after prepare: ' + (startSet ? 'AVPlay is at ' + clock(at) + ' despite the start position'
            : useStart ? 'the start position was not accepted' : 'prepare failed with a start position'));
          await player.seek(atMs);
        }
      }
    }
    syncSidecar();
    player.play();
    paused = false;
    started = true;
    position = atMs;
    toggleClass(el, 'paused', false);
    toggleClass(spinner, 'on', false);
    log('playing after ' + (Date.now() - t0) + 'ms (' + mode + ')');
    report('playing');
    startTimeline();
    renderControls();
    // Only now: a direct-played file takes a track choice once it is playing, not before.
    if (mode === 'direct') queueTracks();
  }

  // Hand Plex's chosen audio and subtitle streams to AVPlay. For a direct-played file AVPlay
  // switches tracks only while it is playing (in READY that is Smooth Streaming only), and
  // after prepareAsync it won't even list them before then. So this is asked once playback
  // runs, and asked again on the next time ticks for as long as AVPlay turns it down.
  function queueTracks() {
    trackTries = TRACK_TRIES;
    audioSet = false;
    textSet = false;
    if (!isEmbeddedText(subStream)) setText(subs, '');   // drop whatever AVPlay last drew
    tryTracks();
  }

  function tryTracks() {
    if (!trackTries || !started || mode !== 'direct') return;
    if (applyTracks()) { trackTries = 0; return; }
    if (paused) return;   // audio can't be switched while paused; this runs again on resume
    if (--trackTries === 0) warn('AVPlay did not take the audio/subtitle choice');
  }

  // Map Plex's chosen streams onto AVPlay's track list (same file order).
  // False while AVPlay has no track list yet or refused a switch.
  function applyTracks() {
    const t = player.tracks();
    // Turning AVPlay's own subtitles off needs no track list, so it never waits for one.
    if (!textSet && !isEmbeddedText(subStream)) textSet = applyText(t);
    if (!t.ready) return false;
    if (!audioSet) audioSet = applyAudio(t);
    if (!textSet) textSet = applyText(t);
    return audioSet && textSet;
  }

  function applyAudio(t) {
    if (!audioStream || t.audio.length < 2) return true;
    const pos = streamsOf(part, 2).indexOf(audioStream);
    const want = pos < 0 ? null : t.audio[pos];
    if (want == null) return true;        // AVPlay doesn't list this one: nothing to pick
    const now = player.currentAudio();
    if (now === want) return true;        // already the track that is playing
    if (!player.selectAudio(want)) return false;
    log('audio track ' + (pos + 1) + ' of ' + t.audio.length + ' selected (AVPlay index ' + now + ' -> ' + want + ')');
    return true;
  }

  function applyText(t) {
    if (isEmbeddedText(subStream)) {
      const pos = streamsOf(part, 3).filter(isEmbeddedText).indexOf(subStream);
      return pos < 0 || t.text[pos] == null || player.selectText(t.text[pos]);
    }
    // Off, or a file we draw ourselves: keep AVPlay's own subtitles quiet.
    return player.selectText(null);
  }

  // Start/stop drawing an external subtitle file for the current selection.
  function syncSidecar() {
    if (!isSidecarText(subStream)) {
      cueTrack = null;
      cueFor = null;
      clearInterval(cueTimer);
      if (!isEmbeddedText(subStream)) setText(subs, '');
      return;
    }
    if (cueFor === subStream) return;
    cueFor = subStream;
    const stream = subStream;
    cueTrack = null;
    fetch(session.server.url(stream.key, { encoding: 'utf-8' }))
      .then(r => r.text())
      .then(text => {
        if (cueFor !== stream || !alive) return;
        cueTrack = new CueTrack(parseSubtitles(text, stream.codec));
        log('subtitles loaded', stream.displayTitle, cueTrack.cues.length + ' cues');
        drawCue();   // a file picked during a pause shows on the paused picture
      })
      .catch(e => warn('subtitle fetch failed', e.message));
    clearInterval(cueTimer);
    // Idle during a pause: the picture stands still, and asking AVPlay the time is a native call.
    cueTimer = setInterval(() => { if (!paused) drawCue(); }, 120);
  }

  // Show what the external subtitle file says at this moment. The timer does this while
  // playing; anything that changes the answer during a pause has to call it itself.
  function drawCue() {
    if (cueTrack && started) setText(subs, cueTrack.at(base + player.time() - fileOpts.delay));
  }

  async function start() {
    try {
      const full = await session.server.metadata(item.ratingKey);
      if (!alive) return;
      item = full;
      duration = item.duration || duration;
      media = (item.Media || [])[0];
      part = media && media.Part && media.Part[0];
      if (!part) throw new Error('No playable media');
      const audios = streamsOf(part, 2);
      audioStream = audios.find(s => s.selected) || audios[0] || null;
      subStream = streamsOf(part, 3).find(s => s.selected) || null;
      markers = (item.Marker || []).filter(m => MARKER_LABEL[m.type] && m.endTimeOffset > m.startTimeOffset);
      renderTitles();
      if (item.type === 'episode') neighbours = loadNeighbours();
      mode = decideMode();
      if (offset == null) offset = item.viewOffset || 0;
      position = offset;
      showOsd();
      await open(offset);
    } catch (e) {
      failed(e.message || String(e));
    }
  }

  function failed(msg) {
    if (!alive) return;
    if (mode === 'direct' && !triedFallback && media && fileOpts.mode !== 'direct') {
      // The file looked direct-playable but the TV choked: let Plex convert it.
      warn('direct play failed (' + msg + '), falling back to HLS');
      triedFallback = true;
      mode = 'hls';
      open(position).catch(e => failed(e.message));
      return;
    }
    error('playback failed', msg);
    toggleClass(spinner, 'on', false);
    errorEl.classList.remove('hidden');
    setText(errorEl, 'Playback failed: ' + msg + (fileOpts.mode === 'auto' ? ''
      : '\n' + (fileOpts.mode === 'direct' ? 'Direct play' : 'Convert') + ' is forced for this file. Press ▼ twice and choose Auto under Playback.'));
  }

  // --- Controls ---------------------------------------------------------

  function togglePause() {
    if (!started) return;
    if (paused) {
      player.play();
      paused = false;
      showOsd();
    } else {
      player.pause();
      paused = true;
      drawCue();   // the subtitle of the picture it stopped on; the timer rests from here
      showOsd(true);
    }
    toggleClass(el, 'paused', paused);
    renderControls();
    report(paused ? 'paused' : 'playing');
  }

  // Left/right on the seek bar: steps grow while the key is held.
  function seekBy(dir) {
    const now = Date.now();
    seekCount = now - lastSeekAt < 700 ? seekCount + 1 : 0;
    lastSeekAt = now;
    const step = seekCount < 3 ? 10000 : seekCount < 8 ? 30000 : seekCount < 16 ? 60000 : 180000;
    seekTo(dir * step);
  }

  function seekTo(delta) {
    if (!started) return;
    const from = seekTarget == null ? position : seekTarget;
    seekTarget = Math.max(0, Math.min(duration - 3000, from + delta));
    toggleClass(el, 'seeking', true);
    setText(seekLabel, clock(seekTarget));
    showOsd(true);   // draws the bar at the target
    clearTimeout(seekTimer);
    seekTimer = setTimeout(commitSeek, SEEK_COMMIT_MS);
  }

  async function commitSeek() {
    clearTimeout(seekTimer);
    if (seekTarget == null) return;
    const target = seekTarget;
    seekTarget = null;
    position = target;   // before showOsd(), which draws the bar from it
    toggleClass(el, 'seeking', false);
    showOsd();
    try {
      if (mode === 'direct') {
        toggleClass(spinner, 'on', true);
        await player.seek(target);
        toggleClass(spinner, 'on', false);
        if (paused) togglePause();
      } else {
        await open(target);
      }
    } catch (e) {
      warn('seek failed, reopening', e.message);
      open(target).catch(err => failed(err.message));
    }
  }

  // --- Audio / subtitle picker ------------------------------------------

  let panelCol = 0;
  let panelIndex = [0, 0, 0];
  let panelTop = [0, 0, 0];   // first option each column shows; a long list slides under the focus
  let panelLists = [[], [], []];
  let panelMode = 'tracks';   // 'tracks' | 'search'
  let panelDom = null;        // the panel's nodes as last built (see renderPanel)
  // Online subtitle search: results come from the server's subtitle agent.
  const search = { results: [], index: 0, status: '', busy: false, generation: 0 };

  function openPanel(col) {
    const audios = streamsOf(part, 2);
    const texts = streamsOf(part, 3);
    panelLists = [
      audios.map(s => ({ label: s.displayTitle || s.language || 'Track', stream: s, on: s === audioStream })),
      [{ label: 'Off', stream: null, on: !subStream }]
        .concat(texts.map(s => ({ label: subtitleLabel(s), stream: s, on: s === subStream })))
        .concat(item.ratingKey ? [{ label: 'Search online…', search: true }] : []),
      playbackOptions(),
    ];
    panelIndex = panelLists.map(l => Math.max(0, l.findIndex(x => x.on)));
    // A long list opens with the current choice mid-window (renderTracks keeps this in range).
    panelTop = panelIndex.map(i => i - Math.floor(TRACK_ROWS / 2));
    panelCol = col || 0;
    panelMode = 'tracks';
    renderPanel();
    panel.classList.remove('hidden');
    hideOsd();
  }

  // Third column: settings for this file only, plus subtitle size (all files).
  function playbackOptions() {
    const auto = autoMode() === 'direct' ? 'direct play' : 'convert';
    return [
      { label: 'Auto (' + auto + ')', playMode: 'auto', on: fileOpts.mode === 'auto' },
      { label: 'Force direct play', playMode: 'direct', on: fileOpts.mode === 'direct' },
      { label: 'Force convert', playMode: 'hls', on: fileOpts.mode === 'hls' },
      { label: 'Subtitles later  +0.5s', delayBy: DELAY_STEP_MS },
      { label: 'Subtitles earlier  −0.5s', delayBy: -DELAY_STEP_MS },
      { label: 'Subtitle delay  ' + delayLabel(fileOpts.delay) + (fileOpts.delay ? '  ·  reset' : ''), delayBy: 0 },
      { label: 'Subtitle size  ' + SUB_SIZES[subSizeIndex()][1], size: true },
    ];
  }

  function setPlayMode(m) {
    closePanel();
    if (fileOpts.mode === m && errorEl.classList.contains('hidden')) return;
    fileOpts.mode = m;
    saveFileOpts(item.ratingKey, fileOpts);
    const wanted = decideMode();
    if (wanted === mode && errorEl.classList.contains('hidden')) return;
    if (mode === 'hls') session.server.stopTranscode(playSession);
    log('playback mode for this file:', m, '->', wanted);
    mode = wanted;
    triedFallback = false;
    open(position).catch(e => failed(e.message));
  }

  // These keep the panel open so they can be pressed repeatedly.
  function choosePlayback(opt) {
    if (opt.playMode) { setPlayMode(opt.playMode); return; }
    if (opt.delayBy != null) {
      fileOpts.delay = opt.delayBy ? Math.max(-60000, Math.min(60000, fileOpts.delay + opt.delayBy)) : 0;
      saveFileOpts(item.ratingKey, fileOpts);
      drawCue();   // at once, also in a pause, so the new timing can be judged against the picture
    } else if (opt.size) {
      const next = SUB_SIZES[(subSizeIndex() + 1) % SUB_SIZES.length][0];
      SUB_SIZES.forEach(z => toggleClass(el, 'subs-' + z[0], z[0] === next));
      store.set('subSize', next);
    }
    panelLists[2] = playbackOptions();
    renderPanel();
  }

  function closePanel() {
    panel.classList.add('hidden');
    search.generation++;   // drop any search still in flight
    search.busy = false;
  }

  // The panel's nodes are built for a mode and a number of rows per column, then kept. A key
  // press that only moves the focus flips two classes; when a column's window slides or a
  // label changes, the same rows get new text. (setText and toggleClass skip what is unchanged.)
  function renderPanel() {
    const built = panelDom && panelDom.mode === panelMode && (panelMode === 'search' ||
      panelDom.cols.every((col, c) => col.rows.length === Math.min(panelLists[c].length, TRACK_ROWS)));
    if (!built) buildPanel();
    if (panelMode === 'search') renderSearch(); else renderTracks();
  }

  function buildPanel() {
    panel.innerHTML = '';
    toggleClass(panel, 'searching', panelMode === 'search');
    const column = (icon, name) => {
      const col = h('div', 'tracks-col', panel);
      const head = h('div', 'tracks-head', col);
      head.innerHTML = icon;
      h('span', '', head).textContent = name;
      return col;
    };
    if (panelMode === 'search') {
      const col = column(icons.search, 'Search subtitles');
      panelDom = { mode: 'search', lang: h('div', 'tracks-lang', col), status: h('div', 'tracks-status', col), rows: [] };
      for (let k = 0; k < SEARCH_ROWS; k++) {
        const row = h('div', 'tracks-opt tracks-result', col);
        panelDom.rows.push({ row, title: h('div', 'tracks-result-title', row), meta: h('div', 'tracks-result-meta', row) });
      }
      panelDom.foot = h('div', 'tracks-foot', col);
      return;
    }
    const cols = [[icons.audio, 'Audio'], [icons.subtitles, 'Subtitles'], [icons.gear, 'Playback']].map(([icon, name], c) => {
      const col = column(icon, name);
      // At most TRACK_ROWS rows: a longer list slides through them, and a marker above and
      // one below say how much of it lies beyond.
      const up = h('div', 'tracks-more tracks-more-up', col);
      const rows = panelLists[c].slice(0, TRACK_ROWS).map(() => h('div', 'tracks-opt', col));
      return { up, rows, down: h('div', 'tracks-more tracks-more-down', col) };
    });
    panelDom = { mode: 'tracks', cols };
  }

  function renderTracks() {
    panelDom.cols.forEach((col, c) => {
      const list = panelLists[c];
      const i = panelIndex[c];
      // Slide the window only as far as it takes to hold the focused option.
      let top = Math.min(panelTop[c], i);
      if (i >= top + TRACK_ROWS) top = i - TRACK_ROWS + 1;
      top = panelTop[c] = Math.max(0, Math.min(list.length - col.rows.length, top));
      col.rows.forEach((row, k) => {
        const opt = list[top + k];
        setText(row, opt.label);
        toggleClass(row, 'on', opt.on);
        toggleClass(row, 'focus', c === panelCol && top + k === i);
      });
      renderMore(col.up, top);
      renderMore(col.down, list.length - top - col.rows.length);
    });
  }

  // How many options lie beyond one end of a column's window; invisible when none do.
  function renderMore(more, n) {
    toggleClass(more, 'on', n > 0);
    if (n > 0) setText(more, n + ' more');
  }

  function renderSearch() {
    const n = search.results.length;
    setText(panelDom.lang, '◀  ' + subtitleLanguage()[1] + '  ▶');
    setText(panelDom.status, search.status);
    const top = Math.max(0, Math.min(n - SEARCH_ROWS, search.index - Math.floor(SEARCH_ROWS / 2)));
    panelDom.rows.forEach((slot, k) => {
      const r = search.results[top + k];
      toggleClass(slot.row, 'hidden', !r);
      toggleClass(slot.row, 'focus', !!r && !search.busy && top + k === search.index);
      if (!r) return;
      setText(slot.title, r.title || r.extendedDisplayTitle || r.displayTitle || 'Subtitle');
      const bits = [r.providerTitle, (r.codec || '').toUpperCase()];
      if (r.downloaded) bits.push('Downloaded');
      if (r.strictness >= 3) bits.push('Matches this file');
      else if (r.strictness >= 2) bits.push('Same release');
      if (r.hearingImpaired) bits.push('SDH');
      if (r.forced) bits.push('Forced');
      setText(slot.meta, bits.filter(Boolean).join('  ·  '));
    });
    setText(panelDom.foot, n
      ? (search.index + 1) + ' of ' + n + '   ·   OK to download   ·   ◀ ▶ language'
      : '◀ ▶ language   ·   Back to return');
  }

  async function runSearch() {
    const server = session.server;
    const gen = ++search.generation;
    const lang = subtitleLanguage();
    search.results = [];
    search.index = 0;
    search.busy = false;
    search.status = 'Searching for ' + lang[1] + ' subtitles…';
    renderPanel();
    try {
      const found = await server.searchSubtitles(item.ratingKey, { language: lang[0] });
      if (gen !== search.generation || !alive) return;
      // Only text formats: we draw these ourselves, so the video is never re-encoded.
      // Strictest match to this file first; the provider's score only breaks ties.
      const fileTokens = releaseTokens(String(part.file || '').split(/[\\/]/).pop());
      search.results = found.filter(r => r.key && (!r.codec || TEXT_SUBS[r.codec]));
      search.results.forEach(r => { r.strictness = matchStrictness(r, fileTokens); });
      search.results.sort((a, b) => b.strictness - a.strictness || (b.score || 0) - (a.score || 0));
      search.status = search.results.length ? '' : 'No ' + lang[1] + ' subtitles found.';
    } catch (e) {
      if (gen !== search.generation || !alive) return;
      warn('subtitle search failed', e.message);
      search.status = e.status === 401 || e.status === 403
        ? 'This account isn\'t allowed to search for subtitles on this server.'
        : 'Search failed (' + (e.message || e) + ').';
    }
    if (panelMode === 'search' && !panel.classList.contains('hidden')) renderPanel();
  }

  // The server downloads in the background; wait for the new stream to appear on the part.
  async function downloadResult(result) {
    const server = session.server;
    const gen = ++search.generation;
    const stale = () => gen !== search.generation || !alive;
    // A result the server already has is just another track: switch to it.
    // (Search results carry their own ids; sourceKey is what ties one to a stream on the part.)
    const same = s => !!s.key && (s.key === result.key || (!!result.sourceKey && s.sourceKey === result.sourceKey));
    const have = streamsOf(part, 3).find(same);
    if (have) { choose(1, { stream: have }); return; }
    const known = {};
    streamsOf(part, 3).forEach(s => { known[s.id] = 1; });
    search.busy = true;
    search.status = 'Downloading…';
    renderPanel();
    try {
      await server.downloadSubtitle(item.ratingKey, result, subtitleLanguage()[0]);
      let fresh = null;
      for (let i = 0; i < 12 && !fresh; i++) {
        await sleep(i < 4 ? 1000 : 2000);
        if (stale()) return;
        const full = await server.metadata(item.ratingKey).catch(() => null);
        if (stale()) return;
        const parts = full && full.Media ? full.Media.reduce((all, m) => all.concat(m.Part || []), []) : [];
        const newPart = parts.find(p => p.id === part.id);
        fresh = newPart && (streamsOf(newPart, 3).find(same) || streamsOf(newPart, 3).find(s => !known[s.id]));
        if (fresh) {
          // Adopt the refreshed stream list, keeping the current audio choice.
          part.Stream = newPart.Stream;
          if (audioStream) audioStream = streamsOf(part, 2).find(s => s.id === audioStream.id) || audioStream;
        }
      }
      if (!fresh) throw new Error('the server never added the subtitle');
      log('subtitle downloaded:', fresh.displayTitle || fresh.title);
      search.busy = false;
      await choose(1, { stream: fresh });
    } catch (e) {
      if (stale()) return;
      warn('subtitle download failed', e.message);
      search.busy = false;
      search.status = 'Download failed (' + (e.message || e) + ').';
      if (panelMode === 'search' && !panel.classList.contains('hidden')) renderPanel();
    }
  }

  async function choose(col, opt) {
    const server = session.server;
    if (col === 0) audioStream = opt.stream;
    else subStream = opt.stream;
    const saved = server.selectStreams(part.id, {
      audioStreamID: audioStream ? audioStream.id : undefined,
      subtitleStreamID: subStream ? subStream.id : 0,
    });
    closePanel();
    const wanted = decideMode();
    if (wanted === 'direct' && mode === 'direct') {
      queueTracks();
      syncSidecar();
    } else if (mode === 'hls' && wanted === 'hls' && col === 1 && isSidecarText(subStream)) {
      syncSidecar();
    } else {
      mode = wanted;
      triedFallback = false;
      // A converted stream carries whichever audio the server has saved for this file,
      // so the new choice has to be saved before the stream is requested again.
      if (wanted === 'hls') await saved;
      if (!alive) return;
      await open(position).catch(e => failed(e.message));
    }
  }

  function searchKey(action) {
    if (action === 'back') {
      search.generation++;
      search.busy = false;
      panelMode = 'tracks';
      renderPanel();
      return true;
    }
    if (search.busy) return true;
    if (action === 'left' || action === 'right') {
      stepSubtitleLanguage(action === 'right' ? 1 : -1);
      runSearch();
      return true;
    }
    const n = search.results.length;
    if (action === 'up') search.index = Math.max(0, search.index - 1);
    if (action === 'down') search.index = Math.min(Math.max(0, n - 1), search.index + 1);
    if (action === 'enter') {
      if (n) downloadResult(search.results[search.index]);
      else runSearch();
      return true;
    }
    renderPanel();
    return true;
  }

  function panelKey(action) {
    if (panelMode === 'search') return searchKey(action);
    if (action === 'back' || action === 'up' && panelIndex[panelCol] === 0) { closePanel(); return true; }
    if (action === 'left') panelCol = Math.max(0, panelCol - 1);
    if (action === 'right') panelCol = Math.min(panelLists.length - 1, panelCol + 1);
    if (action === 'up') panelIndex[panelCol]--;
    if (action === 'down') panelIndex[panelCol] = Math.min(panelLists[panelCol].length - 1, panelIndex[panelCol] + 1);
    if (action === 'enter') {
      const opt = panelLists[panelCol][panelIndex[panelCol]];
      if (opt && opt.search) {
        panelMode = 'search';
        runSearch();
      } else if (opt && panelCol === 2) {
        choosePlayback(opt);
      } else if (opt) {
        choose(panelCol, opt);
      }
      return true;
    }
    renderPanel();
    return true;
  }

  // --- Ending -----------------------------------------------------------

  // The episodes either side of this one, crossing season boundaries.
  async function loadNeighbours() {
    const server = session.server;
    const playing = item;
    let prev = null;
    let next = null;
    // A season's list is large and every episode start wants it: an answer up to five minutes old will do.
    const reuse = { maxAge: 300000 };
    try {
      const eps = await server.children(playing.parentRatingKey, reuse);
      const i = eps.findIndex(e => e.ratingKey === playing.ratingKey);
      if (i > 0) prev = eps[i - 1];
      if (i >= 0 && i < eps.length - 1) next = eps[i + 1];
      if (!prev || !next) {
        const seasons = (await server.children(playing.grandparentRatingKey, reuse)).filter(s => s.type === 'season');
        const si = seasons.findIndex(s => s.ratingKey === playing.parentRatingKey);
        if (!next && si >= 0 && si < seasons.length - 1) next = (await server.children(seasons[si + 1].ratingKey, reuse))[0] || null;
        if (!prev && si > 0) prev = (await server.children(seasons[si - 1].ratingKey, reuse)).pop() || null;
      }
    } catch (e) {
      warn('could not load neighbouring episodes', e.message);
    }
    if (!alive) return;
    prevItem = prev;
    nextItem = next;
    renderControls();
  }

  async function finished() {
    if (ended) return;
    ended = true;
    position = duration;
    report('stopped');
    clearInterval(timelineTimer);
    player.close();
    started = false;
    closePanel();
    hideOsd();
    setText(subs, '');
    toggleClass(spinner, 'on', false);
    if (item.type !== 'episode') { exit(); return; }
    await neighbours;
    if (!alive) return;
    if (!nextItem) { exit(); return; }
    showUpNext();
  }

  // Post-play screen: what's next, with a countdown when autoplay is on.
  function showUpNext() {
    const server = session.server;
    const auto = store.get('autoplayNext', true);
    let left = UPNEXT_SECONDS;
    upnext.innerHTML = '';
    const art = nextItem.art || nextItem.grandparentArt || item.art || item.grandparentArt;
    if (art) h('img', 'upnext-art', upnext).src = server.image(art, 960, 540);
    h('div', 'upnext-shade', upnext);
    const card = h('div', 'upnext-card', upnext);
    const thumb = h('div', 'upnext-thumb', card);
    if (nextItem.thumb) h('img', '', thumb).src = server.image(nextItem.thumb, 560, 315);
    const fill = h('div', 'upnext-fill', h('div', 'upnext-bar', thumb));
    const body = h('div', 'upnext-body', card);
    const label = h('div', 'upnext-label', body);
    h('div', 'upnext-show', body).textContent = nextItem.grandparentTitle || item.grandparentTitle || '';
    h('div', 'upnext-title', body).textContent = episodeLabel(nextItem) + '   ' + nextItem.title;
    h('div', 'upnext-summary', body).textContent = nextItem.summary || '';
    const buttons = h('div', 'upnext-buttons', body);
    const playBtn = h('div', 'upnext-btn', buttons);
    playBtn.innerHTML = icons.play;
    h('span', '', playBtn).textContent = 'Play now';
    const cancelBtn = h('div', 'upnext-btn', buttons);
    cancelBtn.textContent = 'Cancel';
    upnextFocus = 0;
    upnext._render = () => {
      setText(label, upnextTimer ? 'Up next in ' + left : 'Up next');
      toggleClass(playBtn, 'focus', upnextFocus === 0);
      toggleClass(cancelBtn, 'focus', upnextFocus === 1);
      toggleClass(thumb, 'counting', !!upnextTimer);
    };
    upnext.classList.remove('hidden');
    if (auto) {
      upnextTimer = setInterval(() => {
        left--;
        if (left <= 0) { playNext(); return; }
        setTransform(fill, 'scaleX(' + (1 - (left - 1) / UPNEXT_SECONDS).toFixed(3) + ')');
        upnext._render();
      }, 1000);
      // Next frame, so the first second animates too.
      setTimeout(() => setTransform(fill, 'scaleX(' + (1 / UPNEXT_SECONDS).toFixed(3) + ')'), 50);
    }
    upnext._render();
  }

  function upnextKey(action) {
    if (action === 'back' || action === 'stop') { exit(); return; }
    if (action === 'play' || action === 'playpause' || action === 'next' || action === 'pageup') { playNext(); return; }
    if (action === 'enter') {
      if (upnextFocus === 0) playNext(); else exit();
      return;
    }
    if (action === 'left' || action === 'right') {
      // Moving off "Play now" means the viewer is deciding: stop counting down.
      upnextFocus = action === 'right' ? 1 : 0;
      clearInterval(upnextTimer);
      upnextTimer = 0;
      upnext._render();
    }
  }

  function playNext() {
    jumpTo(nextItem);
  }

  function exit() {
    router.back();
  }

  function teardown() {
    if (!alive) return;
    alive = false;
    if (started && position < duration) report('stopped');
    [seekTimer, osdTimer, subTimer].forEach(clearTimeout);
    clearInterval(timelineTimer);
    clearInterval(upnextTimer);
    clearInterval(cueTimer);
    player.destroy();
    if (mode === 'hls') session.server.stopTranscode(playSession);
    document.documentElement.classList.remove('playing');
    setScreenSaver(true);
    document.removeEventListener('visibilitychange', onVisibility);
  }

  function onVisibility() {
    if (document.hidden) {
      if (started && !paused) togglePause();
      player.suspend();
    } else {
      player.restore();
    }
  }

  return {
    el,
    name: 'player',
    onShow() {
      document.documentElement.classList.add('playing');
      setScreenSaver(false);
      document.addEventListener('visibilitychange', onVisibility);
      renderTitles();
      if (!started) start();
    },
    onKey(action) {
      if (ended) {
        if (!upnext.classList.contains('hidden')) upnextKey(action);
        else if (action === 'back' || action === 'stop') exit();
        return true;
      }
      if (!panel.classList.contains('hidden')) return panelKey(action);
      const osdOn = el.classList.contains('osd-on');
      const onButtons = osdOn && ctrl >= 0;
      switch (action) {
        case 'enter':
          if (onButtons) activateControl(CONTROLS[ctrl]);
          else if (seekTarget != null) commitSeek();
          else if (skipVisible()) skipMarker();
          else if (osdOn || paused) togglePause();
          else showOsd();
          return true;
        case 'playpause': if (seekTarget != null) commitSeek(); else togglePause(); return true;
        case 'play': if (paused) togglePause(); return true;
        case 'pause': if (!paused) togglePause(); return true;
        case 'left': if (onButtons) moveControl(-1); else seekBy(-1); return true;
        case 'right': if (onButtons) moveControl(1); else seekBy(1); return true;
        case 'rw': seekBy(-1); return true;
        case 'ff': seekBy(1); return true;
        case 'up': ctrl = -1; showOsd(); return true;
        case 'info': showOsd(); return true;
        case 'down':
          // First press shows the controls with the button row focused; from there, the track panel.
          if (onButtons) { if (part) openPanel(0); return true; }
          ctrl = CONTROLS.indexOf('play');
          showOsd();
          return true;
        case 'next': case 'pageup': jumpTo(nextItem); return true;
        case 'prev': case 'pagedown': jumpTo(prevItem); return true;
        case 'stop': exit(); return true;
        case 'back':
          if (seekTarget != null) { seekTarget = null; clearTimeout(seekTimer); toggleClass(el, 'seeking', false); showOsd(); return true; }
          if (onButtons && paused) { ctrl = -1; showOsd(true); return true; }
          if (osdOn && !paused) { hideOsd(); return true; }
          exit();
          return true;
      }
      return true;
    },
    onHide() {},
    destroy: teardown,
  };
}
