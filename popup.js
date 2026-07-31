// Summary Toolbox — popup controller.
// Extracts transcript on open, renders a segmented preview with clickable
// timestamps, and exposes copy, TXT/SRT download, search filter, and a
// "strip non-speech" toggle.

// DOM refs.
const statusEl = document.getElementById('status');
const previewEl = document.getElementById('preview');
const transcriptPaneEl = document.getElementById('transcript-pane');
const segCountEl = document.getElementById('seg-count');
const controlsEl = document.getElementById('controls');
const stampsEl = document.getElementById('stamps');
const stripNoiseEl = document.getElementById('stripNoise');
const searchEl = document.getElementById('search');
const copyBtn = document.getElementById('copy');
const dlTxt = document.getElementById('dl-txt');
const dlSrt = document.getElementById('dl-srt');
const videoTitleEl = document.getElementById('videoTitle');
const debugRow = document.getElementById('debug-row');
const copyDebugBtn = document.getElementById('copy-debug');
const summarizeBtn = document.getElementById('summarize');
const extraPromptEl = document.getElementById('extra-prompt');
const summarySection = document.getElementById('summary-section');
const summaryContent = document.getElementById('summary-content');
const copySummaryBtn = document.getElementById('copy-summary');
const saveObsidianBtn = document.getElementById('save-obsidian');
const saveNotionBtn = document.getElementById('save-notion');
const settingsEl = document.getElementById('settings');
const balanceEl = document.getElementById('balance');
const playPauseBtn = document.getElementById('play-pause-btn');

// Data + page context, populated in init().
// `mode` flips between 'youtube' (transcript flow) and 'page' (summarise the
// active web page directly — no transcript). 'youtube' is the default so the
// transcript-specific UI behaves as before until init() decides otherwise.
let mode = 'youtube';
let segments = [];
let info = {};
let pageUrl = '';
let videoId = '';
let activeTabId = null;
// Diagnostic JSON staged by handleScrapeError; copied only if the user clicks.
let pendingDebug = '';
// Last DeepSeek summary text — held in memory so Copy / Save buttons reuse it
// without re-calling the API.
let lastSummary = '';

// LLM provider catalogue. Three API families share three adapter functions
// in callLLM; each provider just maps to a baseUrl + default model.
const PROVIDERS = {
  deepseek:   { label: 'DeepSeek',         baseUrl: 'https://api.deepseek.com',                          defaultModel: 'deepseek-v4-flash',            family: 'openai' },
  openai:     { label: 'OpenAI',           baseUrl: 'https://api.openai.com/v1',                         defaultModel: 'gpt-4o-mini',                  family: 'openai' },
  anthropic:  { label: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com',                         defaultModel: 'claude-haiku-4-5-20251001',    family: 'anthropic' },
  openrouter: { label: 'OpenRouter',       baseUrl: 'https://openrouter.ai/api/v1',                      defaultModel: 'anthropic/claude-3.5-haiku',   family: 'openai' },
  groq:       { label: 'Groq',             baseUrl: 'https://api.groq.com/openai/v1',                    defaultModel: 'llama-3.3-70b-versatile',      family: 'openai' },
  gemini:     { label: 'Google Gemini',    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',  defaultModel: 'gemini-2.5-flash-lite',        family: 'gemini' },
};
const DEFAULT_PROVIDER = 'deepseek';

// Settings field IDs ↔ storage keys. Bound on load so each change persists.
const SETTING_FIELDS = [
  ['set-provider',     'llmProvider'],
  ['set-llm-model',    'llmModel'],
  ['set-llm-key',      'llmKey'],
  ['set-summary-temp', 'summaryTemp'],
  ['set-summary-max',  'summaryMaxTokens'],
  ['set-yt-prompt',    'ytPrompt'],
  ['set-page-prompt',  'pagePrompt'],
  ['set-obs-vault',    'obsVault'],
  ['set-obs-path',     'obsPath'],
  ['set-notion-token', 'notionToken'],
  ['set-notion-page',  'notionPage'],
];

// Apply persisted UI zoom as early as possible so the popup doesn't flash at
// 100% before snapping to the user's preferred size. CSS `zoom` scales layout
// and type together — fixed-px paddings/icons come along, unlike font-size.
function applyUiZoom(pct) {
  const n = Number(pct);
  document.documentElement.style.zoom = Number.isFinite(n) && n > 0 ? n / 100 : '';
}
chrome.storage.local.get('uiZoom').then(({ uiZoom }) => {
  if (uiZoom) applyUiZoom(uiZoom);
});

// Populate the settings panel from chrome.storage and persist on input change.
async function initSettings() {
  const keys = SETTING_FIELDS.map(([, k]) => k).concat(['extraPrompt', 'deepseekKey']);
  const values = await chrome.storage.local.get(keys);

  // One-time migration: prior versions stored the key as `deepseekKey`.
  // Move it to the generic `llmKey` slot so existing users don't lose access.
  if (!values.llmKey && values.deepseekKey) {
    values.llmKey = values.deepseekKey;
    values.llmProvider = values.llmProvider || 'deepseek';
    await chrome.storage.local.set({ llmKey: values.llmKey, llmProvider: values.llmProvider });
    await chrome.storage.local.remove('deepseekKey');
  }

  // Per-key defaults shown in the field when storage has no override. For
  // the system prompts this means the user can read exactly what we're about
  // to send to their LLM provider — full transparency. Trade-off: once they
  // edit, future updates to the default in code don't reach them; clearing
  // the field reverts to the current default on next open.
  const FIELD_DEFAULTS = {
    llmProvider: DEFAULT_PROVIDER,
    ytPrompt: SUMMARY_SYSTEM_PROMPT,
    pagePrompt: PAGE_SUMMARY_SYSTEM_PROMPT,
  };

  for (const [id, key] of SETTING_FIELDS) {
    const el = document.getElementById(id);
    if (values[key]) {
      el.value = values[key];
    } else if (FIELD_DEFAULTS[key] !== undefined) {
      // Programmatic .value assignment doesn't fire input/change, so this
      // doesn't spuriously persist the default to storage.
      el.value = FIELD_DEFAULTS[key];
    }
    // Prompt textareas live-persist on 'input' so users see their edits saved
    // without needing to blur first. Empty value at summarise() time falls back
    // to the built-in default — so clearing the field reverts on next open.
    const isPrompt = key === 'ytPrompt' || key === 'pagePrompt';
    el.addEventListener(isPrompt ? 'input' : 'change', async () => {
      // Await the write before refreshing the balance pill — refreshBalance
      // reads provider+key from storage, so a fire-and-forget set would race
      // and refetch with the previous credentials.
      await chrome.storage.local.set({ [key]: el.value.trim() });
      if (key === 'llmProvider' || key === 'llmKey') refreshBalance({ force: true });
    });
  }

  // Provider dropdown drives the Model placeholder so users see what default
  // they'd get if they leave the override blank.
  const providerEl = document.getElementById('set-provider');
  const modelEl = document.getElementById('set-llm-model');
  const refreshModelPlaceholder = () => {
    const def = PROVIDERS[providerEl.value] || PROVIDERS[DEFAULT_PROVIDER];
    modelEl.placeholder = def.defaultModel;
  };
  providerEl.addEventListener('change', refreshModelPlaceholder);
  refreshModelPlaceholder();

  // Extra-prompt line: persist on every change (input + change events) so
  // edits survive popup close even without an explicit blur.
  extraPromptEl.value = values.extraPrompt || '';
  const persistExtra = () => chrome.storage.local.set({ extraPrompt: extraPromptEl.value });
  extraPromptEl.addEventListener('input', persistExtra);
  extraPromptEl.addEventListener('change', persistExtra);
  // Enter triggers Summarise — modifier-free only, so browser shortcuts
  // (e.g. ⌘⏎) keep working as expected.
  extraPromptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (!summarizeBtn.disabled) summarizeBtn.click();
    }
  });
}
initSettings();

