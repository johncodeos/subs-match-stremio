import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseOffset } from './confirmations.js';
import { installPath, validPassword, verifyInstallationPassword } from './installation.js';
import { diagnosticsName, emptyResult, shortlistLimit, subtitleSelection } from './lookup.js';
import { matchReason, parseVideoId, streamMatchDescription } from './match.js';
import { InvalidSettings, fields, isLive, matchLabelPositions, setupRequirements } from './settings.js';

const maxFormSize = 32 * 1024;
const fieldsScript = readFileSync(new URL('./configure-fields.js', import.meta.url));
const exactMatchExamples = Object.fromEntries(Object.keys(matchLabelPositions).map((position) => [
  position, streamMatchDescription('Example Movie (2026) · 2160p WEB-DL\n4.56 GB', { score: 2 }, position)
]));
const headers = {
  'Cache-Control': 'no-store',
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; img-src 'self'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  // Chrome needs the same-origin Origin header on an HTML form POST.
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff'
};

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function streamField(name, value, help) {
  return `<div class="field">
    <div class="label-line"><label for="${name}">${fields[name]}</label>${value ? '<span class="saved-tag">Saved</span>' : ''}</div>
    <textarea id="${name}" name="${name}" rows="3" wrap="soft" maxlength="4096"
      data-saved="${Boolean(value)}" placeholder="https://example.com/manifest.json" autocomplete="off" autocapitalize="off"
      spellcheck="false" aria-describedby="help-${name}">${escapeHtml(value)}</textarea>
    <p class="help" id="help-${name}">${help}</p>
  </div>`;
}

function apiKeyField(name, settings, help) {
  const saved = Boolean(settings[name]);
  return `<div class="field">
    <div class="label-line"><label for="${name}">${fields[name]}</label>${saved ? '<span class="saved-tag">Saved</span>' : ''}</div>
    <div class="secret-input">
      <input id="${name}" name="${name}" type="password" maxlength="256"
        data-saved="${saved}" placeholder="${saved ? '••••••••••••' : 'Paste here'}"
        autocomplete="new-password" autocapitalize="off" spellcheck="false" aria-describedby="help-${name}">
      <button type="button" class="visibility-toggle" aria-controls="${name}" aria-label="Show ${fields[name]}"
        title="Show ${fields[name]}" hidden>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/>
          <circle cx="12" cy="12" r="2.7"/>
          <path class="eye-slash" d="m3 3 18 18"/>
        </svg>
      </button>
    </div>
    <p class="help" id="help-${name}">${help}</p>
    <p class="field-error" id="error-${name}" role="alert"></p>
  </div>`;
}

