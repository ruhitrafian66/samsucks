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
const SEEK_COMMIT_MS = 900;
const TIMELINE_MS = 10000;
const SKIP_SHOW_MS = 10000;   // how long "Skip Intro" stays up on its own
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
  const pauseBig = h('div', 'pause-big', el);
  pauseBig.innerHTML = icons.pause;

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
  hintEl.innerHTML = '▼ Audio, subtitles &amp; playback';

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
  let nextItem = null;
  let cueTrack = null;
  let cueTimer = 0;
  let cueFor = null;
  let markers = [];
  let marker = null;        // the intro/credits marker playback is inside, if any
  let markerAt = 0;
  const fileOpts = loadFileOpts(initial.ratingKey);
  el.classList.add('subs-' + SUB_SIZES[subSizeIndex()][0]);
  const playSession = uuid();

  const player = createPlayer(stage, {
    onTime(ms) {
      if (!started) return;
      position = base + ms;
      if (seekTarget == null) renderProgress(position);
      checkMarker();
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

  function renderProgress(ms) {
    const p = duration ? Math.max(0, Math.min(1, ms / duration)) : 0;
    setTransform(barFill, 'scaleX(' + p.toFixed(4) + ')');
    setTransform(knob, 'translateX(' + Math.round(p * 1728) + 'px)');
    const now = Date.now();
    if (now - lastText > 900 || seekTarget != null) {
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

  function showOsd(sticky) {
    toggleClass(el, 'osd-on', true);
    clearTimeout(osdTimer);
    if (!sticky && !paused) osdTimer = setTimeout(hideOsd, OSD_HIDE_MS);
    renderSkip();
  }

  function hideOsd() {
    clearTimeout(osdTimer);
    toggleClass(el, 'osd-on', false);
    renderSkip();
  }

  // --- Skip intro / credits ---------------------------------------------

  // The button shows for a few seconds when a marker starts, and again whenever the
  // controls are up inside it. While it shows, OK skips.
  function skipVisible() {
    return !!marker && !paused && seekTarget == null && panel.classList.contains('hidden') &&
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

  async function open(atMs) {
    const server = session.server;
    const t0 = Date.now();
    started = false;
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
    player.open(url, { uhd: media.videoResolution === '4k' && supports4K() });
    await player.prepare();
    if (!alive) return;
    if (mode === 'direct') {
      applyTracks();
      if (atMs > 0) await player.seek(atMs);
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
  }

  // Map Plex's chosen streams onto AVPlay's track list (same file order).
  function applyTracks() {
    const t = player.tracks();
    if (audioStream && t.audio.length > 1) {
      const pos = streamsOf(part, 2).indexOf(audioStream);
      if (pos >= 0 && t.audio[pos] != null) player.selectAudio(t.audio[pos]);
    }
    if (isEmbeddedText(subStream)) {
      const pos = streamsOf(part, 3).filter(isEmbeddedText).indexOf(subStream);
      if (pos >= 0 && t.text[pos] != null) player.selectText(t.text[pos]);
    } else {
      player.selectText(null);
      setText(subs, '');
    }
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
      })
      .catch(e => warn('subtitle fetch failed', e.message));
    clearInterval(cueTimer);
    cueTimer = setInterval(() => {
      if (cueTrack && started) setText(subs, cueTrack.at(base + player.time() - fileOpts.delay));
    }, 120);
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
      mode = decideMode();
      if (offset == null) offset = item.viewOffset || 0;
      position = offset;
      renderProgress(position);
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
      : '\n' + (fileOpts.mode === 'direct' ? 'Direct play' : 'Convert') + ' is forced for this file. Press ▼ and choose Auto under Playback.'));
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
      showOsd(true);
    }
    toggleClass(el, 'paused', paused);
    report(paused ? 'paused' : 'playing');
  }

  function seekBy(dir) {
    if (!started) return;
    const now = Date.now();
    seekCount = now - lastSeekAt < 700 ? seekCount + 1 : 0;
    lastSeekAt = now;
    const step = seekCount < 3 ? 10000 : seekCount < 8 ? 30000 : seekCount < 16 ? 60000 : 180000;
    const from = seekTarget == null ? position : seekTarget;
    seekTarget = Math.max(0, Math.min(duration - 3000, from + dir * step));
    toggleClass(el, 'seeking', true);
    setText(seekLabel, clock(seekTarget));
    renderProgress(seekTarget);
    showOsd(true);
    clearTimeout(seekTimer);
    seekTimer = setTimeout(commitSeek, SEEK_COMMIT_MS);
  }

  async function commitSeek() {
    clearTimeout(seekTimer);
    if (seekTarget == null) return;
    const target = seekTarget;
    seekTarget = null;
    toggleClass(el, 'seeking', false);
    showOsd();
    position = target;
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
  let panelLists = [[], [], []];
  let panelMode = 'tracks';   // 'tracks' | 'search'
  // Online subtitle search: results come from the server's subtitle agent.
  const search = { results: [], index: 0, status: '', busy: false, generation: 0 };

  function openPanel() {
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
    panelCol = 0;
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

  function renderPanel() {
    panel.innerHTML = '';
    toggleClass(panel, 'searching', panelMode === 'search');
    if (panelMode === 'search') { renderSearch(); return; }
    ['Audio', 'Subtitles', 'Playback'].forEach((name, c) => {
      const col = h('div', 'tracks-col', panel);
      const head = h('div', 'tracks-head', col);
      head.innerHTML = [icons.audio, icons.subtitles, icons.gear][c];
      h('span', '', head).textContent = name;
      panelLists[c].forEach((opt, i) => {
        const row = h('div', 'tracks-opt', col);
        row.textContent = opt.label;
        toggleClass(row, 'on', opt.on);
        toggleClass(row, 'focus', c === panelCol && i === panelIndex[c]);
      });
    });
  }

  function renderSearch() {
    const col = h('div', 'tracks-col', panel);
    const head = h('div', 'tracks-head', col);
    head.innerHTML = icons.search;
    h('span', '', head).textContent = 'Search subtitles';
    h('div', 'tracks-lang', col).textContent = '◀  ' + subtitleLanguage()[1] + '  ▶';
    h('div', 'tracks-status', col).textContent = search.status;
    const n = search.results.length;
    const top = Math.max(0, Math.min(n - SEARCH_ROWS, search.index - Math.floor(SEARCH_ROWS / 2)));
    search.results.slice(top, top + SEARCH_ROWS).forEach((r, k) => {
      const row = h('div', 'tracks-opt tracks-result', col);
      h('div', 'tracks-result-title', row).textContent = r.title || r.extendedDisplayTitle || r.displayTitle || 'Subtitle';
      const bits = [r.providerTitle, (r.codec || '').toUpperCase()];
      if (r.downloaded) bits.push('Downloaded');
      if (r.perfectMatch) bits.push('Matches this file');
      if (r.hearingImpaired) bits.push('SDH');
      if (r.forced) bits.push('Forced');
      h('div', 'tracks-result-meta', row).textContent = bits.filter(Boolean).join('  ·  ');
      toggleClass(row, 'focus', !search.busy && top + k === search.index);
    });
    h('div', 'tracks-foot', col).textContent = n
      ? (search.index + 1) + ' of ' + n + '   ·   OK to download   ·   ◀ ▶ language'
      : '◀ ▶ language   ·   Back to return';
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
      search.results = found.filter(r => r.key && (!r.codec || TEXT_SUBS[r.codec]))
        .sort((a, b) => (b.perfectMatch ? 1 : 0) - (a.perfectMatch ? 1 : 0) || (b.score || 0) - (a.score || 0));
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
    server.selectStreams(part.id, {
      audioStreamID: audioStream ? audioStream.id : undefined,
      subtitleStreamID: subStream ? subStream.id : 0,
    });
    closePanel();
    const wanted = decideMode();
    if (wanted === 'direct' && mode === 'direct') {
      applyTracks();
      syncSidecar();
    } else if (mode === 'hls' && wanted === 'hls' && col === 1 && isSidecarText(subStream)) {
      syncSidecar();
    } else {
      mode = wanted;
      triedFallback = false;
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

  async function nextEpisode() {
    const server = session.server;
    const eps = await server.children(item.parentRatingKey);
    const i = eps.findIndex(e => e.ratingKey === item.ratingKey);
    if (i >= 0 && i < eps.length - 1) return eps[i + 1];
    const seasons = (await server.children(item.grandparentRatingKey)).filter(s => s.type === 'season');
    const si = seasons.findIndex(s => s.ratingKey === item.parentRatingKey);
    if (si >= 0 && si < seasons.length - 1) return (await server.children(seasons[si + 1].ratingKey))[0] || null;
    return null;
  }

  async function finished() {
    position = duration;
    report('stopped');
    clearInterval(timelineTimer);
    player.close();
    if (item.type !== 'episode' || !store.get('autoplayNext', true)) { exit(); return; }
    try { nextItem = await nextEpisode(); } catch (e) { nextItem = null; }
    if (!alive) return;
    if (!nextItem) { exit(); return; }
    let left = 10;
    upnext.classList.remove('hidden');
    const render = () => {
      upnext.innerHTML = '';
      h('div', 'upnext-label', upnext).textContent = 'Up next in ' + left;
      h('div', 'upnext-title', upnext).textContent = episodeLabel(nextItem) + '   ' + nextItem.title;
      h('div', 'upnext-hint', upnext).textContent = 'OK to play now · Back to stop';
    };
    render();
    upnextTimer = setInterval(() => {
      left--;
      if (left <= 0) playNext();
      else render();
    }, 1000);
  }

  function playNext() {
    clearInterval(upnextTimer);
    router.replace(PlayerScreen(nextItem, { offset: 0 }));
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
      if (!upnext.classList.contains('hidden')) {
        if (action === 'enter') { playNext(); return true; }
        if (action === 'back' || action === 'stop') { exit(); return true; }
        return true;
      }
      if (!panel.classList.contains('hidden')) return panelKey(action);
      switch (action) {
        case 'enter':
          if (seekTarget != null) commitSeek();
          else if (skipVisible()) skipMarker();
          else if (el.classList.contains('osd-on') || paused) togglePause();
          else showOsd();
          return true;
        case 'playpause': if (seekTarget != null) commitSeek(); else togglePause(); return true;
        case 'play': if (paused) togglePause(); return true;
        case 'pause': if (!paused) togglePause(); return true;
        case 'left': case 'rw': seekBy(-1); return true;
        case 'right': case 'ff': seekBy(1); return true;
        case 'up': case 'info': showOsd(); return true;
        case 'down': if (part) openPanel(); return true;
        case 'stop': exit(); return true;
        case 'back':
          if (seekTarget != null) { seekTarget = null; toggleClass(el, 'seeking', false); renderProgress(position); showOsd(); return true; }
          if (el.classList.contains('osd-on') && !paused) { hideOsd(); return true; }
          exit();
          return true;
      }
      return true;
    },
    onHide() {},
    destroy: teardown,
  };
}