// UI zoom slider — −/+ buttons, range input, live % readout. Persists on
// release ('change'); applies zoom + updates readout on every input event so
// the popup grows under the user's fingers. Buttons clamp at min/max.
async function initZoom() {
  const slider = document.getElementById('set-ui-zoom');
  const minus  = document.getElementById('zoom-minus');
  const plus   = document.getElementById('zoom-plus');
  const readout = document.getElementById('zoom-value');
  if (!slider) return;
  const { uiZoom } = await chrome.storage.local.get('uiZoom');
  const initial = Number(uiZoom) || 100;
  slider.value = String(initial);
  const min = Number(slider.min), max = Number(slider.max), step = Number(slider.step);
  const refresh = () => {
    const v = Number(slider.value);
    readout.textContent = v + '%';
    minus.disabled = v <= min;
    plus.disabled  = v >= max;
    applyUiZoom(v);
  };
  refresh();
  slider.addEventListener('input', refresh);
  slider.addEventListener('change', () => chrome.storage.local.set({ uiZoom: Number(slider.value) }));
  const nudge = (delta) => {
    const v = Math.max(min, Math.min(max, Number(slider.value) + delta));
    if (v === Number(slider.value)) return;
    slider.value = String(v);
    refresh();
    chrome.storage.local.set({ uiZoom: v });
  };
  minus.addEventListener('click', () => nudge(-step));
  plus .addEventListener('click', () => nudge( step));
}
initZoom();

// Footer shortcut defaults to mac glyphs in HTML; rewrite for other platforms
// so Windows/Linux users see a correct hint.
const platform = navigator.userAgentData?.platform || navigator.platform || '';
if (!/mac/i.test(platform)) {
  const keys = document.querySelector('.keys');
  if (keys) keys.innerHTML = '<kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>O</kbd>';
}

// ⌘⇧O while the popup is focused closes it, mirroring Chrome's toggle
// behaviour on `_execute_action`.
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'o' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
    e.preventDefault();
    window.close();
  }
});

init();
refreshBalance();

async function init() {
  try {
    // Restore toggle preferences before extraction so the first render matches
    // what the user last chose.
    const prefs = await chrome.storage.local.get(['stamps', 'stripNoise']);
    if (prefs.stamps === false) stampsEl.checked = false;
    if (prefs.stripNoise === true) stripNoiseEl.checked = true;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Strict check: only main-site watch pages get the transcript flow.
    // Anything else (Shorts, music, plain web pages) falls into page mode
    // where the user can still summarise the active tab.
    let parsedUrl;
    try { parsedUrl = new URL(tab?.url || ''); } catch {}
    const isWatch = parsedUrl?.hostname === 'www.youtube.com' && parsedUrl.pathname === '/watch';
    if (!isWatch) {
      initPageMode(tab, parsedUrl);
      return;
    }

    activeTabId = tab.id;
    pageUrl = tab.url;
    videoId = parsedUrl.searchParams.get('v') || '';

    // Play/pause toggle works the moment we know we're on a YouTube tab,
    // even if transcript extraction later fails (e.g. video has no captions).
    // Revealing it here keeps it consistent with the spacebar shortcut.
    playPauseBtn.hidden = false;

    let [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      // MAIN world so scrapePage can call the player's getPlayerResponse()
      // API and read window.ytInitialPlayerResponse — both page-context only.
      world: 'MAIN',
      func: scrapePage,
    });

    if (!result?.segments?.length) {
      handleScrapeError(result);
      return;
    }

    segments = result.segments;
    info = result.info || {};

    if (info.title) {
      videoTitleEl.textContent = info.title;
      videoTitleEl.hidden = false;
    }

    renderPreview();
    segCountEl.textContent = `${segments.length} segments`;
    transcriptPaneEl.hidden = false;
    controlsEl.hidden = false;
    setStatus('Ready.', 'ok');
    // Restore the last summary for this URL if we have one cached.
    restoreCachedSummary();
  } catch (e) {
    setStatus(`Error: ${e.message}`, 'err');
  }
}

// Page mode — invoked when the active tab isn't a YouTube watch page.
// Repurposes the popup so the user can summarise the page they're on,
// reusing the existing LLM + Save flows. No transcript, no preview, no
// downloads — Summarise is the only action.
function initPageMode(tab, parsedUrl) {
  if (isRestrictedUrl(parsedUrl)) {
    setStatus("Chrome doesn't let extensions read this page. Open a regular web page or a YouTube video.", 'err');
    return;
  }

  mode = 'page';
  activeTabId = tab.id;
  pageUrl = tab.url || '';
  info = { title: (tab.title || '').trim() };

  if (info.title) {
    videoTitleEl.textContent = info.title;
    videoTitleEl.hidden = false;
  }

  // Reveal the action block but hide transcript-only controls. Summarise
  // becomes the sole primary action; the transcript pane stays collapsed.
  copyBtn.hidden = true;
  controlsEl.hidden = false;
  extraPromptEl.placeholder = 'Custom instruction…';

  setStatus('Ready to summarise this page.', 'ok');
  restoreCachedSummary();
}

// Schemes/hosts where chrome.scripting can't run. Used to fail fast in page
// mode with a friendly message rather than a cryptic injection error.
function isRestrictedUrl(parsed) {
  if (!parsed) return true;
  const restrictedSchemes = ['chrome:', 'chrome-extension:', 'edge:', 'about:', 'view-source:', 'devtools:'];
  if (restrictedSchemes.includes(parsed.protocol)) return true;
  if (parsed.hostname === 'chromewebstore.google.com') return true;
  if (parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore')) return true;
  return false;
}

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = cls;
}

// Open the Settings disclosure (and any nested ones), focus the named field,
// scroll it into view, and pulse the .attention highlight so the user can
// spot it immediately. Used by the "you forgot to set X" error paths.
function flagSettingsField(id) {
  const el = document.getElementById(id);
  if (!el) return;
  // Walk up and open every ancestor <details> so the field is actually shown.
  let p = el.parentElement;
  while (p) {
    if (p.tagName === 'DETAILS') p.open = true;
    p = p.parentElement;
  }
  // Defer focus + scroll one frame so the disclosure layout has settled.
  requestAnimationFrame(() => {
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('attention');
    setTimeout(() => el.classList.remove('attention'), 2800);
  });
}

// Translate scrape error codes into friendlier messages. Unknown codes fall
// through to the raw string so we don't silently swallow anything.
function handleScrapeError(result) {
  const code = result?.error || 'unknown';
  const messages = {
    'no-button': "This video doesn't have captions available.",
    'panel-empty': "Couldn't load this video's transcript.",
  };
  let msg = messages[code] || result?.error || 'No transcript available.';

  // Stage diagnostics and reveal the copy button (only writes to clipboard on
  // an explicit click).
  if (result?.debug) {
    pendingDebug = JSON.stringify(result.debug, null, 2);
    debugRow.hidden = false;
  }
  setStatus(msg, 'err');
}

// Diagnostic-copy button — only active after a panel-empty failure.
copyDebugBtn.addEventListener('click', async () => {
  if (!pendingDebug) return;
  try {
    await navigator.clipboard.writeText(pendingDebug);
    copyDebugBtn.textContent = 'Copied!';
    setTimeout(() => { copyDebugBtn.textContent = 'Copy diagnostic'; }, 1500);
  } catch (e) {
    setStatus(`Copy failed: ${e.message}`, 'err');
  }
});

// Regex for caption noise: bracketed markers like [Music] / [Applause], and
// caption leader arrows ">>" that YouTube uses for speaker changes.
const NOISE_RE = /\[[^\]]+\]|^\s*>>\s*/g;

// Returns the current segment list with non-speech markers removed when the
// toggle is on. Shared by preview, clipboard copy, and both downloads so the
// output stays consistent.
function effectiveSegments() {
  if (!stripNoiseEl.checked) return segments;
  return segments
    .map(s => ({
      timestamp: s.timestamp,
      text: s.text.replace(NOISE_RE, '').replace(/\s+/g, ' ').trim(),
    }))
    .filter(s => s.text);
}