function layout(title, content, basePath = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Greek Sub Match</title>
<link rel="icon" type="image/png" href="${basePath}/addon-icon.png">
<style>
:root{
  color-scheme:dark;
  --bg:#051326;--surface:#0a203b;--field:#081a30;--tint:#102d50;
  --line:#254667;--field-line:#567598;--text:#f9fbff;--muted:#c1d4ed;
  --accent:#8bc6ff;--brand:#075dbd;--brand-hover:#1069cd;
}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(ellipse 42rem 36rem at 50% 0,#073a74 0,transparent 100%),var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif}
main{max-width:760px;margin:auto;padding:52px 28px 38px}
header{margin-bottom:24px}
.brand{display:flex;align-items:center;gap:16px}
.brand img{width:64px;height:64px;flex:none}
h1{margin:0 0 6px;font-size:clamp(29px,5vw,42px);line-height:1.14;letter-spacing:-.035em}
h2{margin:0 0 5px;font-size:20px;letter-spacing:-.017em}
p{margin:0}
.sub,.help{color:var(--muted)}
.required-mark{color:var(--accent)}
.status{display:flex;gap:12px;align-items:baseline;margin-top:18px;padding:11px 14px;border:1px solid var(--line);border-radius:10px;background:var(--tint)}
.mode{white-space:nowrap;color:var(--accent)}
section{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:22px;margin:0 0 16px}
.field{margin-top:17px}
.label-line{display:flex;gap:8px;align-items:center;margin-bottom:6px}
label{font-weight:600}
input[type=password],input[type=text],input[type=number],select,textarea{display:block;width:100%;height:44px;color:var(--text);background:var(--field);border:1px solid var(--field-line);border-radius:8px;padding:0 12px;font:inherit}
textarea{height:auto;min-height:5.5rem;padding:10px 12px;resize:vertical;overflow-wrap:anywhere}
input::placeholder,textarea::placeholder{color:#a9c1df}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.help{font-size:13px;margin-top:5px}
.stream-steps{color:var(--muted);font-size:14px;margin:10px 0 0;padding-inline-start:1.35rem}
.stream-steps li + li{margin-top:5px}
.stream-steps strong,.stream-steps code{color:var(--text)}
.stream-steps code{overflow-wrap:anywhere}
a{color:var(--accent);text-underline-offset:3px}
.saved-tag{font-size:12px;color:var(--accent)}
.notice{margin:0 0 16px;border-radius:8px;padding:10px 14px;border:1px solid var(--field-line);background:var(--tint)}
.error{border-color:#b76b71;background:#3c252e}
button{color:var(--text);background:var(--brand);border:1px solid #4084d2;border-radius:8px;padding:11px 18px;font:inherit;font-weight:700;cursor:pointer}
button:hover{background:var(--brand-hover)}
.install-section{margin-top:20px}
.install-actions{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}
.install-link{display:inline-flex;align-items:center;padding:11px 18px;border-radius:8px;background:var(--brand);color:var(--text);border:1px solid #4084d2;text-decoration:none;font-weight:700}
.install-link:hover{background:var(--brand-hover)}
.sign-out{margin-top:8px}
.sign-out button{padding:5px 10px;font-size:13px}
.secret-input{position:relative}
.secret-input input{padding-inline-end:52px}
.visibility-toggle{position:absolute;inset-block:3px;inset-inline-end:3px;width:40px;padding:0;border:0;background:transparent;color:var(--muted)}
.visibility-toggle:hover{background:var(--tint);color:var(--text)}
.visibility-toggle:disabled{opacity:.55;cursor:wait}
.visibility-toggle svg{display:block;width:22px;height:22px;margin:auto}
.visibility-toggle[aria-label^="Show "] .eye-slash{display:none}
.field-error{margin-top:5px;color:#ffb8be;font-size:13px}
.field-error:empty{display:none}
.check-link{display:inline-block;margin-top:12px}
.summary{display:flex;gap:22px;flex-wrap:wrap;margin:4px 0 12px}
.summary dt{color:var(--muted);font-size:13px}
.summary dd{margin:0;font-size:24px;font-weight:700}
.release{overflow-wrap:anywhere}
.label-position{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
.stream-preview{min-width:0;margin:0;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--field)}
.stream-preview figcaption{color:var(--muted);font-size:13px;margin-bottom:4px}
.stream-preview pre{margin:0;font:inherit;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere}
.match-detail{display:block;padding:12px 0 0;font-size:14px}
.timing{display:flex;align-items:end;gap:10px;flex-wrap:wrap;margin-top:10px}
.timing label{font-size:13px}
.timing input{width:7rem;height:38px}
.timing button{padding:8px 11px}
.secondary{background:var(--tint);color:var(--text);border-color:var(--field-line)}
.secondary:hover{background:#173d67}
@media(max-width:480px){main{padding:30px 16px}section{padding:17px}.brand{gap:12px}.brand img{width:48px;height:48px}.label-position{grid-template-columns:1fr;gap:10px}.status{display:block}.mode{display:block}}
</style>
</head>
<body>
<main>
${content}
</main>
</body>
</html>`;
}

function installSection(config) {
  if (!config.installation) return '';
  const url = config.publicUrl + installPath(config.installation) + '/manifest.json';
  const safeUrl = escapeHtml(url);
  const installUrl = escapeHtml(url.replace(/^https?:\/\//, 'stremio://'));
  return `<section class="install-section" aria-labelledby="install-addon">
    <h2 id="install-addon">Install in Stremio</h2>
    <p class="help">Use the install button in the Stremio app, or copy the link into <strong>Addons → Add addon</strong> in Stremio Web. Keep this link private.</p>
    <div class="install-actions">
      <a class="install-link" href="${installUrl}">Install in Stremio</a>
      <button type="button" class="secondary" id="copy-install-link" hidden>Copy install link</button>
    </div>
    <label for="install-manifest">Private install link</label>
    <input type="text" id="install-manifest" value="${safeUrl}" readonly spellcheck="false">
    <p id="copy-install-status" class="help" role="status"></p>
  </section>`;
}

function page(config, csrf, { error = '', saved = false, basePath = '', signup = false } = {}) {
  const { settings } = config;
  const live = isLive(config);
  const ready = live ? 'Ready to match Greek subtitles for movies and episodes.'
    : 'Add a stream add-on link and at least one subtitle API key to start matching your library.';
  return layout('Configure', `<header>
  <div class="brand">
    <img src="${basePath}/addon-icon.png" alt="" width="64" height="64">
    <div>
      <h1>Greek Sub Match</h1>
      <p class="sub">Configure sources for Greek subtitle matching in Stremio.</p>
    </div>
  </div>
  ${signup ? '' : `<a class="check-link" href="${basePath}/configure/check">Check a movie or episode</a>`}
  ${basePath && !signup ? `<form class="sign-out" method="post" action="${basePath}/configure/logout">
    <input type="hidden" name="csrf" value="${csrf}">
    <button class="secondary" type="submit">Lock Configure</button>
  </form>` : ''}
  <p class="status"><strong class="mode">${live ? 'Live mode' : 'Setup needed'}</strong><span>${ready}</span></p>
</header>
${error ? `<p class="notice error" role="alert">${escapeHtml(error)}</p>`
    : saved ? '<p class="notice" role="status">Settings saved. They apply to the next stream search.</p>' : ''}
<form id="configure-settings" method="post" action="${basePath}/configure" autocomplete="off">
  <script src="${basePath}/configure/fields.js" defer></script>
  <input type="hidden" name="csrf" value="${csrf}">
  <section aria-labelledby="streams" data-required-message="${setupRequirements.streams}">
    <h2 id="streams">Stream sources <span class="required-mark" aria-hidden="true">*</span></h2>
    <p class="help">${signup ? 'Add at least one public HTTPS stream add-on link.' : 'At least one stream add-on link is required. Greek Sub Match checks subtitles against the playable streams from your source add-on.'}</p>
    <p class="field-error" role="alert" data-required-error></p>
    <ol class="stream-steps">
      <li>In Stremio, go to <strong>Addons → Installed</strong> and find the add-on you use to get playable movie or series streams.</li>
      <li>Select <strong>Share addon</strong> and copy its link. You can also copy the install link from that add-on’s own setup page.</li>
      <li>Paste the full link in the first field. It should look like <code>https://example.com/manifest.json</code>.</li>
    </ol>
    ${streamField('STREAM_ADDON_MANIFEST', settings.STREAM_ADDON_MANIFEST, 'Paste one install link for the add-on that supplies your streams.')}
    ${streamField('STREAM_ADDON_MANIFEST_2', settings.STREAM_ADDON_MANIFEST_2, 'Paste one install link if you also want to check streams from a second add-on.')}
  </section>
  <section aria-labelledby="providers" data-required-message="${setupRequirements.providers}">
    <h2 id="providers">Subtitle providers <span class="required-mark" aria-hidden="true">*</span></h2>
    <p class="help">At least one API key is required. OpenSubtitles downloads use its anonymous quota.</p>
    <p class="field-error" role="alert" data-required-error></p>
    ${apiKeyField('SUBDL_API_KEY', settings, '<a href="https://subdl.com/api-doc" target="_blank" rel="noreferrer">Get a SubDL API key</a>')}
    ${apiKeyField('OPENSUBTITLES_API_KEY', settings, '<a href="https://www.opensubtitles.com/en/consumers" target="_blank" rel="noreferrer">Create an OpenSubtitles API key</a>')}
    ${apiKeyField('SUBSOURCE_API_KEY', settings, 'Create a key in your SubSource account under API &amp; Plans. <a href="https://subsource.net/api-docs" target="_blank" rel="noreferrer">SubSource API instructions</a>')}
  </section>
  <section aria-labelledby="stream-list">
    <h2 id="stream-list">Stream list</h2>
    <label for="STREAM_LIST">Results to show in Stremio</label>
    <select id="STREAM_LIST" name="STREAM_LIST">
      <option value="shortlist" ${config.shortlist ? 'selected' : ''}>Greek shortlist</option>
      <option value="all" ${config.shortlist ? '' : 'selected'}>All streams, Greek matches first</option>
    </select>
    <p class="help">The shortlist shows up to ${shortlistLimit} matches. If no release matches, Stremio shows a message with a link to check the title.</p>
    <div class="field label-position">
      <div>
        <label for="EXACT_MATCH_POSITION">Exact and likely match label position</label>
        <select id="EXACT_MATCH_POSITION" name="EXACT_MATCH_POSITION">
          ${Object.entries(matchLabelPositions).map(([value, label]) =>
            `<option value="${value}"${config.matchLabelPosition === value ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
      </div>
      <figure class="stream-preview">
        <figcaption>Stream preview</figcaption>
        <pre id="match-label-preview" aria-live="polite" aria-atomic="true" data-examples="${escapeHtml(JSON.stringify(exactMatchExamples))}">${escapeHtml(exactMatchExamples[config.matchLabelPosition])}</pre>
      </figure>
    </div>
  </section>
  <section aria-labelledby="configuration-password">
    <h2 id="configuration-password">Configuration password</h2>
    <p class="help">${signup ? 'You’ll use this password to reopen your saved settings from Stremio.'
      : config.installation ? 'Set a new password if you want to change how you unlock Configure.'
        : 'Choose a password to create a private install link and edit these settings later from Stremio.'}</p>
    <div class="field">
      <label for="install-password">${config.installation ? 'New password (optional)' : 'Private installation password'}</label>
      <input type="password" name="install_password" id="install-password" minlength="12" maxlength="256"
        autocomplete="new-password" aria-describedby="install-password-help"${signup ? ' required' : ''}>
      <p class="help" id="install-password-help">Use at least 12 characters.</p>
    </div>
  </section>
  <button type="submit">${signup ? 'Create install link' : 'Save settings'}</button>
</form>
${installSection(config)}
`, basePath);
}

function parseCheckTarget(value) {
  let id = value.trim();
  if (id.startsWith('https://web.stremio.com/')) {
    const hash = new URL(id).hash;
    const route = /^#\/detail\/(?:movie|series)\/([^/?]+)(?:\/([^/?]+))?/.exec(hash);
    if (!route) return null;
    try {
      id = decodeURIComponent(route[2] ?? route[1]);
    } catch {
      return null;
    }
  }
  for (const type of ['series', 'movie']) {
    if (parseVideoId(type, id)) return { type, id };
  }
  return null;
}

function timingForm(row, match, report, id, csrf, tools, basePath) {
  if (!row.fileKey || !tools.confirmations) return '';
  const selection = subtitleSelection(match, report.video);
  const token = tools.token({ fileKey: row.fileKey, id, selection });
  const confirmed = match.score === 4;
  return `<form class="timing" method="post" action="${basePath}/configure/check">
    <input type="hidden" name="csrf" value="${csrf}">
    <input type="hidden" name="token" value="${token}">
    <label>Delay in seconds <input type="number" name="offset" min="-600" max="600" step="0.001" value="${(selection.offsetMs ?? 0) / 1000}"></label>
    <button type="submit" name="action" value="confirm">${confirmed ? 'Update confirmed timing' : 'Timing is good'}</button>
    ${confirmed ? '<button class="secondary" type="submit" name="action" value="remove" formnovalidate>Remove confirmation</button>' : ''}
  </form>`;
}

function diagnostics(report, id, csrf, tools, basePath) {
  const count = report.matchedRows.length;
  const providers = report.sets.map(({ provider, candidates, available, extraFailed }) => {
    const files = new Set(candidates.map((candidate) => candidate.fileId ?? candidate.path)).size;
    const result = available ? `${files} Greek subtitle files${extraFailed ? ' · extra search failed' : ''}` : 'unavailable';
    return `<li>${escapeHtml(provider.name)} · ${result}</li>`;
  }).join('');
  const status = count ? '' : emptyResult(report).detail;
  return `<section>
    <h2>Results for ${escapeHtml(id)}</h2>
    <dl class="summary">
      <div><dt>Distinct streams</dt><dd>${report.rows.length}</dd></div>
      <div><dt>Greek matches</dt><dd>${count}</dd></div>
      <div><dt>Playable streams shown</dt><dd>${report.selected.length}</dd></div>
    </dl>
    <ul>${providers}</ul>
    ${report.searchedMore ? '<p class="help">An additional subtitle search was run for this title.</p>' : ''}
    ${status ? `<p role="status">${status}</p>` : '<p class="help">After checking playback, use the File ID on the Greek subtitle label to find the same stream here. Positive delay shows subtitles later and negative delay shows them earlier.</p>'}
  </section>
  ${report.matchedRows.slice(0, shortlistLimit).map((row) => `<section>
    <h2 class="release">${escapeHtml(diagnosticsName(row.stream))}</h2>
    ${row.fileKey ? `<p class="help">File ID ${row.fileKey.slice(0, 8).toUpperCase()}</p>` : ''}
    ${row.matches.map((match) => `<div class="match-detail">
      <strong>${escapeHtml(matchReason(match))}</strong> · ${escapeHtml(match.provider.name)}
      <p class="help release">${escapeHtml(match.release)}</p>
      ${timingForm(row, match, report, id, csrf, tools, basePath)}
    </div>`).join('')}
  </section>`).join('')}`;
}

async function checkPage(store, csrf, url, tools, basePath, error = '') {
  const id = (url.searchParams.get('id') ?? '').trim().slice(0, 350);
  const target = id && parseCheckTarget(id);
  const live = isLive(store.get());
  const report = target && live && await tools.lookup(target.type, target.id);
  const issue = error || (id && !target ? 'Enter an IMDb or TMDB ID, or paste a Stremio movie or episode link.'
    : id && !live ? 'Save a stream source and subtitle API key in Configure first.' : '');
  return layout('Check a title', `<header>
  <a href="${basePath}/configure">Back to Configure</a>
  <h1>Check a movie or episode</h1>
</header>
${issue ? `<p class="notice error" role="alert">${escapeHtml(issue)}</p>`
    : url.searchParams.get('timing') === 'saved' ? '<p class="notice" role="status">Confirmed timing saved.</p>'
      : url.searchParams.get('timing') === 'removed' ? '<p class="notice" role="status">Timing confirmation removed.</p>' : ''}
<form class="field" action="${basePath}/configure/check" method="get">
  <label for="id">Stremio link or title ID</label>
  <input id="id" type="text" name="id" value="${escapeHtml(id)}" maxlength="350" autocomplete="off" required>
  <p class="help">Example movie tt33764258 or episode tt0903747:1:1.</p>
  <p class="field"><button type="submit">Check title</button></p>
</form>
<div class="field">
${report ? diagnostics(report, target.id, csrf, tools, basePath) : ''}
</div>`, basePath);
}

export function localOrigin(req) {
  if (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.remoteAddress)) return null;
  if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(req.headers.host ?? '')) return null;
  try {
    return new URL('http://' + req.headers.host).origin;
  } catch {
    return null;
  }
}

function isConfigurePost(req, origin) {
  return req.headers.origin === origin &&
    req.headers['content-type']?.split(';')[0] === 'application/x-www-form-urlencoded';
}

function formSettings(form) {
  const patch = {};
  for (const name of Object.keys(fields)) {
    const value = form.get(name)?.trim();
    if (value) patch[name] = value;
    else if (form.get('clear_' + name) === '1') patch[name] = '';
  }
  if (form.has('STREAM_LIST')) patch.STREAM_LIST = form.get('STREAM_LIST');
  if (form.has('EXACT_MATCH_POSITION')) patch.EXACT_MATCH_POSITION = form.get('EXACT_MATCH_POSITION');
  return patch;
}

function writePage(res, status, body, type = headers['Content-Type']) {
  res.writeHead(status, { ...headers, 'Content-Type': type });
  res.end(body);
}

async function readForm(req) {
  const parts = [];
  let length = 0;
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    length += part.length;
    if (length > maxFormSize) {
      req.resume();
      throw new InvalidSettings('Settings exceed the maximum allowed size.');
    }
    parts.push(part);
  }
  return new URLSearchParams(Buffer.concat(parts).toString('utf8'));
}

function unlockPage(basePath, csrf, { error = '', id = '' } = {}) {
  return layout('Unlock Configure', `<header>
  <div class="brand">
    <img src="${basePath}/addon-icon.png" alt="" width="64" height="64">
    <div><h1>Unlock Configure</h1><p class="sub">Enter the password you set when installing Greek Sub Match.</p></div>
  </div>
</header>
${error ? `<p class="notice error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="${basePath}/configure">
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="login" value="1">
  <input type="hidden" name="id" value="${escapeHtml(id)}">
  <section>
    <label for="unlock-password">Configuration password</label>
    <input id="unlock-password" name="unlock_password" type="password" maxlength="256" autocomplete="current-password" required>
  </section>
  <button type="submit">Unlock</button>
</form>`, basePath);
}

const cookieName = 'greek_sub_match_session';
const sessionLifetime = 30 * 60_000;
const loginWindow = 5 * 60_000;

function sessionCookie(basePath, origin, value, maxAge) {
  const secure = origin.startsWith('https:') ? '; Secure' : '';
  return `${cookieName}=${value}; Path=${basePath}/configure; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure}`;
}

function redirect(res, location) {
  res.writeHead(303, { ...headers, Location: location });
  res.end();
}

export function createConfigureHandler(store, logger, tools) {
  const localCsrf = randomBytes(24).toString('base64url');
  const loginCsrf = randomBytes(24).toString('base64url');
  const sessions = new Map();
  let attempts = 0;
  let resetAt = 0;
  let verifying = false;

  function startSession(res, installedUrl, location = '/configure') {
    const basePath = installedUrl.pathname;
    for (const [key, value] of sessions) if (value.expires <= Date.now()) sessions.delete(key);
    if (sessions.size >= 12) sessions.delete(sessions.keys().next().value);
    const sessionId = randomBytes(32).toString('base64url');
    sessions.set(sessionId, {
      expires: Date.now() + sessionLifetime,
      hash: store.get().installation.hash,
      csrf: randomBytes(24).toString('base64url')
    });
    res.setHeader('Set-Cookie', sessionCookie(basePath, installedUrl.origin, sessionId, sessionLifetime / 1000));
    return redirect(res, `${basePath}${location}`);
  }

  const handle = async (req, res, url, installedUrl = null) => {
    const origin = installedUrl?.protocol === 'https:' && installedUrl.host === req.headers.host
      ? installedUrl.origin : localOrigin(req);
    if (!origin || !store) return writePage(res, 403, 'Open Configure from the add-on’s address or the host machine.');
    const basePath = installedUrl ? installedUrl.pathname : '';
    const installation = store.get().installation;
    const checking = url.pathname === '/configure/check';
    const revealing = url.pathname === '/configure/reveal';
    const loggingOut = url.pathname === '/configure/logout';
    const sessionId = req.headers.cookie?.match(/(?:^|;\s*)greek_sub_match_session=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
    const session = installedUrl ? sessions.get(sessionId) : null;
    const unlocked = session && session.expires > Date.now() && session.hash === installation?.hash;

    if (req.method === 'POST' && !isConfigurePost(req, origin)) {
      return writePage(res, 403, 'Open Configure and submit the form from there.');
    }

    if (installedUrl && !unlocked) {
      if (req.method === 'GET' && (url.pathname === '/configure' || checking)) {
        const id = checking ? (url.searchParams.get('id') ?? '').slice(0, 350) : '';
        return writePage(res, 200, unlockPage(basePath, loginCsrf, { id }));
      }
      if (req.method !== 'POST' || url.pathname !== '/configure') return writePage(res, 403, 'Unlock Configure first.');
      try {
        const form = await readForm(req);
        if (form.get('login') !== '1' || form.get('csrf') !== loginCsrf) {
          return writePage(res, 403, 'Reload Configure and unlock it again.');
        }
        const now = Date.now();
        if (now >= resetAt) {
          attempts = 0;
          resetAt = now + loginWindow;
        }
        const id = (form.get('id') ?? '').slice(0, 350);
        if (attempts >= 5 || verifying) {
          const seconds = verifying ? 1 : Math.max(1, Math.ceil((resetAt - now) / 1000));
          res.setHeader('Retry-After', String(seconds));
          return writePage(res, 429, unlockPage(basePath, loginCsrf,
            { id, error: 'Too many sign-in attempts. Wait and try again.' }));
        }
        attempts += 1;
        verifying = true;
        let accepted;
        try {
          accepted = await verifyInstallationPassword(form.get('unlock_password'), installation);
        } finally {
          verifying = false;
        }
        if (!accepted || store.get().installation?.hash !== installation.hash) {
          return writePage(res, 401, unlockPage(basePath, loginCsrf, { id, error: 'Incorrect password.' }));
        }
        attempts = 0;
        const target = id && parseCheckTarget(id);
        return startSession(res, installedUrl, target ? `/configure/check?${new URLSearchParams({ id: target.id })}` : '/configure');
      } catch (error) {
        if (!(error instanceof InvalidSettings)) logger.warn('Could not unlock Configure.');
        return writePage(res, error instanceof InvalidSettings ? 400 : 500, unlockPage(basePath, loginCsrf,
          { error: 'Could not unlock Configure. Try again.' }));
      }
    }

    const csrf = installedUrl ? session.csrf : localCsrf;
    if (url.pathname === '/configure/fields.js') {
      if (req.method !== 'GET') return writePage(res, 405, 'Use GET.');
      return writePage(res, 200, fieldsScript, 'text/javascript; charset=utf-8');
    }
    if ((revealing || loggingOut) && req.method !== 'POST') return writePage(res, 405, 'Use POST.');
    if (req.method === 'GET') {
      try {
        const html = checking ? await checkPage(store, csrf, url, tools, basePath)
          : page(store.get(), csrf, { saved: url.searchParams.get('saved') === '1', basePath });
        return writePage(res, 200, html);
      } catch {
        logger.warn('Could not check the title.');
        return writePage(res, 502, layout('Check a title', `<p role="alert">Could not check this title. Try again.</p><a href="${basePath}/configure/check">Back to title check</a>`, basePath));
      }
    }
    if (req.method !== 'POST') return writePage(res, 405, 'Use GET or POST.');
    let timingItem;
    try {
      const form = await readForm(req);
      if (form.get('csrf') !== csrf) return writePage(res, 403, 'Reload the settings page and try again.');

      if (loggingOut) {
        if (!installedUrl) return writePage(res, 404, 'Route not found.');
        sessions.delete(sessionId);
        res.setHeader('Set-Cookie', sessionCookie(basePath, origin, '', 0));
        return redirect(res, `${basePath}/configure`);
      }
      if (revealing) {
        const field = form.get('field');
        if (!Object.hasOwn(fields, field) || !field.endsWith('_API_KEY')) {
          return writePage(res, 400, 'Unknown API key field.');
        }
        return writePage(res, 200, JSON.stringify({ value: store.get().settings[field] }), 'application/json; charset=utf-8');
      }

      if (checking) {
        timingItem = tools.readToken(form.get('token') ?? '');
        const action = form.get('action');
        if (!tools.confirmations || !timingItem?.fileKey || !['confirm', 'remove'].includes(action)) {
          return writePage(res, 400, 'Check the title again before saving timing.');
        }
        const selection = action === 'confirm'
          ? { ...timingItem.selection, offsetMs: parseOffset(form.get('offset')) } : null;
        await tools.confirmations.save(timingItem.fileKey, selection);
        const query = new URLSearchParams({ id: timingItem.id, timing: selection ? 'saved' : 'removed' });
        return redirect(res, `${basePath}/configure/check?${query}`);
      }

      const password = form.get('install_password') ?? '';
      await store.save(formSettings(form), { password, authenticatedHash: session?.hash });
      if (password) {
        sessions.clear();
        attempts = 0;
      }
      const destination = password && !installation ? '#install-addon' : '';
      return redirect(res, `${basePath}/configure?saved=1${destination}`);
    } catch (error) {
      if (revealing) return writePage(res, error instanceof InvalidSettings ? 400 : 500, 'Could not load the saved value.');
      if (error instanceof InvalidSettings) {
        if (installedUrl && session.hash !== store.get().installation?.hash) return redirect(res, `${basePath}/configure`);
        if (checking) {
          if (timingItem) url.searchParams.set('id', timingItem.id);
          return writePage(res, 400, await checkPage(store, csrf, url, tools, basePath, error.message));
        }
        return writePage(res, 400, page(store.get(), csrf, { error: error.message, basePath }));
      }
      if (checking) {
        logger.warn('Could not save confirmed timing.');
        return writePage(res, 500, layout('Check a title', `<p role="alert">Could not save the timing on this server.</p><a href="${basePath}/configure/check">Back to title check</a>`, basePath));
      }
      logger.warn('Could not save local settings.');
      return writePage(res, 500, page(store.get(), csrf, { error: 'Could not save the settings. Try again.', basePath }));
    }
  };
  return { handle, startSession };
}

export function createSignupHandler(profiles, register, logger) {
  const csrf = randomBytes(24).toString('base64url');
  const address = new URL(profiles.blank.publicUrl);
  const basePath = address.pathname.replace(/\/$/, '');
  const signupWindow = 10 * 60_000;
  let attempts = 0;
  let resetAt = 0;

  return async (req, res, path) => {
    if (path === '/configure/fields.js') {
      return req.method === 'GET' ? writePage(res, 200, fieldsScript, 'text/javascript; charset=utf-8')
        : writePage(res, 405, 'Use GET.');
    }
    const show = (status, error = '') => writePage(res, status, page(profiles.blank, csrf, { basePath, signup: true, error }));
    if (req.method === 'GET') return show(200);
    if (req.method !== 'POST') return writePage(res, 405, 'Use GET or POST.');
    if (!isConfigurePost(req, address.origin)) return writePage(res, 403, 'Submit the form from Configure.');
    try {
      const form = await readForm(req);
      if (form.get('csrf') !== csrf) return writePage(res, 403, 'Reload Configure and try again.');
      const password = form.get('install_password');
      if (!validPassword(password)) return show(400, 'Use a configuration password of at least 12 characters and at most 256 bytes.');
      const now = Date.now();
      if (now >= resetAt) {
        attempts = 0;
        resetAt = now + signupWindow;
      }
      if (attempts >= 20) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetAt - now) / 1000))));
        return show(429, 'This server has received too many setup requests. Try again later.');
      }
      attempts += 1;
      const profile = await profiles.create(formSettings(form), password);
      const installedUrl = new URL(profiles.blank.publicUrl + installPath(profile.settings.get().installation));
      return register(profile).configure.startSession(res, installedUrl, '/configure?saved=1#install-addon');
    } catch (error) {
      if (error instanceof InvalidSettings) return show(400, error.message);
      logger.warn('Could not create an installation.');
      return show(500, 'Could not create your installation. Try again.');
    }
  };
}
