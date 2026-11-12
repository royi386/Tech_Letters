/* =========================================================
   Technical Section · Letter Monitoring
   Electric Loco Shed, Erode
   ---------------------------------------------------------
   index.html       — public status board
   admin.html       — register, protected by username + password + captcha
   management.html  — section list maintenance, protected the same way
   All pages share the same record store in this browser.
   ========================================================= */

(function () {
  'use strict';

  /* ---------------------------------------------------------
     Constants and vocabulary
     --------------------------------------------------------- */

  var KEY = 'elx-erode-letter-monitor-v1';
  var THEME_KEY = 'elx-erode-letter-monitor-theme-v1';
  var HOUR = 3600000;
  var DAY = 24 * HOUR;
  var ARCHIVE_MS = 48 * HOUR; /* dispatched letters leave the board after 2 days */
  var USERNAME_RE = /^[A-Za-z0-9._-]{3,24}$/;

  /* Sections of the Technical Section that send letters in. Managed on management.html. */
  var TECH_SECTIONS = [
    'Tech 1 - General',
    'Tech 2 - Amrith Bharath',
    'Tech 4 - Inspection Reports',
    'Tech 6 - Failure reports',
    'Tech 7 - Audit',
    'Tech 8 - Warranty',
    'Tech 10A - E3TM',
    'Tech 10B - E3AUX',
    'Tech 10C - E4A & E4B',
    'Tech 10D - E5A',
    'Tech 10E - E5B1 & E5B2',
    'Tech 11 - Mechanical',
    'Tech 12 - Pneumatic',
    'Tech 13 - Safety Audit',
    'Tech 14 - PCDO',
    'Tech 18 - MIP',
    'Tech 19 - MSG',
    'Tech 27 - FAM',
    'Tech 31 - CLW BLW PLW',
    'Tech 33 - Other Shed Attention',
    'Tech 35 - POH & MTR',
    'Tech 36 - MW & FAB',
    'Tech 37 - Training',
    'Tech 38 - FRPCPY',
    'Tech 40 - MCDO',
    'Tech 41 - SIV',
    'Tech 43 - 3 Phase Locos',
    'Tech 44 - MOM',
    'Tech 45 - PPIO',
    'Tech 46 - Maintenance Instruction',
    'Tech 47 - Material & Stores',
    'Tech 48 - KAVACH',
    'Tech 49 - CMT Lab'
  ];

  /* Lists that predate the Tech section list and are safe to replace on load. */
  var LEGACY_SECTIONS = ['Operations', 'Electrical', 'Mechanical', 'Stores', 'Personnel', 'Accounts', 'Safety', 'Works'];

  var DEFAULT_SETTINGS = {
    shed: 'Electric Loco Shed, Erode',
    unit: 'Technical Section',
    adminName: 'Technical Section',
    refPrefix: 'ELX/ED/TS',
    sections: TECH_SECTIONS.slice(),
    officers: ['ADEE-1', 'ADEE-2', 'DEE', 'Sr.DEE'],
    modes: ['E-Office', 'Email', 'Telegram', 'Post', 'Handed Over'],
    slaDays: 3
  };

  var STATUS = {
    received: { label: 'Received', tone: 'received' },
    drafting: { label: 'Draft preparation', tone: 'drafting' },
    with_officer: { label: 'With officer', tone: 'with_officer' },
    signed: { label: 'Signed', tone: 'signed' },
    dispatched: { label: 'Dispatched', tone: 'dispatched' }
  };
  var STATUS_ORDER = ['received', 'drafting', 'with_officer', 'signed', 'dispatched'];

  var BOARD = [
    { key: 'received', title: 'Received from sections', hint: 'New letters awaiting a draft' },
    { key: 'drafting', title: 'Draft preparation', hint: 'With the Technical Section' },
    { key: 'with_officer', title: 'Submitted for signature', hint: 'With the officer concerned' },
    { key: 'signed', title: 'Signed — to dispatch', hint: 'Awaiting dispatch' },
    { key: 'dispatched', title: 'Dispatched · last 48 hrs', hint: 'Leaves this board 2 days after dispatch' }
  ];

  var PRIORITIES = ['Routine', 'Urgent', 'Immediate'];
  var PRIO_RANK = { Immediate: 0, Urgent: 1, Routine: 2 };
  var TONE_COLOR = {
    received: '#94a3b8',
    drafting: '#2563eb',
    with_officer: '#f0b429',
    signed: '#7c3aed',
    dispatched: '#0f766e'
  };

  var page = document.body.getAttribute('data-page') || 'view';
  var storageOk = true;
  var captchaCode = '';
  var captchaId = '';
  var currentUser = null;
  var managedAccounts = [];
  var serverInitialized = false;
  var stateRevision = 0;
  var serverSnapshot = null;
  var persistQueue = Promise.resolve();
  var pendingPersistCount = 0;
  var legacyState = null;
  var stateRequestPending = false;
  var modalEl = null;
  var modalSubmit = null;
  var pendingModal = null;

  /* ---------------------------------------------------------
     Small utilities
     --------------------------------------------------------- */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;
    var button = $('[data-theme-toggle]');
    if (button) {
      var nextLabel = theme === 'dark' ? 'Day mode' : 'Night mode';
      button.textContent = nextLabel;
      button.setAttribute('aria-label', 'Switch to ' + nextLabel.toLowerCase());
      button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
    }
  }

  function initializeTheme() {
    var theme = 'light';
    try { theme = localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch (err) { /* use light theme */ }
    setTheme(theme);
  }

  function toggleTheme() {
    var theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, theme); } catch (err) { /* keep this choice for the current page */ }
    setTheme(theme);
  }

  function p2(n) { return String(n).padStart(2, '0'); }

  function uid() {
    return 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function nowISO() { return new Date().toISOString(); }

  function parseISO(value) {
    if (!value) return null;
    var t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }

  function isoOrNull(value) {
    var t = typeof value === 'number' ? value : parseISO(value);
    return t == null ? null : new Date(t).toISOString();
  }

  function fmtDate(value) {
    var t = typeof value === 'number' ? value : parseISO(value);
    if (t == null) return '—';
    return new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function fmtDateTime(value) {
    var t = typeof value === 'number' ? value : parseISO(value);
    if (t == null) return '—';
    var d = new Date(t);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
      ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function dateInputValue(value) {
    var t = value == null ? Date.now() : (typeof value === 'number' ? value : parseISO(value));
    if (t == null) t = Date.now();
    var d = new Date(t);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  }

  function fromDateInput(value) {
    if (!value) return null;
    var parts = String(value).split('-').map(Number);
    if (parts.length !== 3 || parts.some(function (n) { return !Number.isFinite(n); })) return null;
    return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0).getTime();
  }

  function localDateTimeValue(value) {
    var d = new Date(value == null ? Date.now() : value);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
      'T' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  function fromDateTimeInput(value) {
    if (!value) return null;
    var t = new Date(value).getTime();
    return Number.isFinite(t) ? t : null;
  }

  function cleanList(value, fallback) {
    var arr = Array.isArray(value) ? value : String(value || '').split(',');
    var out = arr.map(function (v) { return String(v).trim(); }).filter(Boolean);
    if (!out.length) return fallback.slice();
    return out.filter(function (v, i) { return out.indexOf(v) === i; });
  }

  function normalizePrefix(value) {
    var out = String(value || '').toUpperCase().replace(/[^A-Z0-9/_-]+/g, '').replace(/^[/_-]+|[/_-]+$/g, '');
    return out || 'TS';
  }

  function sameStrings(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function resolveSections(value) {
    if (!Array.isArray(value)) return TECH_SECTIONS.slice();
    var list = value.map(function (v) { return String(v).trim(); }).filter(Boolean);
    if (!list.length || sameStrings(list, LEGACY_SECTIONS)) return TECH_SECTIONS.slice();
    return list.filter(function (v, i) { return list.indexOf(v) === i; });
  }

  function filterSections() {
    var out = state.settings.sections.slice();
    state.letters.forEach(function (l) {
      if (l.fromSection && out.indexOf(l.fromSection) < 0) out.push(l.fromSection);
    });
    return out;
  }

  function sectionUsage(name) {
    return state.letters.filter(function (l) { return l.fromSection === name; }).length;
  }

  /* ---------------------------------------------------------
     Record store
     --------------------------------------------------------- */

  var state = loadState();

  function apiRequest(url, options) {
    options = options || {};
    var headers = Object.assign({}, options.headers || {});
    if (options.body && typeof options.body !== 'string') {
      headers['content-type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    return fetch(url, Object.assign({ credentials: 'same-origin', headers: headers }, options)).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) {
          var error = new Error(body.error || 'The server request failed.');
          error.status = response.status;
          throw error;
        }
        return body;
      });
    });
  }

  function cloneValue(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function snapshotState(value) {
    return {
      settings: cloneValue(value.settings),
      letters: value.letters.map(function (letter) {
        var copy = cloneValue(letter);
        delete copy.signedPdfName;
        return copy;
      })
    };
  }

  function sameValue(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function rebaseState(base, local, remote) {
    if (!base) return null;
    var settings = {};
    var settingNames = new Set(Object.keys(base.settings).concat(
      Object.keys(local.settings), Object.keys(remote.settings)
    ));
    var conflict = false;
    settingNames.forEach(function (name) {
      var localChanged = !sameValue(local.settings[name], base.settings[name]);
      var remoteChanged = !sameValue(remote.settings[name], base.settings[name]);
      if (localChanged && remoteChanged && !sameValue(local.settings[name], remote.settings[name])) {
        conflict = true;
      } else if (localChanged) {
        settings[name] = local.settings[name];
      } else if (Object.prototype.hasOwnProperty.call(remote.settings, name)) {
        settings[name] = remote.settings[name];
      }
    });

    var baseById = new Map(base.letters.map(function (letter) { return [letter.id, letter]; }));
    var localById = new Map(local.letters.map(function (letter) { return [letter.id, letter]; }));
    var remoteById = new Map(remote.letters.map(function (letter) { return [letter.id, letter]; }));
    var mergedById = new Map();

    base.letters.forEach(function (baseLetter) {
      var localLetter = localById.get(baseLetter.id);
      var remoteLetter = remoteById.get(baseLetter.id);
      if (!localLetter) {
        if (remoteLetter && !sameValue(remoteLetter, baseLetter)) conflict = true;
        return;
      }
      if (!remoteLetter) {
        if (!sameValue(localLetter, baseLetter)) conflict = true;
        return;
      }
      var localChanged = !sameValue(localLetter, baseLetter);
      var remoteChanged = !sameValue(remoteLetter, baseLetter);
      if (localChanged && remoteChanged && !sameValue(localLetter, remoteLetter)) {
        conflict = true;
      }
      mergedById.set(baseLetter.id, localChanged ? localLetter : remoteLetter);
    });

    remote.letters.forEach(function (letter) {
      if (baseById.has(letter.id)) return;
      var localLetter = localById.get(letter.id);
      if (localLetter && !sameValue(localLetter, letter)) conflict = true;
      mergedById.set(letter.id, localLetter || letter);
    });
    local.letters.forEach(function (letter) {
      if (!baseById.has(letter.id) && !remoteById.has(letter.id)) mergedById.set(letter.id, letter);
    });

    if (conflict) return null;
    var letters = remote.letters.map(function (letter) { return mergedById.get(letter.id); })
      .filter(Boolean);
    local.letters.forEach(function (letter) {
      if (!remoteById.has(letter.id) && !baseById.has(letter.id)) letters.push(mergedById.get(letter.id));
    });
    return { settings: settings, letters: letters };
  }

  function applyServerState(data) {
    state = normalize({ settings: data.settings, letters: data.letters, auth: {} });
    serverInitialized = !!data.initialized;
    stateRevision = Number(data.revision) || 0;
    serverSnapshot = snapshotState(state);
    storageOk = true;
    syncShell();
    refreshCurrentPage();
  }

  function loadServerState() {
    if (stateRequestPending || pendingPersistCount) return Promise.resolve();
    stateRequestPending = true;
    return apiRequest('/api/state').then(function (data) {
      if (!pendingPersistCount && Number(data.revision) >= stateRevision) applyServerState(data);
    }).catch(function () {
      storageOk = false;
    }).then(function () { stateRequestPending = false; });
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) legacyState = JSON.parse(raw);
    } catch (err) {
      storageOk = false;
    }
    return normalize(null);
  }

  function normalize(data) {
    data = data && typeof data === 'object' ? data : {};
    var source = data.settings && typeof data.settings === 'object' ? data.settings : {};
    var settings = Object.assign({}, DEFAULT_SETTINGS, source);

    settings.shed = String(settings.shed || DEFAULT_SETTINGS.shed).trim() || DEFAULT_SETTINGS.shed;
    settings.unit = String(settings.unit || DEFAULT_SETTINGS.unit).trim() || DEFAULT_SETTINGS.unit;
    settings.adminName = String(settings.adminName || DEFAULT_SETTINGS.adminName).trim() || DEFAULT_SETTINGS.adminName;
    settings.refPrefix = normalizePrefix(settings.refPrefix);
    settings.sections = resolveSections(source.sections);
    settings.officers = cleanList(settings.officers, DEFAULT_SETTINGS.officers);
    settings.modes = cleanList(settings.modes, DEFAULT_SETTINGS.modes);
    if (settings.modes.indexOf('Handed Over') < 0) settings.modes.push('Handed Over');
    settings.slaDays = Math.min(30, Math.max(1, Number(settings.slaDays) || DEFAULT_SETTINGS.slaDays));

    var letters = (Array.isArray(data.letters) ? data.letters : [])
      .filter(function (l) { return l && typeof l === 'object' && l.id; })
      .map(fixLetter);

    return { settings: settings, auth: {}, letters: letters };
  }

  function fixLetter(raw) {
    var letters = (Array.isArray(raw.history) ? raw.history : []).filter(function (h) {
      return h && h.at;
    }).map(function (h) {
      return {
        at: isoOrNull(h.at) || nowISO(),
        action: String(h.action || 'Updated'),
        status: STATUS[h.status] ? h.status : '',
        by: String(h.by || ''),
        note: String(h.note || '')
      };
    });

    return {
      id: String(raw.id),
      submittedByUserId: String(raw.submittedByUserId || ''),
      refNo: String(raw.refNo || '').trim() || 'Unnumbered',
      subject: String(raw.subject || '').trim() || '(No subject recorded)',
      fromSection: String(raw.fromSection || '').trim() || 'Unspecified',
      fromRef: String(raw.fromRef || '').trim(),
      priority: PRIORITIES.indexOf(raw.priority) >= 0 ? raw.priority : 'Routine',
      remarks: String(raw.remarks || ''),
      receivedOn: isoOrNull(raw.receivedOn) || isoOrNull(raw.createdAt) || nowISO(),
      status: STATUS[raw.status] ? raw.status : 'received',
      stageSince: isoOrNull(raw.stageSince) || isoOrNull(raw.receivedOn) || nowISO(),
      officer: raw.officer ? String(raw.officer) : '',
      draftAssignee: String(raw.draftAssignee || '').trim(),
      draftRef: String(raw.draftRef || ''),
      signedOn: isoOrNull(raw.signedOn),
      dispatchMode: raw.dispatchMode ? String(raw.dispatchMode) : '',
      dispatchRef: String(raw.dispatchRef || ''),
      dispatchedAt: isoOrNull(raw.dispatchedAt),
      attachment: raw.attachment && typeof raw.attachment === 'object' ? {
        name: String(raw.attachment.name || ''),
        type: String(raw.attachment.type || '')
      } : null,
      wordDocument: raw.wordDocument && typeof raw.wordDocument === 'object' ? {
        name: String(raw.wordDocument.name || ''),
        type: String(raw.wordDocument.type || '')
      } : null,
      signedPdfName: String(raw.signedPdfName || '').trim(),
      history: letters,
      createdAt: isoOrNull(raw.createdAt) || nowISO(),
      updatedAt: isoOrNull(raw.updatedAt) || nowISO()
    };
  }

  function persist(extra) {
    if (!currentUser) {
      storageOk = false;
      return Promise.reject(new Error('Sign in before saving changes.'));
    }
    pendingPersistCount++;
    var save = persistQueue.catch(function () {}).then(function () {
      function send(retries) {
        var submittedState = snapshotState(state);
        var base = serverSnapshot;
        return apiRequest('/api/state', {
          method: 'PUT',
          body: Object.assign({
            settings: submittedState.settings,
            letters: submittedState.letters,
            revision: stateRevision
          }, extra || {})
        }).then(function (result) {
          stateRevision = result.revision;
          serverSnapshot = submittedState;
          serverInitialized = true;
          storageOk = true;
          return true;
        }).catch(function (err) {
          if (err.status !== 409 || retries <= 0) throw err;
          return apiRequest('/api/state').then(function (data) {
            var remoteState = normalize({ settings: data.settings, letters: data.letters });
            var remote = snapshotState(remoteState);
            var merged = rebaseState(base, snapshotState(state), remote);
            if (!merged) {
              applyServerState(data);
              var conflict = new Error('The same letter or setting changed in another session. The latest register has been loaded; review and try again.');
              conflict.status = 409;
              throw conflict;
            }
            state = normalize(merged);
            stateRevision = Number(data.revision) || 0;
            serverSnapshot = remote;
            return send(retries - 1);
          });
        });
      }
      return send(2);
    }).catch(function (err) {
      storageOk = err.status === 409;
      throw err;
    }).then(function (result) {
      pendingPersistCount--;
      return result;
    }, function (err) {
      pendingPersistCount--;
      throw err;
    });
    persistQueue = save.then(function () {}, function () {});
    return save;
  }

  function byId(id) {
    return state.letters.filter(function (l) { return l.id === id; })[0] || null;
  }

  function logEvent(letter, action, extra) {
    letter.history.push(Object.assign({
      at: nowISO(),
      action: action,
      status: letter.status,
      by: state.settings.adminName
    }, extra || {}));
  }

  function workflowTimestampFields(letter) {
    var hasSignedEvent = false;
    var hasDispatchEvent = false;
    letter.history.forEach(function (event) {
      if (event.action.indexOf('Signed by ') === 0) hasSignedEvent = true;
      if (event.action.indexOf('Dispatched via ') === 0) hasDispatchEvent = true;
    });

    var fields = letter.history.map(function (event, index) {
      return '<label class="field span-2"><span>' + esc(event.action) +
        (event.by ? ' · ' + esc(event.by) : '') + '</span>' +
        '<input type="datetime-local" name="historyAt_' + index + '" value="' +
        esc(localDateTimeValue(event.at)) + '" required></label>';
    }).filter(Boolean).join('');

    if (!hasSignedEvent && (letter.signedOn || letter.status === 'signed' || letter.status === 'dispatched')) {
      fields += '<label class="field"><span>Signed on</span><input type="datetime-local" name="signedOnFallback" value="' +
        esc(letter.signedOn ? localDateTimeValue(letter.signedOn) : '') +
        '"' + (letter.status === 'signed' || letter.status === 'dispatched' ? ' required' : '') + '></label>';
    }
    if (!hasDispatchEvent && (letter.dispatchedAt || letter.status === 'dispatched')) {
      fields += '<label class="field"><span>Dispatched on</span><input type="datetime-local" name="dispatchedAtFallback" value="' +
        esc(letter.dispatchedAt ? localDateTimeValue(letter.dispatchedAt) : '') +
        '"' + (letter.status === 'dispatched' ? ' required' : '') + '></label>';
    }
    if (!fields) fields = '<p class="form-note">No workflow events have been recorded yet.</p>';

    return '<section class="topic"><h3>Workflow event dates and times</h3>' +
      '<p class="form-note">Changing a signature or dispatch event also updates its date in the register.</p>' +
      '<div class="form-grid">' + fields + '</div></section>';
  }

  /* ---------------------------------------------------------
     Derived values
     --------------------------------------------------------- */

  function stageDays(letter) {
    var t = parseISO(letter.stageSince) || parseISO(letter.receivedOn) || Date.now();
    return Math.max(0, Math.floor((Date.now() - t) / DAY));
  }

  function ageChip(days) {
    var sla = Number(state.settings.slaDays) || 3;
    var cls = days >= sla * 2 ? 'crit' : (days >= sla ? 'warn' : 'ok');
    return '<span class="age ' + cls + '" title="Days in the current stage">' + days + ' d</span>';
  }

  function isArchived(letter) {
    if (letter.status !== 'dispatched') return false;
    var t = parseISO(letter.dispatchedAt) || parseISO(letter.stageSince);
    return t != null && (Date.now() - t) >= ARCHIVE_MS;
  }

  function hoursLeft(letter) {
    var t = parseISO(letter.dispatchedAt) || parseISO(letter.stageSince);
    if (t == null) return 0;
    return Math.max(0, Math.ceil((ARCHIVE_MS - (Date.now() - t)) / HOUR));
  }

  function positionOf(letter) {
    switch (letter.status) {
      case 'received':
      case 'drafting':
        return state.settings.unit;
      case 'with_officer':
        return letter.officer || 'Officer';
      case 'signed':
        return state.settings.unit + ' — dispatch';
      case 'dispatched':
        return letter.dispatchMode ? 'Sent via ' + letter.dispatchMode : 'Dispatched';
      default:
        return '—';
    }
  }

  function applyFilters(list, f) {
    var q = String(f.q || '').trim().toLowerCase();
    var sla = Number(state.settings.slaDays) || 3;
    return list.filter(function (l) {
      if (f.section && l.fromSection !== f.section) return false;
      if (f.officer && l.officer !== f.officer) return false;
      if (f.priority && l.priority !== f.priority) return false;
      if (f.status && l.status !== f.status) return false;
      if (f.delayed && (l.status === 'dispatched' || stageDays(l) < sla)) return false;
      if (q) {
        var hay = [l.refNo, l.subject, l.fromSection, l.fromRef, l.officer, l.draftAssignee, l.remarks, l.dispatchMode, l.dispatchRef]
          .join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  function cardSort(a, b) {
    var rank = (PRIO_RANK[a.priority] == null ? 3 : PRIO_RANK[a.priority]) -
      (PRIO_RANK[b.priority] == null ? 3 : PRIO_RANK[b.priority]);
    if (rank) return rank;
    return stageDays(b) - stageDays(a);
  }

  function adminSort(a, b) {
    var aSent = a.status === 'dispatched';
    var bSent = b.status === 'dispatched';
    if (aSent !== bSent) return aSent ? 1 : -1;
    if (aSent) return (parseISO(b.dispatchedAt) || 0) - (parseISO(a.dispatchedAt) || 0);
    var byStage = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    if (byStage) return byStage;
    return stageDays(b) - stageDays(a);
  }

  /* ---------------------------------------------------------
     Toast and modal plumbing
     --------------------------------------------------------- */

  var toastTimer = null;

  function toast(message) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 4200);
  }

  function openModal(html, onSubmit, options) {
    if (!modalEl) return;
    var next = { html: html, onSubmit: onSubmit || null, options: options || null };
    if (modalEl.open) {
      pendingModal = next;
      modalEl.close();
      return;
    }
    showModal(next);
  }

  function showModal(next) {
    modalEl.classList.toggle('modal-sm', !!(next.options && next.options.small));
    modalEl.innerHTML = next.html;
    modalSubmit = next.onSubmit;
    modalEl.showModal();
  }

  function closeModal() {
    if (modalEl && modalEl.open) modalEl.close();
  }

  function formError(form, message) {
    if (!form) return;
    var el = form.querySelector('[data-form-error]');
    if (!el) {
      var body = form.querySelector('.modal-body') || form;
      el = document.createElement('p');
      el.className = 'form-error';
      el.setAttribute('data-form-error', '');
      body.appendChild(el);
    }
    el.hidden = false;
    el.textContent = message;
    if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function btnAction(action, id, label, cls) {
    return '<button class="btn ' + (cls || '') + '" type="button" data-action="' + action + '" data-id="' + esc(id) + '">' +
      esc(label) + '</button>';
  }

  function iconClose() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  }

  function iconLock() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 10.5V8a4.5 4.5 0 0 1 9 0v2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><rect x="4.5" y="10.5" width="15" height="9.5" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
  }

  function iconInfo() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 11v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.15" fill="currentColor"/></svg>';
  }

  /* ---------------------------------------------------------
     Shell: names, filters, clock
     --------------------------------------------------------- */

  function syncShell() {
    $$('[data-shed]').forEach(function (el) { el.textContent = state.settings.shed; });

    var h1 = $('.brand-text h1');
    if (page === 'view' && h1) h1.textContent = state.settings.unit + ' · Letter Monitoring';

    var clock = $('.clock');
    if (clock) clock.setAttribute('aria-label', state.settings.shed + ' — current date and time');

    fillSelect($('#f-section'), filterSections(), 'All sections', vf.section);
    fillSelect($('#f-officer'), state.settings.officers, 'All officers', vf.officer);
    fillSelect($('#a-section'), filterSections(), 'All sections', af.section);
    fillSelect($('#a-officer'), state.settings.officers, 'All officers', af.officer);

    updateClock();
  }

  function fillSelect(select, values, placeholder, current) {
    if (!select) return;
    var options = ['<option value="">' + esc(placeholder) + '</option>'];
    values.forEach(function (v) {
      options.push('<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>');
    });
    select.innerHTML = options.join('');
  }

  function updateClock() {
    var now = new Date();
    var date = now.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
    var time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    $$('[data-clock-date]').forEach(function (el) { el.textContent = date; });
    $$('[data-clock-time]').forEach(function (el) { el.textContent = time; });
  }

  /* ---------------------------------------------------------
     View page filters
     --------------------------------------------------------- */

  var vf = { q: '', section: '', officer: '', priority: '', delayed: false, archive: false };

  function wireView() {
    var q = $('#f-q');
    if (!q) return;
    q.addEventListener('input', function () { vf.q = q.value; renderBoard(); });
    var section = $('#f-section');
    if (section) section.addEventListener('change', function () { vf.section = section.value; renderBoard(); });
    var officer = $('#f-officer');
    if (officer) officer.addEventListener('change', function () { vf.officer = officer.value; renderBoard(); });
    var priority = $('#f-priority');
    if (priority) priority.addEventListener('change', function () { vf.priority = priority.value; renderBoard(); });
    var delayed = $('#f-delayed');
    if (delayed) delayed.addEventListener('change', function () { vf.delayed = delayed.checked; renderBoard(); });
    var archive = $('#f-archive');
    if (archive) archive.addEventListener('change', function () { vf.archive = archive.checked; renderBoard(); });
    var clear = $('#f-clear');
    if (clear) clear.addEventListener('click', clearViewFilters);
  }

  function clearViewFilters() {
    vf.q = '';
    vf.section = '';
    vf.officer = '';
    vf.priority = '';
    vf.delayed = false;
    vf.archive = false;
    if ($('#f-q')) $('#f-q').value = '';
    if ($('#f-section')) $('#f-section').value = '';
    if ($('#f-officer')) $('#f-officer').value = '';
    if ($('#f-priority')) $('#f-priority').value = '';
    if ($('#f-delayed')) $('#f-delayed').checked = false;
    if ($('#f-archive')) $('#f-archive').checked = false;
    renderBoard();
  }

  /* ---------------------------------------------------------
     Status board
     --------------------------------------------------------- */

  function renderStats() {
    var region = $('[data-region="stats"]');
    if (!region) return;

    var visible = state.letters.filter(function (l) { return !isArchived(l); });
    var open = visible.filter(function (l) { return l.status !== 'dispatched'; });
    var withSection = open.filter(function (l) { return l.status === 'received' || l.status === 'drafting'; });
    var withOfficer = open.filter(function (l) { return l.status === 'with_officer'; });
    var toDispatch = open.filter(function (l) { return l.status === 'signed'; });
    var dispatched = visible.filter(function (l) { return l.status === 'dispatched'; });

    var officerHint = state.settings.officers.map(function (o) {
      var count = withOfficer.filter(function (l) { return l.officer === o; }).length;
      return '<span class="officer-count"><span>' + esc(o) + '</span><strong>- ' + count + '</strong></span>';
    }).join('');

    var tiles = [
      { label: 'Open letters', value: open.length, hint: 'currently moving', tone: 'slate' },
      { label: 'With ' + state.settings.unit, value: withSection.length, hint: 'received or being drafted', tone: 'blue' },
      { label: 'With officers', value: withOfficer.length, hintHtml: officerHint || '<span>Awaiting signature</span>', tone: 'amber' },
      { label: 'Awaiting dispatch', value: toDispatch.length, hint: 'signed and ready to send', tone: 'violet' },
      { label: 'Dispatched', value: dispatched.length, hint: 'leaves the board after 2 days', tone: 'teal' }
    ];

    region.innerHTML = tiles.map(function (t) {
      return '<article class="tile tile-' + t.tone + '">' +
        '<p class="tile-label">' + esc(t.label) + '</p>' +
        '<p class="tile-value">' + t.value + '</p>' +
        '<div class="tile-hint' + (t.hintHtml ? ' officer-counts' : '') + '">' + (t.hintHtml || esc(t.hint)) + '</div>' +
        '</article>';
    }).join('');
  }

  function renderMeta(shown, totalVisible) {
    var el = $('[data-region="board-meta"]');
    if (!el) return;
    var hidden = state.letters.filter(isArchived).length;
    var sla = Number(state.settings.slaDays) || 3;
    var delayed = state.letters.filter(function (l) {
      return !isArchived(l) && l.status !== 'dispatched' && stageDays(l) >= sla;
    }).length;

    var parts = [
      '<span>Showing <strong>' + shown + '</strong> of <strong>' + totalVisible + '</strong> letters on the board</span>',
      '<span class="legend"><i style="background:var(--amber-bright)"></i>Delayed beyond ' + sla + ' days: <strong>' + delayed + '</strong></span>'
    ];
    if (hidden) {
      parts.push('<span>' + hidden + ' dispatched letter' + (hidden === 1 ? '' : 's') + ' left the board after 48 hours</span>');
    }
    el.innerHTML = parts.join('');
  }

  function renderFootnote() {
    var el = $('[data-region="footnote"]');
    if (!el) return;
    el.textContent = 'Last updated ' + new Date().toLocaleTimeString('en-GB') +
      ' · Dispatched letters leave this board 48 hours after dispatch.';
  }

  function setupPanel() {
    return '<div class="setup-card">' +
      '<h2>The board is ready</h2>' +
      '<p>No letters have been recorded yet. Use the admin console to enter the first letter received by the ' +
      esc(state.settings.unit) + ' and move it through drafting, signature and dispatch.</p>' +
      '<a class="btn btn-primary" href="admin.html">Open admin console</a>' +
      '</div>';
  }

  function cardHtml(l) {
    var days = stageDays(l);
    var isSent = l.status === 'dispatched';
    var officerTag = l.status === 'with_officer'
      ? '<span class="tag tag-officer">' + esc(l.officer || 'Officer') + '</span>'
      : '';
    var signedTag = l.status === 'signed' && l.officer
      ? '<span class="tag tag-officer">Signed by ' + esc(l.officer) + '</span>'
      : '';
    var drafterTag = l.status === 'drafting' && l.draftAssignee
      ? '<span class="tag">Drafting: ' + esc(l.draftAssignee) + '</span>'
      : '';
    var sentTag = isSent
      ? '<span class="tag tag-teal">Sent via ' + esc(l.dispatchMode || 'dispatch') + '</span>'
      : '';

    return '<button class="letter-card tone-' + l.status + '" type="button" data-action="open-letter" data-id="' + esc(l.id) + '">' +
      '<span class="card-head">' +
      '<span class="ref">' + esc(l.refNo) + '</span>' +
      (isSent ? (isArchived(l) ? '<span class="age archived">Archived</span>' : '<span class="age ok">' + hoursLeft(l) + ' h left</span>') : ageChip(days)) +
      '</span>' +
      '<span class="subject">' + esc(l.subject) + '</span>' +
      '<span class="card-tags">' +
      '<span class="tag">From ' + esc(l.fromSection) + '</span>' +
      officerTag + signedTag + drafterTag + sentTag +
      '</span>' +
      '<span class="card-foot">' +
      '<span class="prio p-' + String(l.priority).toLowerCase() + '">' + esc(l.priority) + '</span>' +
      '<span>' + (isSent ? 'Sent ' + fmtDate(l.dispatchedAt) : 'Recd ' + fmtDate(l.receivedOn)) + '</span>' +
      '</span>' +
      '</button>';
  }

  function renderBoard() {
    var region = $('[data-region="board"]');
    if (!region) return;

    if (!state.letters.length) {
      region.innerHTML = setupPanel();
      renderMeta(0, 0);
      return;
    }

    var visible = vf.archive ? state.letters.slice() : state.letters.filter(function (l) { return !isArchived(l); });
    if (!visible.length) {
      region.innerHTML = '<div class="empty-state">' +
        '<h2>All clear</h2>' +
        '<p>Every letter has been dispatched and has left the board. The register keeps the complete record.</p>' +
        '<a class="btn" href="admin.html">Open admin console</a>' +
        '</div>';
      renderMeta(0, 0);
      return;
    }

    var filtered = applyFilters(visible, vf);
    renderMeta(filtered.length, visible.length);

    if (!filtered.length) {
      region.innerHTML = '<div class="empty-state">' +
        '<h2>No letters match these filters</h2>' +
        '<p>Clear the filters to see all ' + visible.length + ' letters currently on the board.</p>' +
        '<button class="btn" type="button" data-action="clear-view-filters">Clear filters</button>' +
        '</div>';
      return;
    }

    var groups = {};
    BOARD.forEach(function (b) { groups[b.key] = []; });
    filtered.forEach(function (l) {
      (groups[l.status] || groups.received).push(l);
    });
    BOARD.forEach(function (b) { groups[b.key].sort(cardSort); });

    region.innerHTML = '<div class="board">' + BOARD.map(function (col) {
      var cards = groups[col.key];
      return '<section class="col" data-col="' + col.key + '">' +
        '<header class="col-head">' +
        '<span class="dot ' + col.key + '" aria-hidden="true"></span>' +
        '<h2>' + esc(col.title) + '</h2>' +
        '<span class="count">' + cards.length + '</span>' +
        '</header>' +
        '<p class="col-hint">' + esc(col.hint) + '</p>' +
        '<div class="cards">' +
        (cards.length ? cards.map(cardHtml).join('') : '<p class="none">No letters</p>') +
        '</div>' +
        '</section>';
    }).join('') + '</div>';
  }

  function refreshView() {
    renderStats();
    renderBoard();
    renderFootnote();
  }

  /* ---------------------------------------------------------
     Detail views
     --------------------------------------------------------- */

  function timelineHtml(letter) {
    var items = letter.history.slice().sort(function (a, b) {
      return (parseISO(b.at) || 0) - (parseISO(a.at) || 0);
    });
    if (!items.length) return '<p class="form-note">No movement has been recorded yet.</p>';
    return '<ul class="timeline">' + items.map(function (h) {
      return '<li style="--tone:' + (TONE_COLOR[h.status] || '#8ba0b5') + '">' +
        '<div class="tl-head">' +
        '<span class="tl-title">' + esc(h.action) + '</span>' +
        (h.by ? '<span class="tl-by">· ' + esc(h.by) + '</span>' : '') +
        '<span class="tl-when">' + fmtDateTime(h.at) + '</span>' +
        '</div>' +
        (h.note ? '<div class="tl-note">' + esc(h.note) + '</div>' : '') +
        '</li>';
    }).join('') + '</ul>';
  }

  function detailsHtml(letter) {
    var rows = [
      ['Received from', letter.fromSection],
      ['Received on', fmtDate(letter.receivedOn)],
      ['Their reference', letter.fromRef || '—'],
      ['Priority', letter.priority],
      ['Current position', positionOf(letter)],
      ['Officer', letter.officer || '—'],
      ['Draft assigned to', letter.draftAssignee || '—'],
      ['Draft reference', letter.draftRef || '—'],
      ['Signed on', letter.signedOn ? fmtDate(letter.signedOn) : '—'],
      ['Dispatch route', letter.dispatchMode || '—'],
      ['Dispatch reference', letter.dispatchRef || '—'],
      ['Dispatched on', letter.dispatchedAt ? fmtDateTime(letter.dispatchedAt) : '—']
    ];
    return '<dl class="detail-grid">' + rows.map(function (row) {
      return '<dt>' + esc(row[0]) + '</dt><dd>' + esc(row[1]) + '</dd>';
    }).join('') + '</dl>' + attachmentLinkHtml(letter) + wordDocumentLinkHtml(letter) + signedPdfLinkHtml(letter);
  }

  function attachmentLinkHtml(letter) {
    if (!letter.attachment || !letter.attachment.name) return '';
    var ownsSection = currentUser && currentUser.role === 'section_user' && currentUser.sectionName === letter.fromSection;
    if (!isAdministrator() && !ownsSection) return '';
    return '<section class="topic"><h3>Signed letter</h3><a class="linkish" href="/api/letters/' +
      encodeURIComponent(letter.id) + '/attachment">Download ' + esc(letter.attachment.name) + '</a></section>';
  }

  function wordDocumentLinkHtml(letter) {
    if (!letter.wordDocument || !letter.wordDocument.name) return '';
    var ownsSection = currentUser && currentUser.role === 'section_user' && currentUser.sectionName === letter.fromSection;
    if (!isAdministrator() && !ownsSection) return '';
    return '<section class="topic"><h3>Word document</h3><a class="linkish" href="/api/letters/' +
      encodeURIComponent(letter.id) + '/word-document">Download ' + esc(letter.wordDocument.name) + '</a></section>';
  }

  function canDownloadSignedPdf(letter, user) {
    user = user || currentUser;
    return !!(user && (user.role === 'admin' ||
      (user.role === 'section_user' && user.sectionName === letter.fromSection)));
  }

  function signedPdfLinkHtml(letter) {
    if (letter.status !== 'dispatched' || !letter.signedPdfName) return '';
    if (!currentUser) {
      return '<section class="topic"><h3>Signed letter</h3>' +
        '<button class="btn btn-primary" type="button" data-action="download-signed-pdf" data-id="' + esc(letter.id) + '">Sign in to download ' + esc(letter.signedPdfName) + '</button></section>';
    }
    if (!canDownloadSignedPdf(letter)) {
      return '<section class="topic"><h3>Signed letter</h3><p>This file is available to administrators and users from ' + esc(letter.fromSection) + '.</p></section>';
    }
    return '<section class="topic"><h3>Signed letter</h3><a class="btn btn-primary" href="/api/letters/' +
      encodeURIComponent(letter.id) + '/signed-pdf">Download ' + esc(letter.signedPdfName) + '</a></section>';
  }

  function downloadSignedPdf(id) {
    var link = document.createElement('a');
    link.href = '/api/letters/' + encodeURIComponent(id) + '/signed-pdf';
    link.download = '';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function openSignedPdfLogin(id) {
    var letter = byId(id);
    if (!letter || !letter.signedPdfName) return;
    openModal('<form class="modal-form" autocomplete="off">' +
      '<div class="modal-head"><div><p class="modal-eyebrow">Signed letter</p><h2>Sign in to download</h2></div>' +
      '<button class="icon-btn" type="button" data-action="close-modal" aria-label="Close">' + iconClose() + '</button></div>' +
      '<div class="modal-body"><div class="form-grid">' +
      '<label class="field span-2"><span>Username</span><input name="username" autocomplete="username" required></label>' +
      '<label class="field span-2"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>' +
      '</div>' + captchaBlockHtml() +
      '<p class="form-note">Use your administrator account or the section account assigned to this letter.</p>' +
      '<p class="form-error" data-form-error hidden></p></div>' +
      '<div class="modal-foot"><button class="btn" type="button" data-action="close-modal">Cancel</button>' +
      '<button class="btn btn-primary" type="submit">Sign in and download</button></div></form>', function (fd, form) {
        var username = String(fd.get('username') || '').trim();
        var password = String(fd.get('password') || '');
        var captcha = String(fd.get('captcha') || '').trim().toUpperCase();
        var captchaIdValue = String(fd.get('captchaId') || '');
        var submit = form.querySelector('button[type="submit"]');
        if (submit) submit.disabled = true;
        return apiRequest('/api/login', {
          method: 'POST',
          body: { username: username, password: password, captcha: captcha, captchaId: captchaIdValue }
        }).then(function (result) {
          if (!canDownloadSignedPdf(letter, result.user)) {
            throw new Error('This account cannot download files from ' + letter.fromSection + '.');
          }
          openAccountSession(result.user);
          return apiRequest('/api/me');
        }).then(function (session) {
          if (!session.user) throw new Error('Sign-in was not retained by the browser.');
          currentUser = session.user;
          return loadServerState();
        }).then(function () {
          var currentLetter = byId(id);
          if (!currentLetter || !canDownloadSignedPdf(currentLetter)) {
            throw new Error('This account cannot download this signed letter.');
          }
          closeModal();
          downloadSignedPdf(id);
          toast('Signed in as ' + signedInUser());
        }).catch(function (err) {
          formError(form, err.message || 'Sign-in failed.');
          refreshCaptchaDisplay();
          var passwordInput = form.querySelector('input[name="password"]');
          if (passwordInput) passwordInput.value = '';
          if (submit) submit.disabled = false;
        });
      });
    refreshCaptchaDisplay();
  }

  function statusBanner(letter) {
    var note;
    if (letter.status === 'dispatched') {
      note = isArchived(letter)
        ? 'Archived — left the board 48 hours after dispatch'
        : hoursLeft(letter) + ' hours left on the status board';
    } else {
      var days = stageDays(letter);
      note = days === 0 ? 'Moved today' : days + ' day' + (days === 1 ? '' : 's') + ' in this stage';
    }
    return '<div class="status-banner">' +
      '<span class="pill s-' + letter.status + '">' + STATUS[letter.status].label + '</span>' +
      '<span class="sb-value">' + esc(positionOf(letter)) + '</span>' +
      '<span class="sb-note">' + esc(note) + '</span>' +
      '</div>';
  }

  function openViewLetter(id) {
    var l = byId(id);
    if (!l) return;
    openModal('<div class="modal-head">' +
      '<div><p class="modal-eyebrow">Letter ' + esc(l.refNo) + '</p><h2>' + esc(l.subject) + '</h2></div>' +
      '<button class="icon-btn" type="button" data-action="close-modal" aria-label="Close">' + iconClose() + '</button>' +
      '</div>' +
      '<div class="modal-body">' +
      statusBanner(l) +
      detailsHtml(l) +
      (l.remarks ? '<section class="topic"><h3>Remarks</h3><p>' + esc(l.remarks) + '</p></section>' : '') +
      '<section class="topic"><h3>Movement of the letter</h3>' + timelineHtml(l) + '</section>' +
      '</div>' +
      '<div class="modal-foot">' +
      '<span class="spacer" style="font-size:12px;color:var(--muted)">Updated ' + fmtDateTime(l.updatedAt) + '</span>' +
      '<button class="btn" type="button" data-action="close-modal">Close</button>' +
      '</div>');
  }

  function openAdminLetter(id) {
    if (!isAuthorized('admin')) return;
    var l = byId(id);
    if (!l) return;

    var steps = [];
    if (l.status === 'received') steps.push(btnAction('start-draft', id, 'Start draft preparation', 'btn-primary'));
    if (l.status === 'drafting') steps.push(btnAction('submit-officer', id, 'Submit to officer', 'btn-primary'));
    if (l.status === 'with_officer') {
      steps.push(btnAction('mark-signed', id, 'Record signature', 'btn-primary'));
      steps.push(btnAction('return-draft', id, 'Return for revision', ''));
    }
    if (l.status === 'signed') steps.push(btnAction('mark-dispatched', id, 'Record dispatch', 'btn-primary'));
    if (l.status === 'dispatched') steps.push(btnAction('reopen-letter', id, 'Reopen (undo dispatch)', ''));

    openModal('<div class="modal-head">' +
      '<div><p class="modal-eyebrow">Letter ' + esc(l.refNo) + '</p><h2>' + esc(l.subject) + '</h2></div>' +
      '<button class="icon-btn" type="button" data-action="close-modal" aria-label="Close">' + iconClose() + '</button>' +
      '</div>' +
      '<div class="modal-body">' +
      statusBanner(l) +
      (steps.length ? '<div class="action-bar">' + steps.join('') + '</div>' : '') +
      detailsHtml(l) +
      (l.remarks ? '<section class="topic"><h3>Remarks</h3><p>' + esc(l.remarks) + '</p></section>' : '') +
      '<section class="topic"><h3>Movement of the letter</h3>' + timelineHtml(l) + '</section>' +
      '</div>' +
      '<div class="modal-foot">' +
      '<button class="btn btn-danger" type="button" data-action="delete-letter" data-id="' + esc(l.id) + '">Delete</button>' +
      '<span class="spacer"></span>' +
      '<button class="btn" type="button" data-action="edit-letter" data-id="' + esc(l.id) + '">Edit details</button>' +
      '<button class="btn btn-primary" type="button" data-action="close-modal">Done</button>' +
      '</div>');
  }

  /* ---------------------------------------------------------
     Letter form
     --------------------------------------------------------- */

  function nextSequence() {
    var prefix = state.settings.refPrefix;
    var year = new Date().getFullYear();
    var base = prefix + '/' + year + '/';
    var max = 0;
    state.letters.forEach(function (l) {
      if (typeof l.refNo !== 'string' || l.refNo.indexOf(base) !== 0) return;
      var n = parseInt(l.refNo.slice(base.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    });
    return max + 1;
  }

  function nextRefNo() {
    return state.settings.refPrefix + '/' + new Date().getFullYear() + '/' + String(nextSequence()).padStart(3, '0');
  }

  function sectionReferenceCode(section) {
    var techMatch = String(section || '').match(/^Tech\s+(\d+[A-Za-z]?)/i);
    if (techMatch) return techMatch[1].toUpperCase();
    return String(section || '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 12) || 'OTHER';
  }

  function nextSectionReference(section) {
    var code = sectionReferenceCode(section);
    var base = state.settings.refPrefix + '/' + code + '/';
    var count = 0;
    var maxSequence = 0;
    state.letters.forEach(function (letter) {
      if (sectionReferenceCode(letter.fromSection) !== code) return;
      count++;
      if (letter.refNo.indexOf(base) !== 0) return;
      var sequence = Number(letter.refNo.slice(base.length));
      if (Number.isInteger(sequence) && sequence > maxSequence) maxSequence = sequence;
    });
    return base + (Math.max(count, maxSequence) + 1);
  }

  function openLetterForm(id) {
    if (!isAuthorized('admin')) return;
    var editing = id ? byId(id) : null;
    if (id && !editing) return;

    var refValue = editing ? editing.refNo : '';
    var receivedValue = editing ? localDateTimeValue(editing.receivedOn) : dateInputValue(Date.now());
    var priorityValue = editing ? editing.priority : 'Routine';
    var sections = filterSections();
    if (editing && sections.indexOf(editing.fromSection) < 0) sections.push(editing.fromSection);

    openModal('<form class="modal-form">' +
      '<div class="modal-head">' +
      '<div><p class="modal-eyebrow">' + (editing ? 'Edit record' : 'New entry') + '</p>' +
      '<h2>' + (editing ? 'Edit letter details' : 'Letter received by ' + esc(state.settings.unit)) + '</h2></div>' +
      '<button class="icon-btn" type="button" data-action="close-modal" aria-label="Close">' + iconClose() + '</button>' +
      '</div>' +
      '<div class="modal-body">' +
      '<div class="form-grid">' +
      '<label class="field"><span>Received from section</span><select name="fromSection" required>' +
      '<option value="">Select a section</option>' + sections.map(function (section) {
        return '<option value="' + esc(section) + '"' + (editing && editing.fromSection === section ? ' selected' : '') + '>' + esc(section) + '</option>';
      }).join('') + '</select></label>' +
      '<label class="field span-2"><span>Subject</span>' +
      '<input name="subject" value="' + esc(editing ? editing.subject : '') + '" required autocomplete="off" placeholder="Short subject of the letter"></label>' +
      '<label class="field"><span>Received on</span>' +
      '<input type="' + (editing ? 'datetime-local' : 'date') + '" name="receivedOn" value="' + esc(receivedValue) + '" required></label>' +
      (editing ? '<label class="field"><span>Current stage started (delay tracking)</span>' +
        '<input type="datetime-local" name="stageSince" value="' + esc(localDateTimeValue(editing.stageSince)) + '" required></label>' : '') +
      '<label class="field"><span>Letter reference</span>' +
      '<input name="refNo" value="' + esc(refValue) + '" required autocomplete="off"></label>' +
      '<label class="field"><span>Their letter no. / date</span>' +
      '<input name="fromRef" value="' + esc(editing ? editing.fromRef : '') + '" autocomplete="off" placeholder="Optional"></label>' +
      '<label class="field"><span>Priority</span><select name="priority">' +
      PRIORITIES.map(function (p) {
        return '<option' + (p === priorityValue ? ' selected' : '') + '>' + p + '</option>';
      }).join('') +
      '</select></label>' +
      '<label class="field span-2"><span>Remarks (optional)</span>' +
      '<textarea name="remarks" rows="2" placeholder="Anything the section should note">' + esc(editing ? editing.remarks : '') + '</textarea></label>' +
      '</div>' +
      (editing ? workflowTimestampFields(editing) : '') +
      '<p class="form-error" data-form-error hidden></p>' +
      '</div>' +
      '<div class="modal-foot">' +
      '<button class="btn" type="button" data-action="close-modal">Cancel</button>' +
      '<button class="btn btn-primary" type="submit">' + (editing ? 'Save changes' : 'Add letter to the board') + '</button>' +
      '</div>' +
      '</form>', function (fd, form) {
        saveLetterForm(fd, form, editing ? editing.id : null);
      });

    if (!editing) {
      var sectionSelect = $('select[name="fromSection"]', modalEl);
      var referenceInput = $('input[name="refNo"]', modalEl);
      if (sectionSelect && referenceInput) {
        sectionSelect.addEventListener('change', function () {
          referenceInput.value = sectionSelect.value ? nextSectionReference(sectionSelect.value) : '';
        });
      }
    }
  }

  function saveLetterForm(fd, form, editingId) {
    var refNo = String(fd.get('refNo') || '').trim();
    var subject = String(fd.get('subject') || '').trim();
    var fromSection = String(fd.get('fromSection') || '').trim();
    var receivedMs = editingId
      ? fromDateTimeInput(String(fd.get('receivedOn') || ''))
      : fromDateInput(String(fd.get('receivedOn') || ''));
    var fromRef = String(fd.get('fromRef') || '').trim();
    var priority = PRIORITIES.indexOf(String(fd.get('priority'))) >= 0 ? String(fd.get('priority')) : 'Routine';
    var remarks = String(fd.get('remarks') || '').trim();

    if (!refNo || !subject || !fromSection || receivedMs == null) {
      formError(form, editingId
        ? 'Letter reference, subject, section and received date and time are required.'
        : 'Letter reference, subject, section and received date are required.');
      return;
    }

    var duplicate = state.letters.filter(function (l) {
      return l.id !== editingId && l.refNo.toLowerCase() === refNo.toLowerCase();
    })[0];
    if (duplicate) {
      formError(form, 'That reference is already used by ' + duplicate.refNo + '. Choose another.');
      return;
    }

    if (editingId) {
      var letter = byId(editingId);
      if (!letter) return;
      var stageSinceMs = fromDateTimeInput(String(fd.get('stageSince') || ''));
      if (stageSinceMs == null) {
        formError(form, 'Choose when the current stage started.');
        return;
      }

      var history = [];
      for (var i = 0; i < letter.history.length; i++) {
        var event = Object.assign({}, letter.history[i]);
        var historyMs = fromDateTimeInput(String(fd.get('historyAt_' + i) || ''));
        if (historyMs == null) {
          formError(form, 'Enter a valid date and time for each workflow event.');
          return;
        }
        event.at = new Date(historyMs).toISOString();
        history.push(event);
      }

      var signedEvent = null;
      var dispatchEvent = null;
      history.forEach(function (event) {
        if (event.action.indexOf('Signed by ') === 0) signedEvent = event;
        if (event.action.indexOf('Dispatched via ') === 0) dispatchEvent = event;
      });
      var signedFallbackMs = null;
      var signedFallbackValue = fd.get('signedOnFallback');
      if (signedFallbackValue != null && String(signedFallbackValue)) {
        signedFallbackMs = fromDateTimeInput(String(signedFallbackValue));
        if (signedFallbackMs == null) {
          formError(form, 'Enter a valid signature date and time.');
          return;
        }
      } else if (signedFallbackValue != null &&
          (letter.status === 'signed' || letter.status === 'dispatched') && !signedEvent) {
        formError(form, 'Enter the signature date and time.');
        return;
      }

      var dispatchedFallbackMs = null;
      var dispatchedFallbackValue = fd.get('dispatchedAtFallback');
      if (dispatchedFallbackValue != null && String(dispatchedFallbackValue)) {
        dispatchedFallbackMs = fromDateTimeInput(String(dispatchedFallbackValue));
        if (dispatchedFallbackMs == null) {
          formError(form, 'Enter a valid dispatch date and time.');
          return;
        }
      } else if (dispatchedFallbackValue != null && letter.status === 'dispatched' && !dispatchEvent) {
        formError(form, 'Enter the dispatch date and time.');
        return;
      }

      letter.refNo = refNo;
      letter.subject = subject;
      letter.fromSection = fromSection;
      letter.fromRef = fromRef;
      letter.priority = priority;
      letter.remarks = remarks;
      letter.receivedOn = new Date(receivedMs).toISOString();
      letter.stageSince = new Date(stageSinceMs).toISOString();
      letter.history = history;
      if (signedEvent) letter.signedOn = signedEvent.at;
      else if (signedFallbackValue != null) letter.signedOn = signedFallbackMs == null ? null : new Date(signedFallbackMs).toISOString();
      if (letter.status === 'dispatched' && dispatchEvent) letter.dispatchedAt = dispatchEvent.at;
      else if (dispatchedFallbackValue != null) {
        letter.dispatchedAt = dispatchedFallbackMs == null ? null : new Date(dispatchedFallbackMs).toISOString();
      }
      letter.updatedAt = nowISO();
      logEvent(letter, 'Letter details updated');
      return finish('Letter details updated');
    }

    var created = new Date(receivedMs).toISOString();
    var fresh = fixLetter({
      id: uid(),
      refNo: refNo,
      subject: subject,
      fromSection: fromSection,
      fromRef: fromRef,
      priority: priority,
      remarks: remarks,
      receivedOn: created,
      status: 'received',
      stageSince: created,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      history: [{
        at: nowISO(),
        action: 'Received from ' + fromSection,
        status: 'received',
        by: state.settings.adminName
      }]
    });
    state.letters.push(fresh);
    return finish('Letter ' + fresh.refNo + ' added to the board').then(function (saved) {
      if (!saved) {
        state.letters.pop();
        formError(form, 'The database could not save this change.');
      }
    });
  }

  /* ---------------------------------------------------------
     Workflow
     --------------------------------------------------------- */

  function refreshCurrentPage() {
    if (page === 'admin') refreshAdmin();
    else if (page === 'management') refreshManagement();
    else if (page === 'section') refreshSectionPage();
    else refreshView();
  }

  function finish(message, extra) {
    return persist(extra).then(function () {
      if (extra && extra.signedPdf) {
        var savedLetter = byId(extra.signedPdf.letterId);
        if (savedLetter) savedLetter.signedPdfName = extra.signedPdf.name;
      }
      closeModal();
      syncShell();
      refreshCurrentPage();
      if (message) toast(message);
      return true;
    }).catch(function (err) {
      toast(err.message || 'The database could not save this change.');
      return false;
    });
  }

  function loadDrafters() {
    return apiRequest('/api/drafters').then(function (result) {
      var drafters = Array.isArray(result.drafters) ? result.drafters : [];
      if (!drafters.length) throw new Error('No administrator accounts are available for drafting.');
      return drafters;
    });
  }

  function drafterField(drafters) {
    return '<label class="field"><span>Assign drafting to</span><select name="draftAssignee" required>' +
      '<option value="">Select an admin</option>' + drafters.map(function (username) {
        return '<option value="' + esc(username) + '">' + esc(username) + '</option>';
      }).join('') + '</select></label>';
  }

  function startDraft(id) {
    if (!isAuthorized('admin')) return;
    var l = byId(id);
    if (!l) return;
    if (l.status !== 'received') { toast('This letter is no longer awaiting a draft.'); return; }
    loadDrafters().then(function (drafters) {
      l = byId(id);
      if (!l || l.status !== 'received') {
        toast('This letter changed while the drafting admins were loading. Reload the letter and try again.');
        return;
      }
      openModal('<form class="modal-form">' +
        '<div class="modal-head"><div><p class="modal-eyebrow">' + esc(l.refNo) + '</p><h2>Start draft preparation</h2></div>' +
        '<button class="icon-btn" type="button" data-action="close-modal" aria-label="Close">' + iconClose() + '</button></div>' +
        '<div class="modal-body">' + drafterField(drafters) +
        '<p class="form-error" data-form-error hidden></p></div>' +
        '<div class="modal-foot"><button class="btn" type="button" data-action="close-modal">Cancel</button>' +
        '<button class="btn btn-primary" type="submit">Start draft</button></div></form>', function (fd, form) {
          var assignee = String(fd.get('draftAssignee') || '').trim();
          if (!assignee) { formError(form, 'Choose the admin who will prepare this draft.'); return; }
          var currentLetter = byId(id);
          if (!currentLetter || currentLetter.status !== 'received') {
            formError(form, 'This letter changed while the form was open. Reopen it and try again.');
            return;
          }
          currentLetter.draftAssignee = assignee;
          currentLetter.status = 'drafting';
          currentLetter.stageSince = nowISO();
          currentLetter.updatedAt = nowISO();
          logEvent(currentLetter, 'Draft preparation started', { note: 'Assigned to ' + assignee });
          return finish('Draft assigned to ' + assignee);
        });
    }).catch(function (err) { toast(err.message || 'Drafting admins could not be loaded.'); });
  }

  function openSubmit(id) {
    if (!isAuthorized('admin')) return;
    var l = byId(id);
    if (!l) return;
    if (l.status !== 'drafting') { toast('Start the draft before submitting the letter.'); return; }
    var chosen = l.officer || state.settings.officers[0];

    openModal('<form class="modal-form">' +
      '<div class="modal-head">' +
      '<div><p class="modal-eyebrow">' + esc(l.refNo) + '</p><h2>Submit the draft for signature</h2></div>' +
      '<button class="icon-btn" type="button" data-action="close-modal" aria-label="Close">' + iconClose() + '</button>' +
      '</div>' +
      '<div class="modal-body">' +
      '<label class="field" style="margin-bottom:14px"><span>Place the draft before</span>' +
      '<div class="radio-row">' + state.settings.officers.map(function (o) {
        return '<label class="radio-chip"><input type="radio" name="officer" value="' + esc(o) + '"' +
          (o === chosen ? ' checked' : '') + '><span>' + esc(o) + '</span></label>';
      }).join('') + '</div></label>' +
      '<label class="field" style="margin-bottom:14px"><span>Draft reference (optional)</span>' +
      '<input name="draftRef" value="' + esc(l.draftRef || '') + '" autocomplete="off" placeholder="e.g. ' + esc(state.settings.refPrefix) + '/D/001"></label>' +
      '<label class="field"><span>Note for the record (optional)</span>' +
      '<textarea name="note" rows="2" placeholder="Covering note or instruction"></textarea></label>' +
      '<p class="form-note">The letter will show as “With officer” on the board until the signature is recorded.</p>' +
      '<p class="form-error" data-form-error hidden></p>' +
      '</div>' +
      '<div class="modal-foot">' +
      '<button class="btn" type="button" data-action="close-modal">Cancel</button>' +
      '<button class="btn btn-primary" type="submit">Submit for signature</button>' +
      '</div>' +
      '</form>', function (fd, form) {
        var officer = String(fd.get('officer') || '').trim();
        if (!officer) { formError(form, 'Choose the officer who will sign the draft.'); return; }
        var currentLetter = byId(id);
        if (!currentLetter || currentLetter.status !== 'drafting') {
          formError(form, 'This letter changed while the form was open. Reopen it and try again.');
          return;
        }
        var draftRef = String(fd.get('draftRef') || '').trim();
        var note = String(fd.get('note') || '').trim();
        currentLetter.officer = officer;
        currentLetter.draftRef = draftRef;
        currentLetter.status = 'with_officer';
        currentLetter.stageSince = nowISO();
        currentLetter.updatedAt = nowISO();
        logEvent(currentLetter, 'Submitted to ' + officer + ' for signature', {
          note: [note, draftRef ? 'Draft ref. ' + draftRef : ''].filter(Boolean).join(' · ')
        });
        return finish('Draft submitted to ' + officer);
      });
  }

  function openSign(id) {
    if (!isAuthorized('admin')) return;
    var l = byId(id);
    if (!l) return;
    if (l.status !== 'with_officer') { toast('This letter is not with an officer.'); return; }

    openModal('<form class="modal-form">' +
      '<div class="modal-head">' +
      '<div><p class="modal-eyebrow">' + esc(l.refNo) + '</p><h2>Record the signature</h2></div>' +
      '<button class="icon-btn" type="button" data-action="close-modal" aria-label="Close">' + iconClose() + '</button>' +
      '</div>' +
      '<div class="modal-body">' +
      '<div class="form-grid">' +
      '<label class="field"><span>Signed by</span>' +
      '<input value="' + esc(l.officer || '') + '" readonly></label>' +
      '<label class="field"><span>Signed on</span>' +
      '<input type="date" name="signedOn" value="' + esc(dateInputValue(Date.now())) + '" required></label>' +
      '<label class="field span-2"><span>Note (optional)</span>' +
      '<textarea name="note" rows="2" placeholder="Signature reference, remarks…"></textarea></label>' +
      '</div>' +
      '<p class="form-note">Once signed, the letter moves to “Signed — to dispatch” and waits there until the dispatch is recorded.</p>' +
      '<p class="form-error" data-form-error hidden></p>' +
      '</div>' +
      '<div class="modal-foot">' +
      '<button class="btn" type="button" data-action="close-modal">Cancel</button>' +
      '<button class="btn btn-primary" type="submit">Record signature</button>' +
      '</div>' +
      '</form>', function (fd, form) {
        var signedMs = fromDateInput(String(fd.get('signedOn') || ''));
        if (signedMs == null) { formError(form, 'Choose the date of signature.'); return; }
        var currentLetter = byId(id);
        if (!currentLetter || currentLetter.status !== 'with_officer') {
          formError(form, 'This letter changed while the form was open. Reopen it and try again.');
          return;
        }
        var note = String(fd.get('note') || '').trim();
        currentLetter.signedOn = new Date(signedMs).toISOString();
        currentLetter.status = 'signed';
        currentLetter.stageSince = nowISO();
        currentLetter.updatedAt = nowISO();
        logEvent(currentLetter, 'Signed by ' + (currentLetter.officer || 'the officer'), { note: note });
        return finish('Signature recorded — ready for dispatch');
      });
  }

  function openDispatch(id) {
    if (!isAuthorized('admin')) return;
    var l = byId(id);
    if (!l) return;
    if (l.status !== 'signed') { toast('Record the signature before dispatching this letter.'); return; }
    var chosen = l.dispatchMode || state.settings.modes[0];

    openModal('<form class="modal-form">' +
      '<div class="modal-head">' +
      '<div><p class="modal-eyebrow">' + esc(l.refNo) + '</p><h2>Record the dispatch</h2></div>' +
      '<button class="icon-btn" type="button" data-action="close-modal" aria-label="Close">' + iconClose() + '</button>' +
      '</div>' +
      '<div class="modal-body">' +
      '<label class="field" style="margin-bottom:14px"><span>Sent through</span>' +
      '<div class="radio-row">' + state.settings.modes.map(function (m) {
        return '<label class="radio-chip"><input type="radio" name="mode" value="' + esc(m) + '"' +
          (m === chosen ? ' checked' : '') + '><span>' + esc(m) + '</span></label>';
      }).join('') + '</div></label>' +
      '<div class="form-grid">' +
      '<label class="field"><span>Dispatched on</span>' +
      '<input type="datetime-local" name="dispatchedAt" value="' + esc(localDateTimeValue(Date.now())) + '" required></label>' +
      '<label class="field"><span>Dispatch reference (optional)</span>' +
      '<input name="dispatchRef" value="' + esc(l.dispatchRef || '') + '" autocomplete="off" placeholder="e-Dispatch / post ref."></label>' +
      '<label class="field span-2"><span>Signed letter PDF (optional, up to 8 MB)</span>' +
      '<input type="file" name="signedPdf" accept=".pdf,application/pdf"></label>' +
      '<label class="field span-2"><span>Note (optional)</span>' +
      '<textarea name="note" rows="2" placeholder="Address, acknowledgement details…"></textarea></label>' +
      '</div>' +
      '<p class="form-note">The letter leaves the status board exactly 48 hours after the dispatch date and time recorded here. It stays in the register.</p>' +
      '<p class="form-error" data-form-error hidden></p>' +
      '</div>' +
      '<div class="modal-foot">' +
      '<button class="btn" type="button" data-action="close-modal">Cancel</button>' +
      '<button class="btn btn-primary" type="submit">Record dispatch</button>' +
      '</div>' +
      '</form>', function (fd, form) {
        var mode = String(fd.get('mode') || '').trim();
        if (!mode) { formError(form, 'Choose how the letter was sent.'); return; }
        var dispatchedMs = fromDateTimeInput(String(fd.get('dispatchedAt') || ''));
        if (dispatchedMs == null) { formError(form, 'Enter the date and time of dispatch.'); return; }
        var note = String(fd.get('note') || '').trim();
        var fileInput = form.querySelector('input[name="signedPdf"]');
        var file = fileInput && fileInput.files && fileInput.files[0];
        if (file && !/\.pdf$/i.test(file.name)) { formError(form, 'Choose a PDF file for the signed letter.'); return; }
        if (file && file.size > 8 * 1024 * 1024) { formError(form, 'The signed PDF must be no larger than 8 MB.'); return; }

        function saveDispatch(signedPdf) {
          var currentLetter = byId(id);
          if (!currentLetter || currentLetter.status !== 'signed') {
            formError(form, 'This letter changed while the dispatch form was open. Reopen it and try again.');
            return;
          }
          currentLetter.dispatchMode = mode;
          currentLetter.dispatchRef = String(fd.get('dispatchRef') || '').trim();
          currentLetter.dispatchedAt = new Date(dispatchedMs).toISOString();
          currentLetter.stageSince = currentLetter.dispatchedAt;
          currentLetter.status = 'dispatched';
          currentLetter.updatedAt = nowISO();
          var notes = [note, signedPdf ? 'Signed PDF attached: ' + signedPdf.name : ''].filter(Boolean).join(' · ');
          logEvent(currentLetter, 'Dispatched via ' + mode, { note: notes });
          var extra = signedPdf ? { signedPdf: { letterId: currentLetter.id, name: signedPdf.name, data: signedPdf.data } } : null;
          finish('Dispatch recorded — ' + mode, extra);
        }

        if (!file) { saveDispatch(null); return; }
        var reader = new FileReader();
        reader.onload = function () { saveDispatch({ name: file.name, data: reader.result }); };
        reader.onerror = function () { formError(form, 'The signed PDF could not be read.'); };
        reader.readAsDataURL(file);
      });
  }

  function openReturn(id) {
    if (!isAuthorized('admin')) return;
    var l = byId(id);
    if (!l) return;
    if (l.status !== 'with_officer') { toast('This letter is not with an officer.'); return; }

    loadDrafters().then(function (drafters) {
      l = byId(id);
      if (!l || l.status !== 'with_officer') {
        toast('This letter changed while the drafting admins were loading. Reload the letter and try again.');
        return;
      }
      openModal('<form class="modal-form">' +
      '<div class="modal-head">' +
      '<div><p class="modal-eyebrow">' + esc(l.refNo) + '</p><h2>Return the draft for revision</h2></div>' +
      '<button class="icon-btn" type="button" data-action="close-modal" aria-label="Close">' + iconClose() + '</button>' +
      '</div>' +
      '<div class="modal-body">' +
      drafterField(drafters) +
      '<label class="field"><span>What has to be revised? (optional)</span>' +
      '<textarea name="note" rows="3" placeholder="The officer’s observation, if available"></textarea></label>' +
      '<p class="form-note">The letter goes back to “Draft preparation”. The officer and draft reference are kept for reference.</p>' +
      '<p class="form-error" data-form-error hidden></p>' +
      '</div>' +
      '<div class="modal-foot">' +
      '<button class="btn" type="button" data-action="close-modal">Cancel</button>' +
      '<button class="btn btn-primary" type="submit">Return for revision</button>' +
      '</div>' +
      '</form>', function (fd, form) {
        var assignee = String(fd.get('draftAssignee') || '').trim();
        var note = String(fd.get('note') || '').trim();
        if (!assignee) { formError(form, 'Choose the admin who will handle the revision.'); return; }
        var currentLetter = byId(id);
        if (!currentLetter || currentLetter.status !== 'with_officer') {
          formError(form, 'This letter changed while the form was open. Reopen it and try again.');
          return;
        }
        currentLetter.draftAssignee = assignee;
        currentLetter.status = 'drafting';
        currentLetter.stageSince = nowISO();
        currentLetter.updatedAt = nowISO();
        logEvent(currentLetter, 'Returned by ' + (currentLetter.officer || 'the officer') + ' for revision', {
          note: [note, 'Assigned to ' + assignee].filter(Boolean).join(' · ')
        });
        return finish('Revision assigned to ' + assignee);
      });
    }).catch(function (err) { toast(err.message || 'Drafting admins could not be loaded.'); });
  }

  function reopenLetter(id) {
    if (!isAuthorized('admin')) return;
    var l = byId(id);
    if (!l) return;
    if (!window.confirm('Reopen this dispatch entry? The letter will return to “Signed — to dispatch” and stay on the board.')) return;
    l.status = 'signed';
    l.dispatchedAt = null;
    l.dispatchMode = '';
    l.dispatchRef = '';
    l.stageSince = nowISO();
    l.updatedAt = nowISO();
    logEvent(l, 'Dispatch entry reopened');
    finish('Dispatch entry reopened');
  }

  function deleteLetter(id) {
    if (!isAuthorized('admin')) return;
    var l = byId(id);
    if (!l) return;
    if (!window.confirm('Delete ' + l.refNo + ' — “' + l.subject + '”?\n\nThis cannot be undone.')) return;
    state.letters = state.letters.filter(function (x) { return x.id !== id; });
    finish('Letter deleted');
  }

  /* ---------------------------------------------------------
     Sign in — admin console and management page
     --------------------------------------------------------- */

  var ROLE_LABEL = { admin: 'Admin console', management: 'Management', section: 'Section portal' };

  function hasSession(role) {
    return !!currentUser && (!role || currentUser.role === role);
  }

  function openAccountSession(account) {
    currentUser = account;
  }

  function closeSessions() {
    currentUser = null;
  }

  /* An admin may also open the Management page; management credentials cannot open the register. */
  function isAuthorized(role) {
    if (role === 'section') return hasSession('section_user');
    return hasSession('admin');
  }

  function isAdministrator() {
    return hasSession('admin');
  }

  function isMainAdministrator() {
    return !!(currentUser && currentUser.isMainAdmin);
  }

  function signedInUser() {
    return currentUser ? currentUser.username : '';
  }

  function renderSessionChip() {
    var holder = $('[data-region="session"]');
    if (!holder) return;
    var role = page === 'section' ? 'section' : (page === 'management' || page === 'admin' ? 'admin' : '');
    if (page === 'view' || !isAuthorized(role)) {
      holder.innerHTML = '';
      return;
    }
    holder.innerHTML = '<span class="session-user" title="Signed in">' + esc(signedInUser()) + '</span>' +
      '<button class="btn btn-ghost-light btn-tiny" type="button" data-action="lock">Lock</button>';
  }

  function iconRefresh() {
    return '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M20 4v7h-7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function captchaBlockHtml() {
    return '<div class="captcha-block">' +
      '<div class="captcha-row">' +
      '<span class="captcha-code" aria-hidden="true">' + esc(captchaCode) + '</span>' +
      '<button class="icon-btn" type="button" data-action="new-captcha" aria-label="Show a new verification code" title="New code">' + iconRefresh() + '</button>' +
      '</div>' +
      '<p class="sr-only captcha-sr">Verification code: ' + esc(captchaCode.split('').join(' ')) + '</p>' +
      '<input type="hidden" name="captchaId" value="">' +
      '<label class="field"><span>Type the 4-character code</span>' +
      '<input name="captcha" maxlength="4" autocomplete="off" spellcheck="false" autocapitalize="characters" required></label>' +
      '</div>';
  }

  function refreshCaptchaDisplay() {
    return apiRequest('/api/captcha').then(function (challenge) {
      captchaCode = challenge.code;
      captchaId = challenge.id;
      var codeEl = $('.captcha-code');
      if (codeEl) codeEl.textContent = captchaCode;
      var sr = $('.captcha-sr');
      if (sr) sr.textContent = 'Verification code: ' + captchaCode.split('').join(' ');
      var idInput = $('input[name="captchaId"]');
      if (idInput) idInput.value = captchaId;
      var input = $('input[name="captcha"]');
      if (input) { input.value = ''; input.focus(); }
    }).catch(function () {
      gateError('The sign-in service is unavailable. Restart the portal server and reload this page.');
    });
  }

  function gateHtml(role) {
    captchaCode = '';

    return '<div class="gate-card">' +
      '<div class="gate-icon">' + iconLock() + '</div>' +
      '<h2>' + ROLE_LABEL[role] + ' sign in</h2>' +
      '<p>Enter your username and password, then type the code shown below.</p>' +
      '<form class="gate-form" id="gate-form" autocomplete="off">' +
      '<div class="gate-credentials">' +
      '<label class="field"><span>Username</span>' +
      '<input name="username" placeholder="Your username" autocomplete="username" spellcheck="false" required></label>' +
      '<label class="field"><span>Password</span>' +
      '<input type="password" name="password" autocomplete="current-password" required></label>' +
      '</div>' +
      captchaBlockHtml() +
      '<p class="gate-msg" id="gate-msg" role="alert"></p>' +
      '<button class="btn btn-primary" type="submit">Sign in</button>' +
      '<p class="gate-hint">Accounts are created and maintained by the Main admin.</p>' +
      '</form>' +
      '<div class="gate-links">' +
      '<a class="linkish" href="index.html">Back to the status board</a>' +
      '</div>' +
      '</div>';
  }

  function gateError(message) {
    var el = $('#gate-msg');
    if (el) el.textContent = message;
  }

  function wireGate(role) {
    var form = $('#gate-form');
    if (!form) return;

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var fd = new FormData(form);
      var submit = form.querySelector('button[type="submit"]');
      var username = String(fd.get('username') || '').trim();
      var password = String(fd.get('password') || '');
      var captcha = String(fd.get('captcha') || '').trim().toUpperCase();

      if (!USERNAME_RE.test(username)) {
        gateError('The username needs 3 to 24 letters, digits, dots, dashes or underscores.');
        return;
      }
      if (submit) submit.disabled = true;
      apiRequest('/api/login', {
        method: 'POST',
        body: { username: username, password: password, captcha: captcha, captchaId: String(fd.get('captchaId') || '') }
      }).then(function (result) {
        var expectedRole = page === 'section' ? 'section_user' : 'admin';
        if (result.user.role !== expectedRole) {
          return apiRequest('/api/logout', { method: 'POST' }).then(function () {
            throw new Error(expectedRole === 'admin'
              ? 'This page is for administrator accounts. Section users should sign in on the Section portal.'
              : 'This page is for section user accounts. Administrators should sign in on Management.');
          });
        }
        openAccountSession(result.user);
        return apiRequest('/api/me').then(function (session) {
          if (!session.user) {
            closeSessions();
            throw new Error('The sign-in cookie was not retained. Use HTTPS, or set COOKIE_SECURE=0 only when testing over HTTP.');
          }
          currentUser = session.user;
          return apiRequest('/api/state');
        }, function (err) {
          closeSessions();
          throw err;
        }).then(function (serverState) {
          stateRevision = Number(serverState.revision) || 0;
          serverSnapshot = snapshotState(normalize({ settings: serverState.settings, letters: serverState.letters }));
          var oldLetters = legacyState && Array.isArray(legacyState.letters) ? legacyState.letters : [];
          if (!serverState.initialized || (legacyState && !serverState.letters.length && oldLetters.length)) {
            state = normalize(legacyState);
            return persist().then(function () { return apiRequest('/api/state'); });
          }
          return serverState;
        }).then(function (serverState) {
          try { localStorage.removeItem(KEY); } catch (err) { /* clear old plaintext account data */ }
          legacyState = null;
          return serverState;
        });
      }).then(function (serverState) {
        applyServerState(serverState);
        renderSessionChip();
        toast('Signed in as ' + signedInUser());
      }).catch(function (err) {
        gateError(err.message || 'Username or password is incorrect.');
        refreshCaptchaDisplay();
        var pw = form.querySelector('input[name="password"]');
        if (pw) pw.value = '';
        if (submit) submit.disabled = false;
      });
    });

    var usernameInput = form.querySelector('input[name="username"]');
    if (usernameInput) usernameInput.focus();
    refreshCaptchaDisplay();
  }

  function refreshAdmin() {
    var gate = $('[data-region="gate"]');
    var shell = $('[data-region="admin"]');
    if (!gate || !shell) return;

    if (isAuthorized('admin')) {
      gate.hidden = true;
      gate.innerHTML = '';
      shell.hidden = false;
      var settingsButton = $('[data-admin-only]');
      if (settingsButton) settingsButton.hidden = !isAdministrator();
      renderAdminTable();
    } else {
      shell.hidden = true;
      gate.hidden = false;
      gate.innerHTML = gateHtml('admin');
      wireGate('admin');
    }
    renderSessionChip();
  }

  /* ---------------------------------------------------------
     Management page — sections
     --------------------------------------------------------- */

  function refreshManagement() {
    var gate = $('[data-region="gate"]');
    var shell = $('[data-region="management"]');
    if (!gate || !shell) return;

    if (isAuthorized('management')) {
      gate.hidden = true;
      gate.innerHTML = '';
      shell.hidden = false;
      renderSections();
      renderAccounts();
    } else {
      shell.hidden = true;
      gate.hidden = false;
      gate.innerHTML = gateHtml('management');
      wireGate('management');
    }
    renderSessionChip();
  }

  function refreshSectionPage() {
    var gate = $('[data-region="gate"]');
    var portal = $('[data-region="section-portal"]');
    if (!gate || !portal) return;
    if (isAuthorized('section')) {
      gate.hidden = true;
      gate.innerHTML = '';
      portal.hidden = false;
      var sectionName = $('[data-region="section-name"]');
      if (sectionName) sectionName.textContent = currentUser.sectionName;
      renderSectionSubmissions();
    } else {
      portal.hidden = true;
      gate.hidden = false;
      gate.innerHTML = gateHtml('section');
      wireGate('section');
    }
    renderSessionChip();
  }

  function renderSectionSubmissions() {
    if (!isAuthorized('section')) return;
    var rows = $('[data-region="section-submissions"]');
    var count = $('[data-region="section-submission-count"]');
    var empty = $('[data-region="section-submissions-empty"]');
    if (!rows) return;
    var letters = state.letters.slice().sort(function (a, b) {
      return (parseISO(b.createdAt) || 0) - (parseISO(a.createdAt) || 0);
    });
    if (count) count.textContent = letters.length + ' letter' + (letters.length === 1 ? '' : 's') + ' in the register';
    rows.innerHTML = letters.map(function (letter) {
      var actions = canEditSectionSubmission(letter)
        ? '<button class="btn btn-tiny" type="button" data-action="edit-submission" data-id="' + esc(letter.id) + '">Edit</button> ' +
          '<button class="btn btn-tiny btn-danger" type="button" data-action="delete-submission" data-id="' + esc(letter.id) + '">Delete</button>'
        : (letter.status === 'received' ? '—' : 'Technical Section handling');
      var ownsSection = letter.fromSection === currentUser.sectionName;
      var signedLetter = letter.attachment
        ? (letter.fromSection === currentUser.sectionName
          ? '<a class="linkish" href="/api/letters/' + encodeURIComponent(letter.id) + '/attachment">' + esc(letter.attachment.name) + '</a>'
          : esc(letter.attachment.name) + ' (restricted)')
        : '—';
      var wordDocument = letter.wordDocument
        ? (ownsSection
          ? '<a class="linkish" href="/api/letters/' + encodeURIComponent(letter.id) + '/word-document">' + esc(letter.wordDocument.name) + '</a>'
          : esc(letter.wordDocument.name) + ' (restricted)')
        : '—';
      return '<tr><td class="cell-letter"><strong>' + esc(letter.refNo) + '</strong></td>' +
        '<td>' + esc(letter.subject) + '</td>' +
        '<td>' + esc(letter.fromSection) + '</td>' +
        '<td>' + fmtDate(letter.receivedOn) + '</td>' +
        '<td><span class="pill s-' + esc(letter.status) + '">' + esc(STATUS[letter.status].label) + '</span></td>' +
        '<td>' + signedLetter + '</td>' +
        '<td>' + wordDocument + '</td>' +
        '<td class="account-actions">' + actions + '</td></tr>';
    }).join('');
    if (empty) empty.hidden = letters.length > 0;
  }

  function canEditSectionSubmission(letter) {
    if (!isAuthorized('section') || !letter || letter.status !== 'received' || letter.fromSection !== currentUser.sectionName) return false;
    if (letter.submittedByUserId) return letter.submittedByUserId === currentUser.id;
    return letter.history.some(function (entry) {
      return entry.action === 'Submitted by section user' && entry.by === currentUser.username;
    });
  }

  function wireSectionPage() {
    var form = $('#section-submit-form');
    if (!form) return;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      submitSectionLetter(form);
    });
  }

  function submitSectionLetter(form, editingId) {
    if (!isAuthorized('section')) return Promise.resolve();
    if (editingId && !canEditSectionSubmission(byId(editingId))) return Promise.resolve();
    var fd = new FormData(form);
    var signedLetterFile = fd.get('signedLetter');
    var wordDocumentFile = fd.get('wordDocument');
    var receivedMs = fromDateInput(String(fd.get('receivedOn') || ''));
    if (signedLetterFile && signedLetterFile.name && signedLetterFile.size > 8 * 1024 * 1024) {
      formError(form, 'The signed letter must be no larger than 8 MB.');
      return Promise.resolve();
    }
    if (wordDocumentFile && wordDocumentFile.name && wordDocumentFile.size > 8 * 1024 * 1024) {
      formError(form, 'The Word document must be no larger than 8 MB.');
      return Promise.resolve();
    }
    if (signedLetterFile && signedLetterFile.name && !/\.(pdf|jpe?g|png)$/i.test(signedLetterFile.name)) {
      formError(form, 'Choose a PDF, JPG, or PNG file for the signed letter.');
      return Promise.resolve();
    }
    if (wordDocumentFile && wordDocumentFile.name && !/\.docx$/i.test(wordDocumentFile.name)) {
      formError(form, 'Choose a DOCX file for the Word document.');
      return Promise.resolve();
    }
    if (receivedMs == null) {
      formError(form, 'Choose the date the letter was received.');
      return Promise.resolve();
    }
    var submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    var payload = {
      subject: String(fd.get('subject') || '').trim(),
      fromRef: String(fd.get('fromRef') || '').trim(),
      receivedOn: new Date(receivedMs).toISOString(),
      remarks: String(fd.get('remarks') || '').trim()
    };
    function sendSubmission() {
      apiRequest(editingId ? '/api/submissions/' + encodeURIComponent(editingId) : '/api/submissions', {
        method: editingId ? 'PATCH' : 'POST',
        body: payload
      }).then(function (result) {
        if (editingId) closeModal();
        else form.reset();
        form.querySelector('[data-form-error]').hidden = true;
        return apiRequest('/api/state').then(function (serverState) {
          applyServerState(serverState);
          toast(editingId ? 'Letter ' + result.letter.refNo + ' updated' :
            'Letter ' + result.letter.refNo + ' submitted to the Technical Section');
        });
      }).catch(function (err) {
        formError(form, err.message || 'The letter could not be submitted.');
        if (editingId) loadServerState();
      }).then(function () {
        if (submit) submit.disabled = false;
      });
    }
    function readUpload(file, label) {
      if (!file || !file.name) return Promise.resolve(null);
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          var extension = file.name.toLowerCase().split('.').pop();
          var types = {
            pdf: 'application/pdf',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            png: 'image/png',
            docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          };
          resolve({ name: file.name, type: types[extension] || file.type, data: reader.result });
        };
        reader.onerror = function () { reject(new Error(label + ' could not be read.')); };
        reader.readAsDataURL(file);
      });
    }
    Promise.all([
      readUpload(signedLetterFile, 'The signed letter'),
      readUpload(wordDocumentFile, 'The Word document')
    ]).then(function (files) {
      if (files[0]) payload.signedLetter = files[0];
      if (files[1]) payload.wordDocument = files[1];
      sendSubmission();
    }).catch(function (err) {
      formError(form, err.message || 'The selected files could not be read.');
      if (submit) submit.disabled = false;
    });
  }

  function openSectionSubmissionEdit(id) {
    var letter = byId(id);
    if (!canEditSectionSubmission(letter)) return;
    openModal('<form class="modal-form">' +
      '<div class="modal-head"><div><p class="modal-eyebrow">' + esc(letter.refNo) + '</p><h2>Edit submitted letter</h2></div>' +
      '<button class="icon-btn" type="button" data-action="close-modal" aria-label="Close">' + iconClose() + '</button></div>' +
      '<div class="modal-body"><div class="form-grid">' +
      '<label class="field span-2"><span>Subject</span><input name="subject" value="' + esc(letter.subject) + '" maxlength="240" required></label>' +
      '<label class="field"><span>Your letter number / date</span><input name="fromRef" value="' + esc(letter.fromRef) + '" maxlength="120"></label>' +
      '<label class="field"><span>Date received</span><input type="date" name="receivedOn" value="' + esc(dateInputValue(letter.receivedOn)) + '" required></label>' +
      '<label class="field span-2"><span>Replace signed letter (optional; PDF, JPG, or PNG up to 8 MB)</span>' +
      '<input type="file" name="signedLetter" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"></label>' +
      '<label class="field span-2"><span>Replace Word document (optional; DOCX up to 8 MB)</span>' +
      '<input type="file" name="wordDocument" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"></label>' +
      '<label class="field span-2"><span>Remarks (optional)</span><textarea name="remarks" rows="2" maxlength="1000">' + esc(letter.remarks) + '</textarea></label>' +
      '</div>' +
      (letter.attachment ? '<p class="form-note">Current signed letter: <a class="linkish" href="/api/letters/' + encodeURIComponent(letter.id) + '/attachment">' + esc(letter.attachment.name) + '</a></p>' : '') +
      (letter.wordDocument ? '<p class="form-note">Current Word document: <a class="linkish" href="/api/letters/' + encodeURIComponent(letter.id) + '/word-document">' + esc(letter.wordDocument.name) + '</a></p>' : '') +
      '<p class="form-error" data-form-error hidden></p></div>' +
      '<div class="modal-foot"><button class="btn" type="button" data-action="close-modal">Cancel</button>' +
      '<button class="btn btn-primary" type="submit">Save changes</button></div></form>',
      function (fd, form) { submitSectionLetter(form, id); });
  }

  function deleteSectionSubmission(id) {
    var letter = byId(id);
    if (!canEditSectionSubmission(letter)) return;
    confirmDialog('Delete submitted letter', 'Delete ' + letter.refNo + ' — “' + letter.subject + '”? This cannot be undone.', 'Delete letter', function () {
      apiRequest('/api/submissions/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
        return apiRequest('/api/state');
      }).then(function (serverState) {
        applyServerState(serverState);
        toast('Letter ' + letter.refNo + ' deleted');
      }).catch(function (err) {
        loadServerState();
        toast(err.message || 'The letter could not be deleted.');
      });
    });
  }

  function renderSections() {
    if (!isAuthorized('management')) return;
    var list = $('[data-region="sections"]');
    var count = $('[data-region="section-count"]');
    if (!list) return;

    if (count) {
      count.textContent = state.settings.sections.length + ' sections · ' +
        state.letters.length + ' letters in the register';
    }

    list.innerHTML = state.settings.sections.map(function (name) {
      var used = sectionUsage(name);
      var userCount = managedAccounts.filter(function (account) {
        return account.role === 'section_user' && account.sectionName === name;
      }).length;
      return '<li class="section-row">' +
        '<span class="section-name">' + esc(name) + '</span>' +
        '<span class="tag">' + (used ? used + ' letter' + (used === 1 ? '' : 's') : 'None yet') + '</span>' +
        '<span class="tag ' + (userCount ? '' : 'tag-warning') + '">' + (userCount ? userCount + ' user' + (userCount === 1 ? '' : 's') : 'No user') + '</span>' +
        '<button class="btn btn-tiny" type="button" data-action="new-section-account" data-id="' + esc(name) + '">Add user</button>' +
        '<button class="btn btn-tiny btn-danger" type="button" data-action="remove-section" data-id="' + esc(name) + '">Remove</button>' +
        '</li>';
    }).join('');

    var note = $('[data-region="manage-note"]');
    if (note) {
      note.innerHTML = iconInfo() + '<span>Removing a section stops it appearing for new letters. Letters already recorded keep the section name and remain in the register.</span>';
    }
  }

  function renderAccounts() {
    var panel = $('[data-region="account-management"]');
    var rows = $('[data-region="accounts"]');
    var empty = $('[data-region="accounts-empty"]');
    if (!panel || !rows) return;
    panel.hidden = !isMainAdministrator();
    if (!isMainAdministrator()) return;
    apiRequest('/api/accounts').then(function (result) {
      managedAccounts = result.accounts || [];
      var count = $('[data-region="account-count"]');
      if (count) count.textContent = managedAccounts.length + ' account' + (managedAccounts.length === 1 ? '' : 's');
      rows.innerHTML = managedAccounts.map(function (account) {
        var access = account.isMainAdmin ? 'Main admin' : (account.role === 'section_user'
          ? 'Section user · ' + account.sectionName
          : 'Administrator');
        return '<tr>' +
          '<td class="cell-letter"><strong>' + esc(account.username) + '</strong></td>' +
          '<td>' + esc(access) + '</td>' +
          '<td class="account-actions">' +
          '<button class="btn btn-tiny" type="button" data-action="' + (account.isMainAdmin ? 'edit-main-admin' : 'edit-account') + '" data-id="' + esc(account.id) + '">Change login</button>' +
          (account.isMainAdmin ? '' : ' <button class="btn btn-tiny btn-danger" type="button" data-action="remove-account" data-id="' + esc(account.id) + '">Remove</button>') +
          '</td></tr>';
      }).join('');
      if (empty) empty.innerHTML = '';
      $('.account-table').hidden = managedAccounts.length === 0;
      renderSections();
    }).catch(function (err) { toast(err.message); });
  }

  function openAccountForm(id, defaultRole, defaultSection) {
    if (!isMainAdministrator()) return;
    var account = id ? managedAccounts.filter(function (item) { return item.id === id; })[0] : null;
    if (id && !account) return;
    var role = account ? account.role : (defaultRole || 'admin');
    var sectionName = account ? account.sectionName : (defaultSection || '');
    var sectionOptions = state.settings.sections.map(function (section) {
      return '<option value="' + esc(section) + '"' + (section === sectionName ? ' selected' : '') + '>' + esc(section) + '</option>';
    }).join('');
    openModal('<form class="modal-form">' +
      '<div class="modal-head"><div><p class="modal-eyebrow">Account access</p><h2>' +
      (account ? 'Change account login' : role === 'section_user' ? 'Create section user' : 'Create administrator') + '</h2></div>' +
      '<button class="icon-btn" type="button" data-action="close-modal" aria-label="Close">' + iconClose() + '</button></div>' +
      '<div class="modal-body"><div class="form-grid">' +
      '<label class="field"><span>Username</span><input name="username" value="' + esc(account ? account.username : '') + '" maxlength="24" required autocomplete="off"></label>' +
      '<label class="field"><span>' + (account ? 'Set new password (optional)' : 'Password') + '</span><input type="password" name="password" minlength="8" ' + (!account ? 'required ' : '') + 'autocomplete="new-password"></label>' +
      '<label class="field"><span>Confirm password</span><input type="password" name="password2" ' + (!account ? 'required ' : '') + 'autocomplete="new-password"></label>' +
      '<label class="field"><span>Account type</span><select name="role"' + (account && account.isMainAdmin ? ' disabled' : '') + '>' +
      '<option value="admin"' + (role === 'admin' ? ' selected' : '') + '>Administrator</option>' +
      '<option value="section_user"' + (role === 'section_user' ? ' selected' : '') + '>Section user</option>' +
      '</select></label>' +
      '<label class="field span-2" data-account-section' + (role === 'section_user' ? '' : ' hidden') + '><span>Assigned section</span><select name="sectionName">' +
      '<option value="">Select a section</option>' + sectionOptions + '</select></label>' +
      '</div><p class="form-note">Passwords are stored as salted hashes in the server database.</p><p class="form-error" data-form-error hidden></p></div>' +
      '<div class="modal-foot"><button class="btn" type="button" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">' + (account ? 'Save account' : 'Create account') + '</button></div>' +
      '</form>', function (fd, form) { saveAccount(fd, form, account); });
    var roleInput = $('select[name="role"]', modalEl);
    if (roleInput) roleInput.addEventListener('change', function () {
      var sectionField = $('[data-account-section]', modalEl);
      if (sectionField) sectionField.hidden = roleInput.value !== 'section_user';
    });
  }

  function saveAccount(fd, form, existing) {
    if (!isMainAdministrator()) return;
    var username = String(fd.get('username') || '').trim();
    var password = String(fd.get('password') || '');
    var confirmPassword = String(fd.get('password2') || '');
    var role = String(fd.get('role') || 'admin') === 'section_user' ? 'section_user' : 'admin';
    var sectionName = String(fd.get('sectionName') || '').trim();
    if (!USERNAME_RE.test(username)) {
      formError(form, 'The username needs 3 to 24 letters, digits, dots, dashes or underscores.');
      return Promise.resolve();
    }
    if (!existing && password.length < 8) {
      formError(form, 'Use a password of at least 8 characters.');
      return Promise.resolve();
    }
    if (password && password.length < 8) {
      formError(form, 'Use a password of at least 8 characters.');
      return Promise.resolve();
    }
    if (password !== confirmPassword) {
      formError(form, 'The two password entries do not match.');
      return Promise.resolve();
    }
    if (role === 'section_user' && !sectionName) {
      formError(form, 'Choose the section this user belongs to.');
      return Promise.resolve();
    }

    return apiRequest(existing ? '/api/accounts/' + encodeURIComponent(existing.id) : '/api/accounts', {
      method: existing ? 'PATCH' : 'POST',
      body: { username: username, password: password, role: role, sectionName: sectionName }
    }).then(function () {
      closeModal();
      renderAccounts();
      renderSessionChip();
      toast(existing ? 'Administrator login updated' : 'User created');
    }).catch(function (err) { formError(form, err.message); });
  }

  function removeAccount(id) {
    if (!isMainAdministrator()) return;
    var account = managedAccounts.filter(function (item) { return item.id === id; })[0];
    if (!account) return;
    confirmDialog('Remove account', 'Remove access for “' + account.username + '”? This does not affect letters or their history.', 'Remove account', function () {
      apiRequest('/api/accounts/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
        renderAccounts();
        toast('Administrator removed');
      }).catch(function (err) { toast(err.message); });
    });
  }

  function openMainAdminForm() {
    if (!isMainAdministrator()) return;
    openModal('<form class="modal-form">' +
      '<div class="modal-head"><div><p class="modal-eyebrow">Main admin</p><h2>Change Main admin login</h2></div>' +
      '<button class="icon-btn" type="button" data-action="close-modal" aria-label="Close">' + iconClose() + '</button></div>' +
      '<div class="modal-body"><div class="form-grid">' +
      '<label class="field span-2"><span>Username</span><input name="username" value="' + esc(currentUser.username) + '" maxlength="24" required autocomplete="off"></label>' +
      '<label class="field"><span>New password (optional)</span><input type="password" name="password" minlength="8" autocomplete="new-password"></label>' +
      '<label class="field"><span>Confirm new password</span><input type="password" name="password2" autocomplete="new-password"></label>' +
      '</div><p class="form-note">Leave the password blank to keep it unchanged.</p><p class="form-error" data-form-error hidden></p></div>' +
      '<div class="modal-foot"><button class="btn" type="button" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">Save Main admin login</button></div>' +
      '</form>', function (fd, form) { saveMainAdmin(fd, form); });
  }

  function saveMainAdmin(fd, form) {
    if (!isMainAdministrator()) return;
    var username = String(fd.get('username') || '').trim();
    var password = String(fd.get('password') || '');
    if (!USERNAME_RE.test(username)) {
      formError(form, 'The username needs 3 to 24 letters, digits, dots, dashes or underscores.');
      return Promise.resolve();
    }
    if (password && password.length < 8) {
      formError(form, 'Use a password of at least 8 characters.');
      return Promise.resolve();
    }
    if (password !== String(fd.get('password2') || '')) {
      formError(form, 'The two password entries do not match.');
      return Promise.resolve();
    }
    return apiRequest('/api/main-admin', { method: 'PATCH', body: { username: username, password: password } })
      .then(function () {
        return apiRequest('/api/me');
      }).then(function (result) {
        currentUser = result.user;
        closeModal();
        renderSessionChip();
        renderAccounts();
        toast('Main admin login updated');
      }).catch(function (err) { formError(form, err.message); });
  }

  function addSection(form) {
    if (!isAuthorized('management')) return;
    var input = form.querySelector('input[name="name"]');
    var name = String(input.value || '').replace(/\s+/g, ' ').trim();
    if (name.length < 2) {
      toast('Enter a section name.');
      input.focus();
      return;
    }
    if (name.length > 60) {
      toast('Keep the section name under 60 characters.');
      return;
    }
    var exists = state.settings.sections.some(function (s) {
      return s.toLowerCase() === name.toLowerCase();
    });
    if (exists) {
      toast('That section is already in the list.');
      input.select();
      return;
    }

    state.settings.sections.push(name);
    persist().then(function () {
      input.value = '';
      input.focus();
      syncShell();
      renderSections();
      toast(name + ' added');
    }).catch(function (err) {
      state.settings.sections = state.settings.sections.filter(function (section) { return section !== name; });
      toast(err.message || 'The section could not be saved.');
    });
  }

  function confirmDialog(title, message, confirmLabel, onConfirm) {
    openModal('<div class="modal-head">' +
      '<div><p class="modal-eyebrow">Please confirm</p><h2>' + esc(title) + '</h2></div>' +
      '<button class="icon-btn" type="button" data-action="close-modal" aria-label="Close">' + iconClose() + '</button>' +
      '</div>' +
      '<div class="modal-body"><p class="confirm-text">' + esc(message) + '</p></div>' +
      '<div class="modal-foot">' +
      '<button class="btn" type="button" data-action="close-modal">Cancel</button>' +
      '<button class="btn btn-danger" type="button" id="confirm-yes">' + esc(confirmLabel) + '</button>' +
      '</div>', null, { small: true });

    var yes = $('#confirm-yes');
    if (yes) {
      yes.addEventListener('click', function () {
        closeModal();
        onConfirm();
      });
    }
  }

  function removeSection(name) {
    if (!isAuthorized('management')) return;
    var assignedUsers = managedAccounts.filter(function (account) {
      return account.role === 'section_user' && account.sectionName === name;
    }).length;
    if (assignedUsers) {
      toast('Reassign or remove the ' + assignedUsers + ' section user' + (assignedUsers === 1 ? '' : 's') + ' before removing this section.');
      return;
    }
    var used = sectionUsage(name);
    var message = 'Remove “' + name + '” from the section list?';
    if (used) {
      message += ' ' + used + ' existing letter' + (used === 1 ? '' : 's') +
        ' use this section. They keep the name and stay in the register.';
    }
    confirmDialog('Remove section', message, 'Remove section', function () {
      var previousSections = state.settings.sections.slice();
      state.settings.sections = state.settings.sections.filter(function (s) { return s !== name; });
      persist().then(function () {
        syncShell();
        renderSections();
        toast(name + ' removed');
      }).catch(function (err) {
        state.settings.sections = previousSections;
        syncShell();
        renderSections();
        toast(err.message || 'The section could not be removed.');
      });
    });
  }

  /* ---------------------------------------------------------
     Admin register
     --------------------------------------------------------- */

  var af = { q: '', status: '', section: '', officer: '' };
  var adminTab = 'open';

  function wireManagementPage() {
    var form = $('#add-section-form');
    if (!form) return;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      addSection(form);
    });
  }

  function wireAdminPage() {
    var q = $('#a-q');
    if (!q) return;
    q.addEventListener('input', function () { af.q = q.value; renderAdminTable(); });
    var status = $('#a-status');
    if (status) status.addEventListener('change', function () { af.status = status.value; renderAdminTable(); });
    var section = $('#a-section');
    if (section) section.addEventListener('change', function () { af.section = section.value; renderAdminTable(); });
    var officer = $('#a-officer');
    if (officer) officer.addEventListener('change', function () { af.officer = officer.value; renderAdminTable(); });
    $$('[data-admin-tab]').forEach(function (button) {
      button.addEventListener('click', function () {
        adminTab = button.getAttribute('data-admin-tab') === 'dispatched' ? 'dispatched' : 'open';
        renderAdminTable();
      });
    });
  }

  function rowHtml(l) {
    var days = stageDays(l);
    var archived = isArchived(l);
    var sentLine = l.status === 'dispatched'
      ? (archived ? 'Archived · left the board' : hoursLeft(l) + ' h left on board')
      : '';

    return '<tr class="' + (archived ? 'is-archived' : '') + '">' +
      '<td class="cell-letter">' +
      '<span class="ref">' + esc(l.refNo) + '</span>' +
      '<strong>' + esc(l.subject) + '</strong>' +
      '<small>' + esc(l.fromSection) + ' · ' + esc(l.priority) + ' priority</small>' +
      '</td>' +
      '<td class="cell-from">' + esc(l.fromSection) + '</td>' +
      '<td class="cell-pos">' +
      '<span class="pill s-' + l.status + '">' + STATUS[l.status].label + '</span>' +
      '<span class="pos">' + esc(positionOf(l)) + (sentLine ? ' · ' + esc(sentLine) : '') + '</span>' +
      '</td>' +
      '<td class="cell-recd">' + fmtDate(l.receivedOn) + ageChip(days) + '</td>' +
      '<td class="cell-act"><button class="btn btn-tiny" type="button" data-action="admin-letter" data-id="' + esc(l.id) + '">Open</button></td>' +
      '</tr>';
  }

  function renderAdminTable() {
    if (!isAuthorized('admin')) return;
    var rowsEl = $('[data-region="rows"]');
    if (!rowsEl) return;
    var emptyEl = $('[data-region="table-empty"]');
    var table = $('.data-table');

    var all = state.letters.slice();
    var archivedCount = all.filter(isArchived).length;
    var list = all.filter(function (l) {
      return adminTab === 'dispatched' ? l.status === 'dispatched' : l.status !== 'dispatched';
    });
    var filtered = applyFilters(list, af);
    filtered.sort(function (a, b) {
      return (parseISO(a.createdAt) || 0) - (parseISO(b.createdAt) || 0) || String(a.id).localeCompare(String(b.id));
    });

    var openTab = $('[data-admin-tab="open"]');
    var dispatchedTab = $('[data-admin-tab="dispatched"]');
    if (openTab) {
      openTab.setAttribute('aria-pressed', adminTab === 'open' ? 'true' : 'false');
      openTab.classList.toggle('is-active', adminTab === 'open');
      $('[data-region="open-count"]').textContent = all.filter(function (l) { return l.status !== 'dispatched'; }).length;
    }
    if (dispatchedTab) {
      dispatchedTab.setAttribute('aria-pressed', adminTab === 'dispatched' ? 'true' : 'false');
      dispatchedTab.classList.toggle('is-active', adminTab === 'dispatched');
      $('[data-region="dispatched-count"]').textContent = all.filter(function (l) { return l.status === 'dispatched'; }).length;
    }

    rowsEl.innerHTML = filtered.map(rowHtml).join('');
    if (table) table.hidden = filtered.length === 0;
    if (emptyEl) {
      if (filtered.length) {
        emptyEl.innerHTML = '';
      } else if (!state.letters.length) {
        emptyEl.innerHTML = '<div class="table-empty"><strong>No letters recorded yet</strong>' +
          'Use “New letter” to enter the first letter received by the section.</div>';
      } else {
        var emptyLabel = adminTab === 'dispatched' ? 'No dispatched letters match these filters' : 'No open letters match these filters';
        emptyEl.innerHTML = '<div class="table-empty"><strong>' + emptyLabel + '</strong>' +
          'Clear the search or choose another stage.</div>';
      }
    }

    var open = all.filter(function (l) { return l.status !== 'dispatched'; }).length;
    var sent = all.length - open;
    var countEl = $('[data-region="admin-count"]');
    if (countEl) {
      countEl.textContent = open + ' open · ' + sent + ' dispatched · ' + archivedCount + ' archived from the board';
    }

    var note = $('[data-region="storage-note"]');
    if (note) {
      note.classList.toggle('is-warn', !storageOk);
      note.innerHTML = iconInfo() + '<span>' + (storageOk
        ? 'Records are stored in the shared SQLite database (' + state.letters.length + ' letters). Download a backup regularly.'
        : 'The server database is unavailable. Changes may not be saved; check the portal server.') + '</span>';
    }
  }

  /* ---------------------------------------------------------
     Settings, backup and sample data
     --------------------------------------------------------- */

  function openSettings() {
    if (!isAdministrator()) return;
    var s = state.settings;

    openModal('<form class="modal-form" id="settings-form">' +
      '<div class="modal-head">' +
      '<div><p class="modal-eyebrow">Portal setup</p><h2>Settings &amp; backup</h2></div>' +
      '<button class="icon-btn" type="button" data-action="close-modal" aria-label="Close">' + iconClose() + '</button>' +
      '</div>' +
      '<div class="modal-body">' +
      '<h3 class="form-subhead">Office details</h3>' +
      '<div class="form-grid">' +
      '<label class="field span-2"><span>Shed / office name</span><input name="shed" value="' + esc(s.shed) + '" required></label>' +
      '<label class="field"><span>Section name</span><input name="unit" value="' + esc(s.unit) + '" required></label>' +
      '<label class="field"><span>Recorded by</span><input name="adminName" value="' + esc(s.adminName) + '" placeholder="Name shown in history"></label>' +
      '<label class="field"><span>Letter reference prefix</span><input name="refPrefix" value="' + esc(s.refPrefix) + '" placeholder="ELX/ED/TS"></label>' +
      '<label class="field"><span>Delayed after (days)</span><input type="number" name="slaDays" min="1" max="30" value="' + esc(String(s.slaDays)) + '"></label>' +
      '</div>' +
      '<hr class="form-sep">' +
      '<h3 class="form-subhead">Officers and dispatch routes</h3>' +
      '<div class="form-grid">' +
      '<label class="field"><span>Officers (comma separated)</span>' +
      '<input name="officers" value="' + esc(s.officers.join(', ')) + '"></label>' +
      '<label class="field"><span>Dispatch routes</span>' +
      '<input name="modes" value="' + esc(s.modes.join(', ')) + '"></label>' +
      '</div>' +
      '<p class="form-note">Sections are added and removed on the <a class="linkish" href="management.html">Management page</a>.</p>' +
      '<p class="form-error" data-form-error hidden></p>' +
      '<hr class="form-sep">' +
      '<h3 class="form-subhead">Backup and data</h3>' +
      '<div class="action-bar">' +
      btnAction('export-json', '', 'Download backup', '') +
      btnAction('export-csv', '', 'Register as CSV', '') +
      btnAction('import-json', '', 'Restore backup', '') +
      btnAction('sample-data', '', 'Load sample letters', '') +
      btnAction('erase-data', '', 'Erase all letters', 'btn-danger') +
      '</div>' +
      '<p class="form-note">A backup is a single JSON file, restored over the letters held in this browser. Keep a copy before changing computers.</p>' +
      '<input type="file" id="import-file" accept="application/json,.json" hidden>' +
      '</div>' +
      '<div class="modal-foot">' +
      '<button class="btn" type="button" data-action="close-modal">Cancel</button>' +
      '<button class="btn btn-primary" type="submit">Save settings</button>' +
      '</div>' +
      '</form>', function (fd, form) {
        return saveSettings(fd, form);
      });

    var fileInput = $('#import-file');
    if (fileInput) {
      fileInput.addEventListener('change', function () {
        var file = fileInput.files && fileInput.files[0];
        if (file) handleImport(file);
        fileInput.value = '';
      });
    }
  }

  function saveSettings(fd, form) {
    if (!isAdministrator()) return Promise.resolve();
    var shed = String(fd.get('shed') || '').trim();
    var unit = String(fd.get('unit') || '').trim();
    if (!shed || !unit) {
      formError(form, 'The shed name and section name cannot be blank.');
      return Promise.resolve();
    }

    var next = {
      shed: shed,
      unit: unit,
      adminName: String(fd.get('adminName') || '').trim() || DEFAULT_SETTINGS.adminName,
      refPrefix: normalizePrefix(fd.get('refPrefix')),
      sections: state.settings.sections.slice(),
      officers: cleanList(String(fd.get('officers') || ''), DEFAULT_SETTINGS.officers),
      modes: cleanList(String(fd.get('modes') || ''), DEFAULT_SETTINGS.modes),
      slaDays: Math.min(30, Math.max(1, Number(fd.get('slaDays')) || DEFAULT_SETTINGS.slaDays))
    };

    state.settings = next;
    return persist().then(function (saved) {
      if (!saved) return;
      closeModal();
      syncShell();
      renderSessionChip();
      refreshAdmin();
      toast('Settings saved');
    });
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function stamp() {
    var d = new Date();
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  }

  function exportJson() {
    var payload = {
      app: 'elx-letter-monitor',
      version: 1,
      exportedAt: nowISO(),
      settings: state.settings,
      letters: state.letters
    };
    download('letter-register-' + stamp() + '.json', JSON.stringify(payload, null, 2), 'application/json');
    toast('Backup downloaded');
  }

  function csvCell(value) {
    var s = String(value == null ? '' : value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCsv() {
    var head = ['Reference', 'Subject', 'From section', 'Their reference', 'Received on', 'Stage', 'Current position',
      'Officer', 'Priority', 'Signed on', 'Dispatched on', 'Route', 'Dispatch reference', 'Remarks'];
    var rows = state.letters.slice().sort(adminSort).map(function (l) {
      return [
        l.refNo, l.subject, l.fromSection, l.fromRef, fmtDate(l.receivedOn), STATUS[l.status].label, positionOf(l),
        l.officer, l.priority, l.signedOn ? fmtDate(l.signedOn) : '',
        l.dispatchedAt ? fmtDateTime(l.dispatchedAt) : '', l.dispatchMode, l.dispatchRef, l.remarks
      ];
    });
    var csv = [head].concat(rows).map(function (row) {
      return row.map(csvCell).join(',');
    }).join('\r\n');
    download('letter-register-' + stamp() + '.csv', '\ufeff' + csv, 'text/csv');
    toast('Register exported as CSV');
  }

  function handleImport(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try {
        data = JSON.parse(String(reader.result));
      } catch (err) {
        toast('That file is not a portal backup.');
        return;
      }
      var letters = Array.isArray(data) ? data : (data && Array.isArray(data.letters) ? data.letters : null);
      if (!letters) {
        toast('That backup does not contain any letters.');
        return;
      }
      var next;
      try {
        next = normalize({
          settings: (data && data.settings) || state.settings,
          letters: letters
        });
      } catch (err) {
        toast('That backup could not be read.');
        return;
      }
      var ok = window.confirm('Replace the ' + state.letters.length + ' letter(s) in this browser with the ' +
        next.letters.length + ' letter(s) from this backup?\n\nThe current records will be overwritten.');
      if (!ok) return;
      state = next;
      persist();
      syncShell();
      closeModal();
      refreshAdmin();
      toast('Backup restored — ' + state.letters.length + ' letters loaded');
    };
    reader.onerror = function () { toast('The file could not be read.'); };
    reader.readAsText(file);
  }

  function addSamples() {
    var prefix = state.settings.refPrefix;
    var year = new Date().getFullYear();
    var seq = nextSequence();
    var by = state.settings.adminName;
    var t = function (msAgo) { return new Date(Date.now() - msAgo).toISOString(); };
    var startedAt = nowISO();

    var rows = [
      {
        subject: 'Provision of LED flood lighting on pit line no. 3',
        fromSection: 'Tech 2 - Amrith Bharath', fromRef: 'AB/ED/2026/114 dt. 04.11.2026',
        priority: 'Routine', receivedOn: t(2 * DAY), status: 'received', stageSince: t(2 * DAY),
        history: [{ at: t(2 * DAY), action: 'Received from Tech 2 - Amrith Bharath', status: 'received' }]
      },
      {
        subject: 'Replacement of damaged cable tray near traction motor bay T-12',
        fromSection: 'Tech 10A - E3TM', fromRef: 'TM/ED/2026/078',
        priority: 'Urgent', receivedOn: t(3 * DAY), status: 'drafting', stageSince: t(2 * DAY),
        history: [
          { at: t(3 * DAY), action: 'Received from Tech 10A - E3TM', status: 'received' },
          { at: t(2 * DAY), action: 'Draft preparation started', status: 'drafting' }
        ]
      },
      {
        subject: 'Revision of maintenance instruction for carbon brush replacement',
        fromSection: 'Tech 46 - Maintenance Instruction', fromRef: 'MI/ED/2026/021',
        priority: 'Routine', receivedOn: t(5 * DAY), status: 'with_officer', stageSince: t(4 * DAY + 3 * HOUR),
        officer: 'ADEE-1', draftRef: 'TS/D/2026/31',
        history: [
          { at: t(5 * DAY), action: 'Received from Tech 46 - Maintenance Instruction', status: 'received' },
          { at: t(4 * DAY + 5 * HOUR), action: 'Draft preparation started', status: 'drafting' },
          { at: t(4 * DAY + 3 * HOUR), action: 'Submitted to ADEE-1 for signature', status: 'with_officer', note: 'Draft ref. TS/D/2026/31' }
        ]
      },
      {
        subject: 'Procurement of carbon brushes for WAG-9 fleet',
        fromSection: 'Tech 47 - Material & Stores', fromRef: 'MS/ED/2026/410',
        priority: 'Urgent', receivedOn: t(2 * DAY), status: 'with_officer', stageSince: t(DAY + 4 * HOUR),
        officer: 'DEE', draftRef: 'TS/D/2026/34',
        history: [
          { at: t(2 * DAY), action: 'Received from Tech 47 - Material & Stores', status: 'received' },
          { at: t(DAY + 6 * HOUR), action: 'Draft preparation started', status: 'drafting' },
          { at: t(DAY + 4 * HOUR), action: 'Submitted to DEE for signature', status: 'with_officer', note: 'Draft ref. TS/D/2026/34' }
        ]
      },
      {
        subject: 'Repair to compressed air line in the shed workshop',
        fromSection: 'Tech 12 - Pneumatic', fromRef: 'PN/ED/2026/192',
        priority: 'Routine', receivedOn: t(4 * DAY), status: 'signed', stageSince: t(20 * HOUR),
        officer: 'DEE', signedOn: t(20 * HOUR), draftRef: 'TS/D/2026/29',
        history: [
          { at: t(4 * DAY), action: 'Received from Tech 12 - Pneumatic', status: 'received' },
          { at: t(3 * DAY), action: 'Draft preparation started', status: 'drafting' },
          { at: t(2 * DAY), action: 'Submitted to DEE for signature', status: 'with_officer' },
          { at: t(20 * HOUR), action: 'Signed by DEE', status: 'signed' }
        ]
      },
      {
        subject: 'Payment of annual maintenance contract for shed lift',
        fromSection: 'Tech 41 - SIV', fromRef: 'SV/ED/2026/055',
        priority: 'Routine', receivedOn: t(4 * DAY), status: 'dispatched', stageSince: t(20 * HOUR),
        officer: 'ADEE-2', signedOn: t(2 * DAY), dispatchedAt: t(20 * HOUR),
        dispatchMode: 'E-Office', dispatchRef: 'EO/ED/2026/884',
        history: [
          { at: t(4 * DAY), action: 'Received from Tech 41 - SIV', status: 'received' },
          { at: t(3 * DAY), action: 'Draft preparation started', status: 'drafting' },
          { at: t(3 * DAY), action: 'Submitted to ADEE-2 for signature', status: 'with_officer' },
          { at: t(2 * DAY), action: 'Signed by ADEE-2', status: 'signed' },
          { at: t(20 * HOUR), action: 'Dispatched via E-Office', status: 'dispatched', note: 'e-Dispatch ref. EO/ED/2026/884' }
        ]
      },
      {
        subject: 'Compliance of safety audit observations — quarter ending September',
        fromSection: 'Tech 13 - Safety Audit', fromRef: 'SA/ED/2026/018',
        priority: 'Immediate', receivedOn: t(7 * DAY), status: 'with_officer', stageSince: t(5 * DAY),
        officer: 'Sr.DEE', draftRef: 'TS/D/2026/26',
        history: [
          { at: t(7 * DAY), action: 'Received from Tech 13 - Safety Audit', status: 'received' },
          { at: t(6 * DAY), action: 'Draft preparation started', status: 'drafting' },
          { at: t(5 * DAY), action: 'Submitted to Sr.DEE for signature', status: 'with_officer' }
        ]
      },
      {
        subject: 'Action taken on KAVACH failure reported by a loco pilot',
        fromSection: 'Tech 48 - KAVACH', fromRef: 'KV/ED/2026/301',
        priority: 'Urgent', receivedOn: t(4 * DAY), status: 'dispatched', stageSince: t(3 * DAY),
        officer: 'ADEE-1', signedOn: t(3 * DAY + 6 * HOUR), dispatchedAt: t(3 * DAY),
        dispatchMode: 'Telegram', dispatchRef: 'TG/2026/57',
        history: [
          { at: t(4 * DAY), action: 'Received from Tech 48 - KAVACH', status: 'received' },
          { at: t(3 * DAY + 8 * HOUR), action: 'Draft preparation started', status: 'drafting' },
          { at: t(3 * DAY + 7 * HOUR), action: 'Submitted to ADEE-1 for signature', status: 'with_officer' },
          { at: t(3 * DAY + 6 * HOUR), action: 'Signed by ADEE-1', status: 'signed' },
          { at: t(3 * DAY), action: 'Dispatched via Telegram', status: 'dispatched' }
        ]
      },
      {
        subject: 'Renovation of crew rest room and replacement of ceiling fans',
        fromSection: 'Tech 1 - General', fromRef: 'GN/ED/2026/312',
        priority: 'Immediate', receivedOn: t(3 * HOUR), status: 'received', stageSince: t(3 * HOUR),
        history: [{ at: t(3 * HOUR), action: 'Received from Tech 1 - General', status: 'received' }]
      }
    ];

    rows.forEach(function (row) {
      var letter = fixLetter(Object.assign({}, row, {
        id: uid(),
        refNo: prefix + '/' + year + '/' + String(seq++).padStart(3, '0'),
        createdAt: row.receivedOn,
        updatedAt: startedAt
      }));
      letter.history = letter.history.map(function (h) {
        return Object.assign({ by: by }, h);
      });
      state.letters.push(letter);
    });

    return rows.length;
  }

  /* ---------------------------------------------------------
     Actions and events
     --------------------------------------------------------- */

  function handleAction(action, id) {
    switch (action) {
      case 'close-modal':
        closeModal();
        break;
      case 'clear-view-filters':
        clearViewFilters();
        break;
      case 'open-letter':
        openViewLetter(id);
        break;
      case 'download-signed-pdf':
        openSignedPdfLogin(id);
        break;
      case 'new-letter':
        openLetterForm();
        break;
      case 'edit-letter':
        openLetterForm(id);
        break;
      case 'edit-submission':
        openSectionSubmissionEdit(id);
        break;
      case 'delete-submission':
        deleteSectionSubmission(id);
        break;
      case 'admin-letter':
        openAdminLetter(id);
        break;
      case 'start-draft':
        startDraft(id);
        break;
      case 'submit-officer':
        openSubmit(id);
        break;
      case 'mark-signed':
        openSign(id);
        break;
      case 'mark-dispatched':
        openDispatch(id);
        break;
      case 'return-draft':
        openReturn(id);
        break;
      case 'reopen-letter':
        reopenLetter(id);
        break;
      case 'delete-letter':
        deleteLetter(id);
        break;
      case 'download-signed-pdf':
        openSignedPdfLogin(id);
        break;
      case 'settings':
        openSettings();
        break;
      case 'new-account':
        openAccountForm();
        break;
      case 'new-admin-account':
        openAccountForm(null, 'admin');
        break;
      case 'new-section-account':
        openAccountForm(null, 'section_user', id);
        break;
      case 'edit-account':
        openAccountForm(id);
        break;
      case 'edit-main-admin':
        openMainAdminForm();
        break;
      case 'remove-account':
        removeAccount(id);
        break;
      case 'lock':
        apiRequest('/api/logout', { method: 'POST' }).catch(function () {}).then(function () {
          closeSessions();
          refreshCurrentPage();
          toast('Signed out');
        });
        break;
      case 'new-captcha':
        refreshCaptchaDisplay();
        break;
      case 'remove-section':
        removeSection(id);
        break;
      case 'export-json':
        exportJson();
        break;
      case 'export-csv':
        exportCsv();
        break;
      case 'import-json': {
        var file = $('#import-file');
        if (file) file.click();
        break;
      }
      case 'sample-data': {
        var added = addSamples();
        persist();
        closeModal();
        refreshAdmin();
        toast(added + ' sample letters added — edit or delete them from the register');
        break;
      }
      case 'erase-data':
        if (!state.letters.length) {
          toast('There are no letters to erase.');
          break;
        }
        if (!window.confirm('Erase all ' + state.letters.length + ' letter records from this browser?\n\nDownload a backup first if you may need them.')) break;
        if (!window.confirm('This cannot be undone. Erase every letter record now?')) break;
        state.letters = [];
        persist();
        closeModal();
        refreshAdmin();
        toast('All letter records erased');
        break;
      default:
        break;
    }
  }

  function tick() {
    updateClock();
    loadServerState();
  }

  function init() {
    initializeTheme();
    modalEl = $('#modal');
    var themeButton = $('[data-theme-toggle]');
    if (themeButton) themeButton.addEventListener('click', toggleTheme);

    if (modalEl) {
      modalEl.addEventListener('submit', function (ev) {
        if (!modalSubmit || !ev.target.closest('.modal-form')) return;
        ev.preventDefault();
        var submitter = modalSubmit;
        try {
          Promise.resolve(submitter(new FormData(ev.target), ev.target)).catch(function (err) {
            console.error(err);
            toast('Something went wrong. Please try again.');
          });
        } catch (err) {
          console.error(err);
          toast('Something went wrong. Please try again.');
        }
      });
      modalEl.addEventListener('click', function (ev) {
        if (ev.target === modalEl) closeModal();
      });
      modalEl.addEventListener('close', function () {
        modalSubmit = null;
        modalEl.innerHTML = '';
        if (pendingModal) {
          var next = pendingModal;
          pendingModal = null;
          showModal(next);
        }
      });
    }

    document.addEventListener('click', function (ev) {
      var el = ev.target.closest('[data-action]');
      if (!el) return;
      var action = el.getAttribute('data-action');
      if (el.tagName === 'A') ev.preventDefault();
      handleAction(action, el.getAttribute('data-id') || '');
    });

    syncShell();

    if (page === 'admin') {
      wireAdminPage();
      refreshAdmin();
    } else if (page === 'management') {
      wireManagementPage();
      refreshManagement();
    } else if (page === 'section') {
      wireSectionPage();
      refreshSectionPage();
    } else {
      wireView();
      refreshView();
    }

    apiRequest('/api/me').then(function (result) {
      currentUser = result.user;
      return loadServerState();
    }).catch(function () {
      loadServerState();
    });

    setInterval(tick, 20000);

    window.addEventListener('pageshow', function (ev) {
      if (!ev.persisted) return;
      apiRequest('/api/me').then(function (result) {
        currentUser = result.user;
        return loadServerState();
      }).catch(function () { loadServerState(); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