// Convert "m:ss" or "h:mm:ss" into seconds — used when seeking the player.
function parseStamp(ts) {
  const parts = (ts || '').split(':').map(n => parseInt(n, 10) || 0);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

// Minimal HTML escape, applied to every user-visible string before insertion
// via innerHTML (only used for search highlighting).
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Wrap every case-insensitive match of `query` in <mark>; otherwise
// return the plain escaped text.
function highlight(text, query) {
  if (!query) return escapeHtml(text);
  const lower = text.toLowerCase();
  let out = '';
  let i = 0;
  while (i < text.length) {
    const m = lower.indexOf(query, i);
    if (m === -1) { out += escapeHtml(text.slice(i)); break; }
    out += escapeHtml(text.slice(i, m))
      + '<mark>' + escapeHtml(text.slice(m, m + query.length)) + '</mark>';
    i = m + query.length;
  }
  return out;
}

// Render the segmented preview. Invoked after extraction, on every toggle
// change, and on search input (debounced).
function renderPreview() {
  const query = (searchEl.value || '').trim().toLowerCase();
  const rows = effectiveSegments();

  previewEl.classList.toggle('no-stamps', !stampsEl.checked);

  const frag = document.createDocumentFragment();
  for (const s of rows) {
    if (query && !s.text.toLowerCase().includes(query)) continue;

    const row = document.createElement('div');
    row.className = 'seg';

    if (s.timestamp) {
      const t = document.createElement('button');
      t.className = 't';
      t.type = 'button';
      t.textContent = s.timestamp;
      t.dataset.sec = String(parseStamp(s.timestamp));
      t.title = 'Jump to this point in the video';
      row.appendChild(t);
    }

    const span = document.createElement('span');
    span.className = 'txt';
    span.innerHTML = highlight(s.text, query);
    row.appendChild(span);

    frag.appendChild(row);
  }

  previewEl.replaceChildren(frag);

  // Helpful empty state when the search filter matches nothing.
  if (query && !previewEl.children.length) {
    const empty = document.createElement('div');
    empty.className = 'seg';
    empty.style.color = 'var(--base-muted)';
    empty.textContent = 'No matches.';
    previewEl.appendChild(empty);
  }
}

// Delegate timestamp-chip clicks to a single listener on the preview container.
previewEl.addEventListener('click', (e) => {
  const t = e.target.closest('.t');
  if (!t) return;
  const sec = Number(t.dataset.sec);
  if (Number.isFinite(sec)) seekVideo(sec);
  // Blur so focus returns to <body>; otherwise the focused chip would
  // swallow subsequent spacebar presses (which should toggle play/pause).
  t.blur();
});

// Toggle play/pause on the active YouTube tab without stealing focus from
// the popup (so the popup stays open). Tries the YouTube player API first
// — getPlayerState returns 1 when playing, anything else (paused, cued,
// unstarted, buffering, ended) we treat as "should play". Falls back to
// the raw <video> element if the player API isn't available yet.
async function togglePlayPause() {
  if (activeTabId == null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      world: 'MAIN',
      func: () => {
        const player = document.getElementById('movie_player');
        if (player && typeof player.getPlayerState === 'function') {
          const state = player.getPlayerState();
          if (state === 1) player.pauseVideo?.();
          else player.playVideo?.();
          return;
        }
        const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
        if (v) {
          if (v.paused) v.play().catch(() => {});
          else v.pause();
        }
      },
    });
  } catch (e) {
    setStatus(`Toggle failed: ${e.message}`, 'err');
  }
}

playPauseBtn.addEventListener('click', togglePlayPause);

// Spacebar in the popup = play/pause, matching youtube.com's own shortcut.
// Suppressed when the user is typing into a text input or the search box,
// so spaces in "Custom instruction", search, settings keys etc. work normally.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  if (mode !== 'youtube') return;
  // Ignore key auto-repeat — holding space would otherwise thrash the toggle
  // dozens of times per second.
  if (e.repeat) return;
  const t = e.target;
  const tag = (t?.tagName || '').toLowerCase();
  // Skip text inputs (let space type a space), selects (let space open the
  // dropdown), and buttons (let space trigger their native click — otherwise
  // we'd toggle twice on the play-pause button itself, or hijack a focused
  // timestamp chip's space-to-click).
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || t?.isContentEditable) return;
  e.preventDefault();
  togglePlayPause();
});

// Inject a tiny function into the page that moves the video's current time
// and focuses the tab so the user can see the jump. Runs in MAIN world so we
// can call YouTube's own player API — writes to <video>.currentTime from the
// isolated world get snapped back by the player's internal state sync.
async function seekVideo(seconds) {
  if (activeTabId == null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      world: 'MAIN',
      func: (t) => {
        const player = document.getElementById('movie_player');
        if (player && typeof player.seekTo === 'function') {
          player.seekTo(t, true);
          // Resume playback if the video is paused/cued/unstarted. State codes:
          // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued.
          // playVideo() on an already-playing video is a no-op.
          if (typeof player.playVideo === 'function') player.playVideo();
          return;
        }
        const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
        if (v) { v.currentTime = t; v.play().catch(() => {}); }
      },
      args: [seconds],
    });
    await chrome.tabs.update(activeTabId, { active: true });
  } catch (e) {
    setStatus(`Seek failed: ${e.message}`, 'err');
  }
}

// Plain-text builder for clipboard and TXT export. Uses effectiveSegments so
// both toggles (timestamps + strip-noise) are applied consistently.
function buildText(withStamps) {
  const body = effectiveSegments()
    .map(s => (withStamps && s.timestamp ? `[${s.timestamp}] ${s.text}` : s.text))
    .join('\n');
  return body + footerBlock();
}

// Metadata block appended to both preview output and TXT/SRT exports.
function footerBlock() {
  // en-CA formats as YYYY-MM-DD and respects the user's local timezone —
  // toISOString would give UTC and can read as "tomorrow" late in the day.
  const today = new Date().toLocaleDateString('en-CA');
  const lines = ['', '---'];
  if (info.title)     lines.push(`Title: ${info.title}`);
  if (info.channel)   lines.push(`Channel: ${info.channel}`);
  if (info.published) lines.push(`Published: ${info.published}`);
  if (info.duration)  lines.push(`Duration: ${info.duration}`);
  lines.push(`URL: ${pageUrl}`);
  lines.push(`Extracted: ${today}`);
  return lines.join('\n');
}

// Persist each toggle on change, then repaint the preview.
stampsEl.addEventListener('change', () => {
  chrome.storage.local.set({ stamps: stampsEl.checked });
  renderPreview();
});
stripNoiseEl.addEventListener('change', () => {
  chrome.storage.local.set({ stripNoise: stripNoiseEl.checked });
  renderPreview();
});

// Debounced search — avoids re-rendering the list on every keystroke for
// long transcripts.
let searchTimer = null;
searchEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderPreview, 120);
});

// Copy handler: clipboard write + brief visual confirmation on the button.
copyBtn.addEventListener('click', async () => {
  // Collapse Settings if the user had it open — once they're acting, the panel
  // is just visual noise above the result.
  settingsEl.open = false;
  try {
    const text = buildText(stampsEl.checked);
    await navigator.clipboard.writeText(text);
    const label = copyBtn.textContent;
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = label; }, 1500);
    setStatus(`Copied ${text.length.toLocaleString()} characters.`, 'ok');
  } catch (e) {
    setStatus(`Copy failed: ${e.message}`, 'err');
  }
});

dlTxt.addEventListener('click', () => saveAs('txt'));
dlSrt.addEventListener('click', () => saveAs('srt'));

