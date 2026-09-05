// Pilot — Job Board Grabber, popup.
//
// UI only. Every network call and page injection happens in background.js so
// that a grab keeps going after this popup closes (Chrome tears the popup down
// the moment it loses focus) and so there is exactly one copy of the parser.

const DEFAULT_BASE = 'https://pilot-78c.pages.dev';

const $ = (id) => document.getElementById(id);
const send = (msg) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (reply) => {
      // lastError fires when the worker was torn down mid-call; read it so
      // Chrome doesn't log it as unchecked, and report it as a normal failure.
      const err = chrome.runtime.lastError;
      resolve(err ? { error: 'Lost contact with the extension. Try again.' } : reply || {});
    });
  });

function msg(el, html, kind) {
  el.className = html ? `msg ${kind}` : '';
  el.innerHTML = html || '';
}

function show(view) {
  $('loginView').classList.toggle('hidden', view !== 'login');
  $('grabView').classList.toggle('hidden', view !== 'grab');
}

function busy(state) {
  $('grabBtn').disabled = state;
  $('autoBtn').disabled = state;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const hostOf = (url) => String(url || '').replace(/^https?:\/\//, '');

/** Who and where the grab view is acting as. The account is the useful half now
 *  that one dashboard serves several people, but a saved-passphrase-only upgrade
 *  has no email to show, so the host stays as the fallback. */
function identify(email, serverUrl) {
  const who = $('who');
  who.textContent = email || hostOf(serverUrl);
  who.title = email ? `${email} at ${hostOf(serverUrl)}` : hostOf(serverUrl);
  $('openApp').innerHTML = `<a href="${escapeHtml(serverUrl)}" target="_blank">Open the dashboard</a>`;
}

// The email is remembered across sign-out, so on most visits the passphrase is
// the only blank left and starting there saves a tab press.
const focusFirstEmptyField = () => ($('email').value ? $('passphrase') : $('email')).focus();

/** Turn a grab result into the three numbers the task asks for: how many
 *  companies we found, how many we sent, how many the dashboard skipped. */
function render(result) {
  const box = $('grabMsg');
  if (!result) return msg(box, '');
  if (result.error) return msg(box, escapeHtml(result.error), 'err');

  const { found = 0, sent = 0, saved = 0, skipped = 0, noCity = 0 } = result;
  if (found === 0) {
    return msg(
      box,
      'No usable contacts in the text on screen. Scroll so more posts are loaded, ' +
        'or these posts keep their contact behind an Apply button.',
      'info',
    );
  }
  if (sent === 0) {
    return msg(
      box,
      `Found ${plural(found, 'company')}, but none had a city Pilot tracks ` +
        '(Bengaluru, Pune, Lucknow, Noida/NCR or remote), so nothing was sent.',
      'info',
    );
  }

  const parts = [`Found <b>${plural(found, 'company')}</b>`, `sent <b>${sent}</b>`];
  if (noCity) parts.push(`${noCity} dropped (no city)`);
  parts.push(`${skipped} skipped by the dashboard`);
  msg(box, `${parts.join(' &middot; ')}. <b>${saved}</b> new ${saved === 1 ? 'row' : 'rows'} saved.`, 'ok');
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// While a background grab is in flight we have no response to wait on (the
// popup may not even have started it), so poll the worker's status instead.
let pollTimer = null;
function pollWhileRunning() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    const status = await send({ type: 'status' });
    if (status.running) {
      pollWhileRunning();
      return;
    }
    busy(false);
    render(status.lastResult);
  }, 1500);
}

// ── Boot ─────────────────────────────────────────────────────
(async function init() {
  const status = await send({ type: 'status' });
  $('serverUrl').value = status.serverUrl || DEFAULT_BASE;
  $('email').value = status.email || '';

  if (!status.signedIn) {
    show('login');
    if (status.needsEmail) {
      // Upgraded from the single-passphrase dashboard. Without this the popup
      // looks like it simply forgot the sign-in, and the obvious response -
      // retyping the same passphrase - is not the missing half.
      msg(
        $('loginMsg'),
        'The dashboard now signs you in by email. Add yours and confirm your passphrase to reconnect.',
        'info',
      );
    }
    focusFirstEmptyField();
    return;
  }

  identify(status.email, status.serverUrl || DEFAULT_BASE);
  show('grab');

  if (status.running) {
    busy(true);
    msg(
      $('grabMsg'),
      `<span class="spin"></span>${status.runningAuto ? 'Auto-scrolling and collecting' : 'Reading the page'}...`,
      'info',
    );
    pollWhileRunning();
  } else {
    render(status.lastResult);
  }
})();