function saveAs(kind) {
  let content;
  const mime = 'text/plain';
  if (kind === 'srt') {
    // SRT with the metadata appended as comment lines (`# ...`).
    const footer = footerBlock().split('\n').map(l => (l ? `# ${l}` : '')).join('\n');
    content = toSrt(effectiveSegments(), info.duration) + '\n' + footer;
  } else {
    content = buildText(stampsEl.checked);
  }
  const name = buildFilename(kind);
  downloadBlob(content, name, mime);
  setStatus(`Downloaded ${name}.`, 'ok');
}

// Filename format: "Title - Channel.ext", falling back to the video id.
function buildFilename(ext) {
  const parts = [];
  if (info.title)   parts.push(cleanName(info.title));
  if (info.channel) parts.push(cleanName(info.channel));
  if (!parts.length) parts.push(videoId || 'transcript');
  return `${parts.join(' - ')}.${ext}`;
}

// Strip characters that break on macOS / Windows filesystems, then clamp length.
function cleanName(s) {
  return s.replace(/[\/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// Save a string to disk via a transient Blob URL.
function downloadBlob(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// SRT helpers. Work in whole seconds end-to-end — YouTube only gives
// second-granularity stamps, so the millisecond field is always ,000.
function srtFromSec(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},000`;
}
// Build SRT cues. Each cue ends where the next begins; the final cue runs
// for 3 s but gets clamped to the video's total duration when we scraped it.
function toSrt(items, durationStamp) {
  const durSec = durationStamp ? parseStamp(durationStamp) : 0;
  const cues = [];
  items.forEach((item, i) => {
    if (!item.timestamp) return;
    const startSec = parseStamp(item.timestamp);
    const nextStamp = items[i + 1]?.timestamp;
    let endSec;
    if (nextStamp) {
      endSec = parseStamp(nextStamp);
    } else {
      endSec = startSec + 3;
      if (durSec > startSec) endSec = Math.min(endSec, durSec);
    }
    cues.push(`${cues.length + 1}\n${srtFromSec(startSec)} --> ${srtFromSec(endSec)}\n${item.text}`);
  });
  return cues.join('\n\n');
}

// --------------------------------------------------------------------------
// Summary feature — BYOK LLM + save to Obsidian / Notion.
// All keys live in chrome.storage.local; nothing leaves the device except
// the explicit POST to the configured provider / PATCH to api.notion.com.
// --------------------------------------------------------------------------

// Cap transcript at ~80k chars (~20k tokens) — comfortably under every
// supported provider's context window and keeps cost predictable.
const SUMMARY_INPUT_CAP = 80000;

const SUMMARY_SYSTEM_PROMPT =
  'You summarise YouTube video transcripts.\n\n' +
  'Output 5–7 concise bullet points covering the main topics, each prefixed with "- ".\n' +
  'Where a bullet refers to a specific moment in the video, end the bullet with the timestamp in square brackets, e.g. "[2:45]" or "[1:12:30]". A range is fine if the bullet covers a span: "[1:52–3:23]". If a bullet cites several separate moments, put them all inside one pair of brackets separated by commas, e.g. "[4:49–5:11, 13:00–13:19]" — never use more than one pair of brackets in a single bullet. Use timestamps that appear in the supplied transcript only — never invent or guess.\n' +
  'No preamble, no closing remarks, no headings, no extra blank lines.';

// Page-mode counterpart. Same shape (5–7 bullets) so the renderer + save
// flows don't need to know which mode produced the summary.
const PAGE_SUMMARY_SYSTEM_PROMPT =
  'You summarise web pages.\n\n' +
  'Output 5–7 concise bullet points covering the main points of the page, each prefixed with "- ".\n' +
  'Ignore navigation, cookie banners, ads, and footer boilerplate.\n' +
  'No preamble, no closing remarks, no headings, no extra blank lines.';

summarizeBtn.addEventListener('click', summarise);
copySummaryBtn.addEventListener('click', copySummary);
saveObsidianBtn.addEventListener('click', saveToObsidian);
saveNotionBtn.addEventListener('click', saveToNotion);

async function summarise() {
  // Collapse Settings on action start so the summary has room. If a required
  // field is missing, flagSettingsField() below re-opens the panel and points
  // the user at the right input.
  settingsEl.open = false;
  const stored = await chrome.storage.local.get([
    'llmProvider', 'llmModel', 'llmKey', 'extraPrompt',
    'summaryTemp', 'summaryMaxTokens', 'ytPrompt', 'pagePrompt',
  ]);
  const providerKey = stored.llmProvider || DEFAULT_PROVIDER;
  const provider = PROVIDERS[providerKey] || PROVIDERS[DEFAULT_PROVIDER];
  const apiKey = (stored.llmKey || '').trim();

  // Resolve user-tuned sampling params, falling back to the defaults baked
  // into streamLLM. parseFloat/parseInt return NaN on empty/invalid input,
  // which Number.isFinite catches.
  const tempNum = parseFloat(stored.summaryTemp);
  const temperature = Number.isFinite(tempNum) ? tempNum : 0.3;
  const maxNum = parseInt(stored.summaryMaxTokens, 10);
  const maxTokens = Number.isFinite(maxNum) ? maxNum : 600;

  if (!apiKey) {
    // Only name the provider if the user has explicitly picked one — otherwise
    // we'd be telling first-time users "add a DeepSeek key" when they may want
    // a different provider. `stored.llmProvider` is undefined when nothing's
    // been chosen and we fell back to DEFAULT_PROVIDER.
    const msg = stored.llmProvider
      ? `Add a ${provider.label} API key in Settings first.`
      : 'Pick a provider and add an API key in Settings.';
    setStatus(msg, 'err');
    flagSettingsField('set-llm-key');
    return;
  }

  const subject = mode === 'page' ? 'page' : 'transcript';
  const origLabel = summarizeBtn.textContent;
  summarizeBtn.disabled = true;
  summarizeBtn.textContent = 'Summarising…';

  try {
    // Resolve the input text + system prompt for the current mode.
    // YouTube mode uses the already-extracted transcript; page mode injects
    // a one-shot scraper into the active tab to read its main content.
    let inputText;
    let systemBase;
    if (mode === 'page') {
      setStatus('Reading page…');
      const page = await readPageText();
      if (!page || !page.text) throw new Error("This page has no readable text.");
      // If init() didn't capture a title (e.g. tab.title was empty), pick up
      // whatever the document reports now and surface it in the header.
      if (page.title && !info.title) {
        info.title = page.title;
        videoTitleEl.textContent = page.title;
        videoTitleEl.hidden = false;
      }
      inputText = page.text;
      // User override wins; empty/whitespace falls back to the built-in default.
      systemBase = (stored.pagePrompt || '').trim() || PAGE_SUMMARY_SYSTEM_PROMPT;
    } else {
      if (!segments.length) throw new Error('No transcript to summarise.');
      // Include timestamps inline so the model can cite the moment a point
      // refers to (rendered as clickable chips by renderSummary). Adds ~10%
      // tokens vs. plain text — worth it for the seek-from-summary feature.
      inputText = segments.map(s => s.timestamp ? `[${s.timestamp}] ${s.text}` : s.text).join(' ');
      systemBase = (stored.ytPrompt || '').trim() || SUMMARY_SYSTEM_PROMPT;
    }

    const truncated = inputText.length > SUMMARY_INPUT_CAP;
    if (truncated) inputText = inputText.slice(0, SUMMARY_INPUT_CAP);

    // Live extra-prompt input wins so unblurred edits aren't lost.
    const extra = (extraPromptEl.value || stored.extraPrompt || '').trim();
    const systemContent = extra
      ? `${systemBase}\n\nThe user added a specific request: "${extra}"\nBefore the bullet points, write a brief 2–3 sentence direct answer to that request as plain prose (no bullet markers, no heading). Then output the bullets as instructed above.`
      : systemBase;

    setStatus(truncated
      ? `Sending (truncated) ${subject} to ${provider.label}…`
      : `Sending ${subject} to ${provider.label}…`);

    // Stream chunks in. Reveal the summary panel and collapse the transcript
    // straight away so the user sees text appear, not a frozen "Summarising…"
    // button. Re-render is debounced (~50ms) to avoid hammering the DOM on
    // fast streams (Groq can deliver hundreds of chunks per second).
    summarySection.hidden = false;
    transcriptPaneEl.open = false;
    summaryContent.replaceChildren();

    let accumulated = '';
    let firstChunk = true;
    let renderQueued = false;
    const flushRender = () => {
      renderQueued = false;
      renderSummary(accumulated);
    };
    const scheduleRender = () => {
      if (renderQueued) return;
      renderQueued = true;
      setTimeout(flushRender, 50);
    };

    for await (const chunk of streamLLM({
      providerKey,
      model: (stored.llmModel || '').trim(),
      apiKey,
      system: systemContent,
      user: inputText,
      temperature,
      maxTokens,
    })) {
      accumulated += chunk;
      if (firstChunk) {
        firstChunk = false;
        setStatus(`Receiving from ${provider.label}…`);
      }
      scheduleRender();
    }
    // Final render — guarantees the last chunk lands even if the debounce
    // timer hadn't fired yet.
    renderSummary(accumulated);

    if (!accumulated.trim()) throw new Error('Empty response');
    lastSummary = accumulated;

    setStatus(truncated ? 'Summary ready (input truncated).' : 'Summary ready.', 'ok');
    // Persist for next time the user opens the popup on this URL.
    saveSummaryToHistory();
    // Just spent some tokens — refresh the DeepSeek balance pill so the user
    // sees the cost they incurred. No-op for other providers.
    refreshBalance({ force: true });
  } catch (e) {
    setStatus(`Summary failed: ${e.message}`, 'err');
  } finally {
    summarizeBtn.disabled = false;
    summarizeBtn.textContent = origLabel;
  }
}

// Inject a tiny scraper into the active tab and pull back its main text.
// Prefers <article> / <main> / [role=main] before falling back to <body>;
// innerText respects CSS visibility, so hidden nav/cookie banners drop out.
async function readPageText() {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: activeTabId },
    func: () => {
      const root = document.querySelector('article')
        || document.querySelector('main')
        || document.querySelector('[role="main"]')
        || document.body;
      const text = (root?.innerText || '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return { title: (document.title || '').trim(), text };
    },
  });
  return result;
}

// Provider-agnostic streaming LLM call. Yields text chunks as they arrive so
// the summary can render progressively. All four providers expose SSE-style
// streams: OpenAI-compatible (data lines + [DONE]), Anthropic
// (content_block_delta events) and Gemini (?alt=sse mirrors the non-streaming
// shape, one JSON object per event).
async function* streamLLM({ providerKey, model, apiKey, system, user, temperature = 0.3, maxTokens = 600 }) {
  const provider = PROVIDERS[providerKey] || PROVIDERS[DEFAULT_PROVIDER];
  const useModel = model || provider.defaultModel;

  // Abort if the server hasn't started responding within 20 s. Cleared as soon
  // as fetch() resolves (headers received) — the streaming phase after that is
  // fast. Without this, a slow/unresponsive provider hangs the popup silently.
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 20_000);

  const fail = async (res) => {
    const t = await res.text().catch(() => '');
    throw new Error(`${provider.label} ${res.status}${t ? ': ' + t.slice(0, 200) : ''}`);
  };

  try {
    if (provider.family === 'openai') {
      // OpenAI-compatible chat completions — DeepSeek, OpenAI, OpenRouter, Groq.
      const res = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: useModel,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature,
          max_tokens: maxTokens,
          stream: true,
          // deepseek-v4-flash defaults to "thinking" mode, which burns the
          // max_tokens budget on reasoning_content (which we don't read) and
          // can leave content empty. We only want the direct answer.
          ...(providerKey === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
        }),
        signal: controller.signal,
      });
      clearTimeout(tid);
      if (!res.ok) await fail(res);
      yield* parseSSE(res.body, (data) => data?.choices?.[0]?.delta?.content || '');
      return;
    }

    if (provider.family === 'anthropic') {
      // Anthropic Messages API — separate `system` field, x-api-key auth, and
      // the dangerous-direct-browser-access opt-in for non-server callers.
      const res = await fetch(`${provider.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: useModel,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
          stream: true,
        }),
        signal: controller.signal,
      });
      clearTimeout(tid);
      if (!res.ok) await fail(res);
      // Anthropic emits multiple event types; only content_block_delta carries
      // generated text. Other types (message_start, ping, message_delta) yield ''.
      yield* parseSSE(res.body, (data) => {
        if (data?.type === 'content_block_delta') return data?.delta?.text || '';
        return '';
      });
      return;
    }

    if (provider.family === 'gemini') {
      // Gemini's streaming endpoint mirrors the non-streaming shape per chunk
      // when ?alt=sse is set. Without that flag it returns a JSON array — much
      // harder to parse incrementally.
      const url = `${provider.baseUrl}/models/${encodeURIComponent(useModel)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature, maxOutputTokens: maxTokens },
        }),
        signal: controller.signal,
      });
      clearTimeout(tid);
      if (!res.ok) await fail(res);
      yield* parseSSE(res.body, (data) => {
        const parts = data?.candidates?.[0]?.content?.parts || [];
        return parts.map(p => p?.text || '').join('');
      });
      return;
    }

    throw new Error(`Unknown provider family: ${provider.family}`);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${provider.label} didn't respond within 20 s — try again.`);
    throw e;
  } finally {
    clearTimeout(tid);
  }
}

// Generic SSE reader. Pulls bytes off the response body, splits on newlines,
// looks at "data:" lines only (the rest — "event:", blank lines, comments —
// is metadata our extractors don't need). Each data payload is JSON-parsed
// and handed to the provider-specific extractor, which returns the text
// fragment to yield (or '' to skip).
async function* parseSSE(body, extractText) {
  if (!body) throw new Error('Stream has no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trimEnd();
      buffer = buffer.slice(nl + 1);
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const data = JSON.parse(payload);
        const chunk = extractText(data);
        if (chunk) yield chunk;
      } catch {
        // Malformed line — skip rather than abort the whole stream.
      }
    }
  }
}

// Split the model response into an optional prose prefix and the bullet list.
// Lines that start with a bullet marker / numbered list go into bullets;
// everything before the first such line becomes the prefix paragraph (used
// when the user added an "Custom instruction" request and we asked the model to
// answer it briefly before the bullets). Bullet markers are stripped so the
// renderer applies its own list styling.
const BULLET_LINE_RE = /^[-*•]\s+|^\d+[.)]\s+/;
function parseSummaryResponse(text) {
  const lines = text.split('\n').map(l => l.trim());
  const firstBullet = lines.findIndex(l => BULLET_LINE_RE.test(l));
  const prefixLines = firstBullet === -1 ? lines : lines.slice(0, firstBullet);
  const bulletLines = firstBullet === -1 ? [] : lines.slice(firstBullet);
  const prefix = prefixLines.filter(Boolean).join(' ').trim();
  const bullets = bulletLines
    .filter(Boolean)
    .map(l => l.replace(BULLET_LINE_RE, '').trim())
    .filter(Boolean);
  return { prefix, bullets };
}

// Matches one or more comma-separated timestamps (or timestamp ranges)
// wrapped in a single pair of square brackets, e.g. "[2:45]", "[1:12:30]",
// "[1:52–3:23]" (hyphen/en-dash/em-dash, optional whitespace), or
// "[4:49–5:11, 13:00–13:19]" — some models (DeepSeek observed) cite several
// moments per bullet inside one bracket instead of one bracket each; m[1]
// captures the whole comma-joined body so appendBulletWithStamps can split it
// into one chip per timestamp. Kept brackets-only so we don't accidentally
// chip-ify "[Music]" or random bracketed prose the model emits.
const STAMP_ITEM_SRC = '\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s*[–—-]\\s*\\d{1,2}:\\d{2}(?::\\d{2})?)?';
const SUMMARY_STAMP_RE = new RegExp(`\\[(${STAMP_ITEM_SRC}(?:\\s*,\\s*${STAMP_ITEM_SRC})*)\\]`, 'g');