// ── Sign in ──────────────────────────────────────────────────
$('loginBtn').addEventListener('click', async () => {
  const email = $('email').value.trim();
  const passphrase = $('passphrase').value;
  const serverUrl = ($('serverUrl').value.trim() || DEFAULT_BASE).replace(/\/+$/, '');
  if (!email) return msg($('loginMsg'), 'Enter the email you sign in to the dashboard with.', 'err');
  if (!passphrase) return msg($('loginMsg'), 'Enter your dashboard passphrase.', 'err');

  let origin;
  try {
    origin = new URL(serverUrl).origin + '/*';
  } catch {
    return msg($('loginMsg'), 'That dashboard URL is not a valid URL.', 'err');
  }

  $('loginBtn').disabled = true;
  msg($('loginMsg'), '<span class="spin"></span>Signing in...', 'info');
  try {
    // The default dashboard is in host_permissions already; any other URL needs
    // consent before we may talk to it. This must stay inside the click handler
    // because chrome.permissions.request requires a user gesture.
    const allowed = await chrome.permissions.contains({ origins: [origin] });
    if (!allowed) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        return msg($('loginMsg'), 'Permission for that dashboard URL was declined.', 'err');
      }
    }

    const res = await send({ type: 'login', email, passphrase, serverUrl });
    if (res.error) return msg($('loginMsg'), escapeHtml(res.error), 'err');

    identify(email, serverUrl);
    msg($('loginMsg'), '');
    $('passphrase').value = '';
    show('grab');

    // Both of these are "you are in, but read this" - collected so a login that
    // hits both does not show one warning and silently drop the other.
    const notes = [];

    // Signed in on the dashboard's bootstrap passphrase, which every account
    // seeded that way shares. Setting a real one is a dashboard-only operation;
    // the extension deliberately does not offer to do it from here.
    if (res.mustSetPassword) {
      notes.push(
        'You signed in with the dashboard\'s bootstrap passphrase and have no passphrase of your own yet. ' +
          'Open the dashboard and set one, then sign in here again with it.',
      );
    }

    // The session cookie is SameSite=Strict, so Chrome may refuse to attach it
    // to the extension's own requests. Say so now rather than at grab time.
    if (res.cookieReachesApi === false) {
      notes.push(
        "Chrome will not send the dashboard's session cookie from the extension. " +
          'Keep the dashboard open in a tab (signed in) and grabs will be posted through that tab instead.',
      );
    }

    if (notes.length) msg($('grabMsg'), notes.map(escapeHtml).join('<br /><br />'), 'info');
  } catch (e) {
    msg($('loginMsg'), escapeHtml((e && e.message) || 'Sign-in failed.'), 'err');
  } finally {
    $('loginBtn').disabled = false;
  }
});

for (const id of ['email', 'passphrase']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('loginBtn').click();
  });
}

// ── Sign out ─────────────────────────────────────────────────
$('logoutBtn').addEventListener('click', async () => {
  await send({ type: 'logout' });
  msg($('grabMsg'), '');
  show('login');
  focusFirstEmptyField();
});

// ── Grab ─────────────────────────────────────────────────────
async function startGrab(type, label) {
  busy(true);
  await send({ type: 'clearBadge' });
  msg($('grabMsg'), `<span class="spin"></span>${label}`, 'info');

  const result = await send({ type });
  // If the popup survived, we get the real answer here; if it did not, the boot
  // path above picks the same result up from storage next time it opens.
  if (result && result.needLogin) {
    busy(false);
    show('login');
    return msg($('loginMsg'), escapeHtml(result.error || 'Sign in again to keep grabbing.'), 'err');
  }
  busy(false);
  render(result);
}

$('grabBtn').addEventListener('click', () => startGrab('grab', 'Reading the page...'));
$('autoBtn').addEventListener('click', () =>
  startGrab('autograb', 'Auto-scrolling and collecting... you can close this popup.'));