function renderSummary(text, { meta } = {}) {
  const { prefix, bullets } = parseSummaryResponse(text);
  summaryContent.replaceChildren();

  // Optional "from 2h ago" caption above the list, used by the cache-restore
  // path so the user knows they're looking at a previous run. Includes a small
  // refresh link that re-runs summarise() so the affordance is right there
  // alongside the staleness signal.
  if (meta) {
    const note = document.createElement('div');
    note.className = 'summary-meta';
    const label = document.createElement('span');
    label.textContent = meta;
    note.appendChild(label);
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.textContent = '↻ refresh';
    refresh.title = 'Re-summarise this page';
    refresh.addEventListener('click', () => { if (!summarizeBtn.disabled) summarise(); });
    note.appendChild(refresh);
    summaryContent.appendChild(note);
  }

  // Prefix paragraph — present only when the user supplied "Custom instruction" and
  // the model wrote a direct answer above the bullets. Reuse the chip-aware
  // appender so timestamp citations in the prefix are clickable too.
  if (prefix) {
    const p = document.createElement('p');
    p.className = 'summary-prefix';
    appendBulletWithStamps(p, prefix);
    summaryContent.appendChild(p);
  }

  if (bullets.length) {
    const ul = document.createElement('ul');
    for (const b of bullets) {
      const li = document.createElement('li');
      appendBulletWithStamps(li, b);
      ul.appendChild(li);
    }
    summaryContent.appendChild(ul);
  }
}

// Parse a single bullet's text, splitting on [mm:ss] tokens. Each match becomes
// a button.t chip with data-sec; surrounding text is appended as plain nodes.
// Page mode (no segments) skips chip-building so non-YouTube summaries don't
// dangle un-clickable buttons. Out-of-range stamps (>video duration) also fall
// back to plain text — guards against the model hallucinating timestamps.
function appendBulletWithStamps(li, text) {
  const canChip = mode === 'youtube' && segments.length > 0;
  const durSec = info.duration ? parseStamp(info.duration) : 0;

  let lastIdx = 0;
  SUMMARY_STAMP_RE.lastIndex = 0;
  let m;
  while ((m = SUMMARY_STAMP_RE.exec(text)) !== null) {
    if (m.index > lastIdx) {
      li.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
    }
    // m[1] is the whole bracket body, e.g. "1:52–3:23" or the multi-stamp
    // "4:49–5:11, 13:00–13:19" — split on comma so each cited moment gets
    // its own chip instead of the bracket falling back to plain text.
    const items = m[1].split(',').map(s => s.trim());
    items.forEach((display, i) => {
      if (i > 0) li.appendChild(document.createTextNode(', '));
      const startStamp = display.match(/^\d{1,2}:\d{2}(?::\d{2})?/)[0];
      const sec = parseStamp(startStamp);
      const validRange = sec >= 0 && (durSec === 0 || sec <= durSec);
      if (canChip && validRange) {
        const btn = document.createElement('button');
        btn.className = 't';
        btn.type = 'button';
        btn.textContent = display;
        btn.dataset.sec = String(sec);
        btn.title = 'Jump to this point in the video';
        li.appendChild(btn);
      } else {
        li.appendChild(document.createTextNode(display));
      }
    });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    li.appendChild(document.createTextNode(text.slice(lastIdx)));
  }
}

// Delegated click handler — chips inside summary bullets share the same .t
// shape as transcript-preview chips, so they reuse the same seekVideo path.
summaryContent.addEventListener('click', (e) => {
  const t = e.target.closest('.t');
  if (!t) return;
  const sec = Number(t.dataset.sec);
  if (Number.isFinite(sec)) seekVideo(sec);
  // Same reason as the preview-chip handler — blur so spacebar afterwards
  // toggles play/pause instead of re-seeking the focused chip.
  t.blur();
});

// Markdown payload for clipboard + Obsidian. Format: title, YouTube link,
// optional prefix paragraph (when the user supplied a Custom instruction request
// and the model answered it above the bullets), then bullets.
function buildMarkdownPayload() {
  const title = info.title || 'Untitled video';
  const { prefix, bullets } = parseSummaryResponse(lastSummary);
  const lines = [`## ${title}`, pageUrl, ''];
  if (prefix) lines.push(prefix, '');
  lines.push(bullets.map(b => `- ${b}`).join('\n'));
  return lines.join('\n') + '\n';
}

async function copySummary() {
  if (!lastSummary) return;
  try {
    await navigator.clipboard.writeText(buildMarkdownPayload());
    const orig = copySummaryBtn.textContent;
    copySummaryBtn.textContent = 'Copied!';
    setTimeout(() => { copySummaryBtn.textContent = orig; }, 1500);
    setStatus('Summary copied.', 'ok');
  } catch (e) {
    setStatus(`Copy failed: ${e.message}`, 'err');
  }
}

async function saveToObsidian() {
  if (!lastSummary) return;
  const stored = await chrome.storage.local.get(['obsVault', 'obsPath']);
  // Accept loose user input: surrounding quotes, backslashes, or a full
  // absolute filesystem path. Advanced URI itself only takes a vault name +
  // vault-relative path, so we normalise here rather than nag the user.
  const stripQuotes = s => (s || '').trim().replace(/^['"]|['"]$/g, '').trim();
  const obsVault = stripQuotes(stored.obsVault);
  let obsPath = stripQuotes(stored.obsPath).replace(/\\/g, '/');

  // If the field holds an absolute path, slice off everything up to and
  // including the vault folder so what's left is vault-relative. Falls back
  // to the basename when the vault name isn't found in the path.
  if (obsPath.startsWith('/') && obsVault) {
    const marker = '/' + obsVault + '/';
    const idx = obsPath.lastIndexOf(marker);
    obsPath = idx !== -1
      ? obsPath.slice(idx + marker.length)
      : (obsPath.split('/').pop() || obsPath);
  }
  obsPath = obsPath.replace(/^\/+/, '');

  if (!obsVault || !obsPath) {
    setStatus('Set Obsidian vault and file path in Settings.', 'err');
    flagSettingsField(obsVault ? 'set-obs-path' : 'set-obs-vault');
    return;
  }

  // Put the markdown on the clipboard, then have Advanced URI pull from
  // there. Keeps the URI short (no embedded summary) — sidesteps URL-encoding
  // and length issues that can mangle a long inline `data=` payload.
  const data = '\n\n' + buildMarkdownPayload();
  try {
    await navigator.clipboard.writeText(data);
  } catch (e) {
    setStatus(`Clipboard write failed: ${e.message}`, 'err');
    return;
  }
  const uri = 'obsidian://adv-uri'
    + `?vault=${encodeURIComponent(obsVault)}`
    + `&filepath=${encodeURIComponent(obsPath)}`
    + `&clipboard=true`
    + `&mode=append`;
  triggerScheme(uri);
  setStatus(`Sent to Obsidian (vault="${obsVault}", file="${obsPath}").`, 'ok');
}

// Anchor click in the popup itself. This is a top-level navigation in the
// same user-activation tick — Chrome remembers an "Always allow" choice
// against the popup origin, so subsequent saves dispatch silently. Tabs
// opened via chrome.tabs.create count as fresh nav and re-prompt every time.
// Side effect: the popup unloads as Obsidian takes focus.
function triggerScheme(uri) {
  const a = document.createElement('a');
  a.href = uri;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function saveToNotion() {
  if (!lastSummary) return;
  const { notionToken, notionPage } = await chrome.storage.local.get(['notionToken', 'notionPage']);
  if (!notionToken || !notionPage) {
    setStatus('Set Notion token and page ID in Settings.', 'err');
    flagSettingsField(notionToken ? 'set-notion-page' : 'set-notion-token');
    return;
  }

  saveNotionBtn.disabled = true;
  setStatus('Saving to Notion…');

  try {
    // Notion accepts ids with or without dashes; normalise to be safe.
    const pageId = notionPage.replace(/-/g, '').trim();
    const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${notionToken}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ children: buildNotionBlocks() }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Notion ${res.status}${t ? ': ' + t.slice(0, 200) : ''}`);
    }
    setStatus('Saved to Notion.', 'ok');
  } catch (e) {
    setStatus(`Notion save failed: ${e.message}`, 'err');
  } finally {
    saveNotionBtn.disabled = false;
  }
}

// Build Notion children blocks: heading with the title, paragraph with the
// linked URL, optional prefix paragraph (when the user's Custom instruction
// produced an answer above the bullets), then one bulleted_list_item per
// summary bullet.
function buildNotionBlocks() {
  const title = info.title || 'Untitled video';
  const { prefix, bullets } = parseSummaryResponse(lastSummary);
  const blocks = [
    {
      object: 'block',
      type: 'heading_2',
      heading_2: {
        rich_text: [{ type: 'text', text: { content: title.slice(0, 1900) } }],
      },
    },
    {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: pageUrl, link: { url: pageUrl } } }],
      },
    },
  ];

  if (prefix) {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: prefix.slice(0, 1900) } }],
      },
    });
  }

  for (const b of bullets) {
    blocks.push({
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: {
        // 2000-char cap per Notion rich_text content; clamp defensively.
        rich_text: [{ type: 'text', text: { content: b.slice(0, 1900) } }],
      },
    });
  }
  return blocks;
}

// --------------------------------------------------------------------------
// Per-URL summary cache. Last 20 summaries persist to chrome.storage.local
// keyed by a normalised URL so the same video/page restores its previous
// summary on popup open. Trims oldest entries when the cap is exceeded.
// --------------------------------------------------------------------------
const SUMMARY_HISTORY_CAP = 20;

// Strip tracking junk so /watch?v=abc&utm_source=… and the bare URL don't
// fragment the cache. YouTube watch pages keep just `?v=`; everything else
// keeps origin + pathname (no query, no hash).
function cacheKeyForUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.hostname === 'www.youtube.com' && u.pathname === '/watch') {
      const v = u.searchParams.get('v');
      return v ? `https://www.youtube.com/watch?v=${v}` : u.origin + u.pathname;
    }
    return u.origin + u.pathname;
  } catch {
    return rawUrl || '';
  }
}

async function saveSummaryToHistory() {
  if (!lastSummary || !pageUrl) return;
  const key = cacheKeyForUrl(pageUrl);
  if (!key) return;
  const { summaryHistory = {} } = await chrome.storage.local.get('summaryHistory');
  summaryHistory[key] = {
    summary: lastSummary,
    title: info.title || '',
    ts: Date.now(),
    mode,
  };
  // Cap to the most recent N entries. Sort by ts desc, keep the head.
  const entries = Object.entries(summaryHistory)
    .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0))
    .slice(0, SUMMARY_HISTORY_CAP);
  await chrome.storage.local.set({ summaryHistory: Object.fromEntries(entries) });
}

// Look up a cached summary for the current URL and render it. Called from the
// end of init()/initPageMode() — segments (YouTube) are loaded by then, so
// timestamp chips can validate against the actual transcript.
async function restoreCachedSummary() {
  if (!pageUrl) return;
  const key = cacheKeyForUrl(pageUrl);
  if (!key) return;
  const { summaryHistory = {} } = await chrome.storage.local.get('summaryHistory');
  const entry = summaryHistory[key];
  if (!entry || !entry.summary) return;
  // Only restore an entry that matches the current popup mode — a cached
  // page summary on a YouTube URL would render without working chips.
  if (entry.mode && entry.mode !== mode) return;

  lastSummary = entry.summary;
  renderSummary(entry.summary, { meta: `Previous summary from ${relativeTime(entry.ts)}` });
  summarySection.hidden = false;
}

function relativeTime(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// --------------------------------------------------------------------------
// DeepSeek balance pill. Only DeepSeek exposes a public balance endpoint;
// other providers don't, so the pill stays hidden for them. Cached for 60 s
// in chrome.storage.local so reopening the popup doesn't hammer the endpoint.
// --------------------------------------------------------------------------
const BALANCE_TTL_MS = 60_000;     // 60 s cache freshness window
const BAL_THRESH_LOW = 0.20;       // < 20¢ → red
const BAL_THRESH_WARN = 0.50;      // 20–50¢ → amber; ≥ 50¢ → default colour

async function refreshBalance({ force = false } = {}) {
  const { llmProvider, llmKey, dsBalance } = await chrome.storage.local.get(
    ['llmProvider', 'llmKey', 'dsBalance']
  );
  const provider = llmProvider || DEFAULT_PROVIDER;
  const key = (llmKey || '').trim();

  // Pill only makes sense for DeepSeek — hide otherwise.
  if (provider !== 'deepseek' || !key) {
    balanceEl.hidden = true;
    return;
  }

  // Show cached value immediately if fresh and tied to the same key. Avoids a
  // blank pill while the network round-trip is in flight.
  const keyTag = key.slice(-6);
  const cacheFresh = dsBalance
    && dsBalance.keyTag === keyTag
    && (Date.now() - dsBalance.ts) < BALANCE_TTL_MS;
  if (cacheFresh && !force) {
    renderBalance(dsBalance.amount, dsBalance.currency);
    return;
  }
  if (dsBalance && dsBalance.keyTag === keyTag) {
    // Render stale value while we refetch so the pill doesn't flicker empty.
    renderBalance(dsBalance.amount, dsBalance.currency);
  }

  try {
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    // Prefer USD when present, otherwise the first listed currency entry.
    const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
    const pick = infos.find(b => (b.currency || '').toUpperCase() === 'USD') || infos[0];
    if (!pick) throw new Error('no balance');
    const amount = parseFloat(pick.total_balance);
    const currency = (pick.currency || 'USD').toUpperCase();
    if (!Number.isFinite(amount)) throw new Error('bad amount');

    renderBalance(amount, currency);
    await chrome.storage.local.set({
      dsBalance: { amount, currency, keyTag, ts: Date.now() },
    });
  } catch (e) {
    // Quiet failure — keep any stale value visible; if nothing to show, mute it.
    if (balanceEl.hidden) {
      balanceEl.hidden = false;
      balanceEl.textContent = '—';
      balanceEl.className = 'bal-err';
    }
  }
}

// USD shown with $; everything else falls back to a "12.34 CNY" form so the
// thresholds (which are USD-shaped) don't silently mislead non-USD users.
function renderBalance(amount, currency) {
  balanceEl.hidden = false;
  balanceEl.textContent = currency === 'USD'
    ? `$${amount.toFixed(2)}`
    : `${amount.toFixed(2)} ${currency}`;
  let cls = '';
  if (amount < BAL_THRESH_LOW) cls = 'bal-low';
  else if (amount < BAL_THRESH_WARN) cls = 'bal-warn';
  balanceEl.className = cls;
}

// Runs in the page (MAIN world) via chrome.scripting.executeScript. Fetches the
// caption track from the player response. YouTube gates the caption endpoint
// behind a proof-of-origin token, so it briefly toggles the CC button to make
// the player fetch captions and reads that token out of the Performance API,
// then fetches the track (json3, then xml). Falls back to reading a transcript
// already rendered on the page. No panel, no description expand, no scroll.
// Returns { segments, info } or { error, debug }. Errors: no-button (no
// captions), panel-empty (couldn't get the caption data).
async function scrapePage() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const debug = {};

  const getResponse = () => {
    let r;
    try { r = document.getElementById('movie_player')?.getPlayerResponse?.(); } catch (e) {}
    return r || window.ytInitialPlayerResponse;
  };

  // SPA wait — until the player's videoId matches the URL's ?v= so a just-
  // navigated tab never hands back the previous video's captions.
  const urlVid = new URL(location.href).searchParams.get('v');
  if (urlVid) {
    const started = Date.now();
    while (Date.now() - started < 5000) {
      if (getResponse()?.videoDetails?.videoId === urlVid) break;
      await sleep(100);
    }
  }

  const response = getResponse();

  const pad = n => String(n).padStart(2, '0');
  const secsToStamp = secs => {
    const h = Math.floor(secs / 3600), mn = Math.floor((secs % 3600) / 60), sc = secs % 60;
    return h > 0 ? `${h}:${pad(mn)}:${pad(sc)}` : `${mn}:${pad(sc)}`;
  };
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();

  // Pick a caption track: manual + English, then manual any-lang, then English
  // ASR, then first available.
  const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  debug.trackCount = tracks.length;
  if (!tracks.length) return { error: 'no-button', debug };

  const isEnglish = t => (t.languageCode || '').toLowerCase().startsWith('en');
  const isManual  = t => t.kind !== 'asr';
  const track = tracks.find(t => isManual(t) && isEnglish(t)) ||
    tracks.find(isManual) || tracks.find(isEnglish) || tracks[0];

  const parseJson3 = (txt) => (JSON.parse(txt).events || []).map(ev => ({
    timestamp: secsToStamp(Math.floor((ev.tStartMs || 0) / 1000)),
    text: clean((ev.segs || []).map(s => s.utf8 || '').join('')),
  })).filter(s => s.text);
  const parseXml = (txt) => {
    const doc = new DOMParser().parseFromString(txt, 'text/xml');
    return [...doc.querySelectorAll('text')].map(n => ({
      timestamp: secsToStamp(Math.floor(parseFloat(n.getAttribute('start') || '0'))),
      text: clean(n.textContent),
    })).filter(s => s.text);
  };

  // YouTube gates the caption endpoints behind a proof-of-origin (POT) token.
  // Read the one the player itself uses: toggle the CC (subtitles) button so the
  // player fetches captions, then pull the pot out of the timedtext request the
  // browser recorded in the Performance API. Restore the CC state afterwards.
  const readPot = async (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        const e = performance.getEntriesByType('resource')
          .filter(x => x.name.includes('/api/timedtext?')).pop();
        if (e) { const p = new URL(e.name).searchParams.get('pot'); if (p) return p; }
      } catch (x) {}
      await sleep(50);
    }
    return '';
  };
  const CC_SELS = ['button.ytp-subtitles-button.ytp-button', '.ytp-subtitles-button',
    "button[aria-label*='Captions']", "button[aria-label*='captions']",
    "button[aria-label*='Subtitles']", "button[aria-label*='subtitles']"];
  const ccOn = (b) => !!b && (b.getAttribute('aria-pressed') === 'true' ||
    b.classList.contains('ytp-button-active') ||
    /captions off|subtitles off/i.test(b.getAttribute('aria-label') || ''));
  let pot = await readPot(400);  // maybe the player already fetched captions
  if (!pot) {
    try {
      const cc = CC_SELS.map(s => document.querySelector(s)).find(Boolean);
      debug.ccBtn = !!cc;
      if (cc) {
        performance.clearResourceTimings();
        const wasOn = ccOn(cc);
        if (wasOn) { cc.click(); await sleep(120); cc.click(); } else { cc.click(); }
        pot = await readPot(2500);
        if (!wasOn) { try { if (ccOn(cc)) cc.click(); } catch (e) {} }  // turn back off
      }
    } catch (e) {}
  }
  debug.havePot = !!pot;
  const potQ = pot ? `&pot=${encodeURIComponent(pot)}&c=WEB` : '';

  // Fetch the caption track: json3, then raw XML.
  const sep = track.baseUrl.includes('?') ? '&' : '?';
  const attempts = [
    { fmt: 'json3', url: `${track.baseUrl}${sep}fmt=json3${potQ}`, parse: parseJson3 },
    { fmt: 'xml',   url: `${track.baseUrl}${potQ}`,                parse: parseXml },
  ];
  debug.fetches = [];
  let raw = null;
  for (const a of attempts) {
    try {
      const r = await fetch(a.url, { credentials: 'include' });
      const t = await r.text();
      debug.fetches.push({ fmt: a.fmt, status: r.status, len: t.length });
      if (r.ok && t) { const segs = a.parse(t); if (segs.length) { raw = segs; break; } }
    } catch (e) { debug.fetches.push({ fmt: a.fmt, err: String((e && e.message) || e) }); }
  }

  // Fallback: the silent fetch was empty (YouTube gates it). Open the transcript
  // the way a person does and read it: expand the description, click "Show
  // transcript", wait for the lines to render. The page never moves: no
  // scrollIntoView, and the scroll position is pinned back on every poll.
  if (!raw || !raw.length) {
    debug.domSegNodes = 0;
    const stampRe = /^(\d{1,2}:\d{2}(?::\d{2})?)[\s ]+([\s\S]+)$/;
    const readNode = (seg) => {
      let ts = clean(seg.querySelector(
        '.ytwTranscriptSegmentViewModelTimestamp, .segment-timestamp, [class*="imestamp"]')?.textContent || '');
      let tx = clean(seg.querySelector(
        'span[role="text"], .segment-text, yt-formatted-string.segment-text, [class*="nippet"]')?.textContent || '');
      if (!tx) {
        const whole = clean(seg.textContent);
        const mm = whole.match(stampRe);
        if (mm) { ts = ts || mm[1]; tx = mm[2]; } else { tx = whole; }
      }
      return { timestamp: ts, text: tx };
    };
    // Known segment elements first (cheap + clean), broadest last.
    const SEG_SELS = ['ytd-transcript-segment-renderer', 'transcript-segment-view-model', '[class*="ranscriptSegment"]'];
    const readDom = () => {
      for (const sel of SEG_SELS) {
        const n = document.querySelectorAll(sel);
        if (n.length) {
          const segs = [...n].map(readNode).filter(s => s.text);
          if (segs.length) { debug.usedSel = sel; debug.domSegNodes = n.length; return segs; }
        }
      }
      return null;
    };

    let domSegs = readDom();  // reads the transcript if it is rendered on the page

    // Tag-agnostic catch-all + triage: parse the transcript container's
    // innerText (timestamp + line), and record what's actually inside it so any
    // remaining miss is diagnosable.
    if (!domSegs) {
      const container = document.querySelector(
        'ytd-transcript-segment-list-renderer, ytd-transcript-renderer, ytd-transcript-search-panel-renderer')
        || [...document.querySelectorAll('[target-id]')].find(p => /transcript/i.test(p.getAttribute('target-id') || ''));
      debug.hasContainer = !!container;
      if (container) {
        debug.childTags = [...new Set([...container.querySelectorAll('*')].map(e => e.tagName.toLowerCase()))].slice(0, 25);
        const txt = container.innerText || '';
        debug.containerTextLen = txt.length;
        const out = [];
        const re = /(\d{1,2}:\d{2}(?::\d{2})?)[\s \n]+([^\n]+)/g;
        let mm; while ((mm = re.exec(txt))) { const t = clean(mm[2]); if (t) out.push({ timestamp: mm[1], text: t }); }
        if (out.length) domSegs = out;
      }
    }

    if (domSegs && domSegs.length) raw = domSegs;
  }

  if (!raw || !raw.length) return { error: 'panel-empty', debug };

  // Dedupe adjacent exact repeats (ASR rolling captions repeat lines).
  const segments = [];
  for (const cur of raw) {
    const prev = segments[segments.length - 1];
    if (prev && prev.text === cur.text) continue;
    segments.push(cur);
  }

  // Metadata from the player response.
  const v = response?.videoDetails || {};
  const m = response?.microformat?.playerMicroformatRenderer || {};
  const lengthSec = parseInt(v.lengthSeconds, 10);
  const info = {
    title: clean(v.title || document.title.replace(/ - YouTube$/, '')),
    channel: clean(v.author || ''),
    duration: Number.isFinite(lengthSec) ? secsToStamp(lengthSec) : '',
    published: (m.publishDate || '').slice(0, 10),
  };

  return { segments, info };
}
