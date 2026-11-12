/* SQLite-backed letter portal. Requires Node.js 24+ for node:sqlite. */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const root = __dirname;
const dataDir = path.join(root, 'data');
const port = Number(process.env.PORT) || 5173;
const host = process.env.HOST || '127.0.0.1';
const SESSION_EXPIRES_AT = Date.UTC(9999, 11, 31, 23, 59, 59);
const SESSION_COOKIE_MAX_AGE = 2147483647;
const SESSION_COOKIE_EXPIRES = new Date(SESSION_EXPIRES_AT).toUTCString();
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
const PASSWORD_ITERATIONS = 210000;
const USERNAME_RE = /^[A-Za-z0-9._-]{3,24}$/;
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};

fs.mkdirSync(dataDir, { recursive: true });
const keyPath = path.join(dataDir, 'app.key');
if (!fs.existsSync(keyPath)) fs.writeFileSync(keyPath, crypto.randomBytes(32), { flag: 'wx' });
const appKey = fs.readFileSync(keyPath);
if (appKey.length !== 32) throw new Error('data/app.key must contain a 32-byte key.');

const db = new DatabaseSync(path.join(dataDir, 'portal.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    username_hash TEXT NOT NULL UNIQUE,
    username_cipher TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_main_admin INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'admin',
    section_name TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS portal_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    settings_json TEXT NOT NULL,
    letters_json TEXT NOT NULL,
    initialized INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS letter_attachments (
    letter_id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS word_document_attachments (
    letter_id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS signed_letter_attachments (
    letter_id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  INSERT OR IGNORE INTO portal_state (id, settings_json, letters_json, initialized)
    VALUES (1, '{}', '[]', 0);
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('accounts', 'role', "TEXT NOT NULL DEFAULT 'admin'");
ensureColumn('accounts', 'section_name', 'TEXT');
ensureColumn('portal_state', 'revision', 'INTEGER NOT NULL DEFAULT 0');

function hashUsername(username) {
  return crypto.createHmac('sha256', appKey).update(username.trim().toLowerCase()).digest('hex');
}

function encryptUsername(username) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', appKey, iv);
  const encrypted = Buffer.concat([cipher.update(username, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('hex')).join('.');
}

function decryptUsername(value) {
  const [ivHex, tagHex, dataHex] = value.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', appKey, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

function sessionCookie(token) {
  return `elx_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE}; Expires=${SESSION_COOKIE_EXPIRES}${COOKIE_SECURE}`;
}

function safeEqualHex(left, right) {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function seedMainAdmin() {
  if (db.prepare('SELECT 1 FROM accounts WHERE is_main_admin = 1').get()) return;
  const username = 'roy';
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto.pbkdf2Sync('asdfasdf', salt, PASSWORD_ITERATIONS, 32, 'sha256').toString('hex');
  db.prepare(`INSERT INTO accounts
    (id, username_hash, username_cipher, password_salt, password_hash, is_main_admin, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)`)
    .run('main-admin', hashUsername(username), encryptUsername(username), salt, passwordHash, new Date().toISOString());
}

seedMainAdmin();

const captchaChallenges = new Map();
const consonants = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function sendJson(res, status, value, headers) {
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  }, headers || {}));
  res.end(JSON.stringify(value));
}

function readBody(req, maxBytes) {
  maxBytes = maxBytes || 5 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(Object.assign(new Error('Request is too large.'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(Object.assign(new Error('Invalid JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function sessionAccount(req) {
  const cookie = String(req.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith('elx_session='));
  if (!cookie) return null;
  const tokenHash = crypto.createHash('sha256').update(decodeURIComponent(cookie.slice('elx_session='.length))).digest('hex');
  const row = db.prepare(`SELECT a.id, a.username_cipher, a.is_main_admin, a.role, a.section_name, s.expires_at
    FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?`).get(tokenHash);
  if (!row || row.expires_at <= Date.now()) {
    if (row) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  return {
    id: row.id,
    username: decryptUsername(row.username_cipher),
    isMainAdmin: !!row.is_main_admin,
    role: row.role,
    sectionName: row.section_name || ''
  };
}

function requireLogin(req, res, mainAdminOnly) {
  const user = sessionAccount(req);
  if (!user) {
    sendJson(res, 401, { error: 'Sign in is required.' });
    return null;
  }
  if (mainAdminOnly && !user.isMainAdmin) {
    sendJson(res, 403, { error: 'Only the Main admin can manage accounts.' });
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireLogin(req, res, false);
  if (!user) return null;
  if (user.role !== 'admin') {
    sendJson(res, 403, { error: 'Administrator access is required.' });
    return null;
  }
  return user;
}

function requireSectionUser(req, res) {
  const user = requireLogin(req, res, false);
  if (!user) return null;
  if (user.role !== 'section_user' || !user.sectionName) {
    sendJson(res, 403, { error: 'A section user account is required.' });
    return null;
  }
  return user;
}

function ownsSectionSubmission(letter, user) {
  if (!letter || letter.fromSection !== user.sectionName) return false;
  if (letter.submittedByUserId) return letter.submittedByUserId === user.id;
  return Array.isArray(letter.history) && letter.history.some((entry) =>
    entry.action === 'Submitted by section user' && entry.by === user.username);
}

function activeSection(name) {
  const row = db.prepare('SELECT settings_json FROM portal_state WHERE id = 1').get();
  const settings = JSON.parse(row.settings_json);
  return Array.isArray(settings.sections) && settings.sections.includes(name);
}

function sectionReferenceCode(section) {
  const techMatch = String(section || '').match(/^Tech\s+(\d+[A-Za-z]?)/i);
  if (techMatch) return techMatch[1].toUpperCase();
  return String(section || '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 12) || 'OTHER';
}

function nextSectionReference(section, settings, letters) {
  const code = sectionReferenceCode(section);
  const base = String(settings.refPrefix || 'TS') + '/' + code + '/';
  let count = 0;
  let maxSequence = 0;
  for (const letter of letters) {
    if (sectionReferenceCode(letter.fromSection) !== code) continue;
    count++;
    if (!String(letter.refNo || '').startsWith(base)) continue;
    const sequence = Number(String(letter.refNo).slice(base.length));
    if (Number.isInteger(sequence) && sequence > maxSequence) maxSequence = sequence;
  }
  return base + (Math.max(count, maxSequence) + 1);
}

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

function parseAttachment(value) {
  if (!value || typeof value !== 'object') throw Object.assign(new Error('Upload the source letter.'), { status: 400 });
  const filename = path.basename(String(value.name || '').replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  const contentType = String(value.type || '').toLowerCase();
  const encoded = String(value.data || '').replace(/^data:[^,]*;base64,/, '');
  if (!filename || filename.length > 180) throw Object.assign(new Error('Use a filename under 180 characters.'), { status: 400 });
  if (!ALLOWED_ATTACHMENT_TYPES.has(contentType)) {
    throw Object.assign(new Error('Upload a PDF, JPG, PNG, or DOCX file.'), { status: 400 });
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw Object.assign(new Error('The uploaded file is invalid.'), { status: 400 });
  const data = Buffer.from(encoded, 'base64');
  if (!data.length || data.length > MAX_ATTACHMENT_BYTES || data.toString('base64') !== encoded) {
    throw Object.assign(new Error('The source letter must be no larger than 8 MB.'), { status: 400 });
  }
  return { filename, contentType, data };
}

function parseSignedLetter(value) {
  const file = parseAttachment(value);
  const extension = path.extname(file.filename).toLowerCase();
  const expectedType = extension === '.pdf' ? 'application/pdf'
    : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
      : extension === '.png' ? 'image/png' : '';
  if (!expectedType || file.contentType !== expectedType) {
    throw Object.assign(new Error('Upload the signed letter as a PDF, JPG, or PNG.'), { status: 400 });
  }
  return file;
}

function parseWordDocument(value) {
  const file = parseAttachment(value);
  if (path.extname(file.filename).toLowerCase() !== '.docx' ||
      file.contentType !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    throw Object.assign(new Error('Upload the Word document as a DOCX file.'), { status: 400 });
  }
  return file;
}

function parseSignedPdf(value) {
  const attachment = parseAttachment(Object.assign({}, value, { type: 'application/pdf' }));
  if (!/\.pdf$/i.test(attachment.filename) || attachment.data.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw Object.assign(new Error('Choose a valid PDF file for the signed letter.'), { status: 400 });
  }
  return attachment;
}

function withSignedPdfNames(letters) {
  const files = db.prepare('SELECT letter_id, filename FROM signed_letter_attachments').all();
  const names = new Map(files.map((file) => [file.letter_id, file.filename]));
  return letters.map((letter) => Object.assign({}, letter, {
    signedPdfName: names.get(String(letter.id)) || ''
  }));
}

function accountByUsername(username) {
  const row = db.prepare('SELECT * FROM accounts WHERE username_hash = ?').get(hashUsername(username));
  if (!row) return null;
  return Object.assign({}, row, { username: decryptUsername(row.username_cipher) });
}

function createAccount(username, password, isMainAdmin, role, sectionName) {
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, 'sha256').toString('hex');
  db.prepare(`INSERT INTO accounts
    (id, username_hash, username_cipher, password_salt, password_hash, is_main_admin, role, section_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(isMainAdmin ? 'main-admin' : crypto.randomUUID(), hashUsername(username), encryptUsername(username), salt,
      passwordHash, isMainAdmin ? 1 : 0, isMainAdmin ? 'admin' : role, isMainAdmin ? null : sectionName || null,
      new Date().toISOString());
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/captcha') {
    const id = crypto.randomUUID();
    const code = Array.from({ length: 4 }, () => consonants[crypto.randomInt(consonants.length)]).join('');
    captchaChallenges.set(id, { code, expires: Date.now() + 5 * 60 * 1000 });
    return sendJson(res, 200, { id, code });
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const body = await readBody(req);
    const challenge = captchaChallenges.get(String(body.captchaId || ''));
    captchaChallenges.delete(String(body.captchaId || ''));
    if (!challenge || challenge.expires < Date.now() || challenge.code !== String(body.captcha || '').trim().toUpperCase()) {
      return sendJson(res, 400, { error: 'The verification code is incorrect. Try the new code.' });
    }
    const username = String(body.username || '').trim();
    if (!USERNAME_RE.test(username)) return sendJson(res, 401, { error: 'Username or password is incorrect.' });
    const account = accountByUsername(username);
    const candidate = crypto.pbkdf2Sync(String(body.password || ''), account ? account.password_salt : 'unknown-user-salt',
      PASSWORD_ITERATIONS, 32, 'sha256').toString('hex');
    if (!account || !safeEqualHex(candidate, account.password_hash)) {
      return sendJson(res, 401, { error: 'Username or password is incorrect.' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    db.prepare('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash, account.id, SESSION_EXPIRES_AT);
    return sendJson(res, 200, { user: {
      id: account.id,
      username: account.username,
      isMainAdmin: !!account.is_main_admin,
      role: account.role,
      sectionName: account.section_name || ''
    } }, {
      'set-cookie': sessionCookie(token)
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const user = sessionAccount(req);
    if (user) {
      const cookie = String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('elx_session='));
      const token = decodeURIComponent(cookie.slice('elx_session='.length));
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(crypto.createHash('sha256').update(token).digest('hex'));
    }
    return sendJson(res, 200, { ok: true }, { 'set-cookie': 'elx_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' + COOKIE_SECURE });
  }

  if (req.method === 'GET' && url.pathname === '/api/me') {
    const user = sessionAccount(req);
    if (!user) return sendJson(res, 200, { user: null });
    const cookie = String(req.headers.cookie || '').split(';').map((part) => part.trim())
      .find((part) => part.startsWith('elx_session='));
    const token = decodeURIComponent(cookie.slice('elx_session='.length));
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(SESSION_EXPIRES_AT, tokenHash);
    return sendJson(res, 200, { user }, { 'set-cookie': sessionCookie(token) });
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const row = db.prepare('SELECT settings_json, letters_json, initialized, revision FROM portal_state WHERE id = 1').get();
    const user = sessionAccount(req);
    const settings = JSON.parse(row.settings_json);
    const letters = JSON.parse(row.letters_json);
    if (user && user.role === 'section_user') {
      return sendJson(res, 200, {
        settings: {
          shed: settings.shed,
          unit: settings.unit,
          refPrefix: settings.refPrefix,
          sections: [user.sectionName]
        },
        letters,
        initialized: !!row.initialized,
        revision: row.revision
      });
    }
    return sendJson(res, 200, {
      settings,
      letters: withSignedPdfNames(letters),
      initialized: !!row.initialized,
      revision: row.revision
    });
  }

  if (req.method === 'PUT' && url.pathname === '/api/state') {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req, 12 * 1024 * 1024);
    if (!body.settings || !Array.isArray(body.letters)) return sendJson(res, 400, { error: 'Invalid portal state.' });
    let signedPdf = null;
    if (body.signedPdf) {
      const signedLetterId = String(body.signedPdf.letterId || '');
      const signedLetter = body.letters.find((letter) => String(letter.id) === signedLetterId);
      if (!signedLetter || signedLetter.status !== 'dispatched') {
        return sendJson(res, 400, { error: 'A signed PDF can only be attached to a dispatched letter.' });
      }
      signedPdf = Object.assign(parseSignedPdf(body.signedPdf), { letterId: signedLetterId });
    }
    const lettersForStorage = body.letters.map(({ signedPdfName, ...letter }) => letter);
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT revision FROM portal_state WHERE id = 1').get();
      if (!Number.isInteger(body.revision) || body.revision !== current.revision) {
        db.exec('ROLLBACK');
        return sendJson(res, 409, { error: 'The register changed in another session. Reload the page before saving again.' });
      }
      const activeSections = new Set(body.settings.sections || []);
      const assigned = db.prepare("SELECT DISTINCT section_name FROM accounts WHERE role = 'section_user' AND section_name IS NOT NULL").all();
      if (assigned.some((row) => !activeSections.has(row.section_name))) {
        db.exec('ROLLBACK');
        return sendJson(res, 409, { error: 'Reassign or remove section users before removing their section.' });
      }
      const revision = current.revision + 1;
      db.prepare('UPDATE portal_state SET settings_json = ?, letters_json = ?, initialized = 1, revision = ? WHERE id = 1')
        .run(JSON.stringify(body.settings), JSON.stringify(lettersForStorage), revision);
      const retainedLetterIds = new Set(body.letters.map((letter) => String(letter.id)));
      for (const attachment of db.prepare('SELECT letter_id FROM letter_attachments').all()) {
        if (!retainedLetterIds.has(attachment.letter_id)) {
          db.prepare('DELETE FROM letter_attachments WHERE letter_id = ?').run(attachment.letter_id);
        }
      }
      for (const attachment of db.prepare('SELECT letter_id FROM word_document_attachments').all()) {
        if (!retainedLetterIds.has(attachment.letter_id)) {
          db.prepare('DELETE FROM word_document_attachments WHERE letter_id = ?').run(attachment.letter_id);
        }
      }
      for (const attachment of db.prepare('SELECT letter_id FROM signed_letter_attachments').all()) {
        if (!retainedLetterIds.has(attachment.letter_id)) {
          db.prepare('DELETE FROM signed_letter_attachments WHERE letter_id = ?').run(attachment.letter_id);
        }
      }
      if (signedPdf) {
        db.prepare(`INSERT INTO signed_letter_attachments (letter_id, filename, content_type, data, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(letter_id) DO UPDATE SET filename = excluded.filename, content_type = excluded.content_type,
            data = excluded.data, created_at = excluded.created_at`)
          .run(signedPdf.letterId, signedPdf.filename, signedPdf.contentType, signedPdf.data, new Date().toISOString());
      }
      db.exec('COMMIT');
      return sendJson(res, 200, { ok: true, revision });
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/submissions') {
    const user = requireSectionUser(req, res);
    if (!user) return;
    const body = await readBody(req, 24 * 1024 * 1024);
    const subject = String(body.subject || '').trim();
    const fromRef = String(body.fromRef || '').trim();
    const remarks = String(body.remarks || '').trim();
    const receivedOn = String(body.receivedOn || '');
    const receivedTime = Date.parse(receivedOn);
    if (!subject || subject.length > 240) return sendJson(res, 400, { error: 'Enter a subject under 240 characters.' });
    if (fromRef.length > 120 || remarks.length > 1000) return sendJson(res, 400, { error: 'The reference or remarks are too long.' });
    if (!Number.isFinite(receivedTime)) return sendJson(res, 400, { error: 'Enter a valid received date.' });
    let attachment;
    let wordDocument;
    try {
      attachment = body.signedLetter ? parseSignedLetter(body.signedLetter)
        : body.attachment ? parseAttachment(body.attachment) : null;
      wordDocument = body.wordDocument ? parseWordDocument(body.wordDocument) : null;
    }
    catch (err) { return sendJson(res, err.status || 400, { error: err.message }); }

    db.exec('BEGIN IMMEDIATE');
    try {
      if (!activeSection(user.sectionName)) {
        db.exec('ROLLBACK');
        return sendJson(res, 409, { error: 'Your assigned section is no longer active. Contact the Main admin.' });
      }
      const row = db.prepare('SELECT settings_json, letters_json, revision FROM portal_state WHERE id = 1').get();
      const settings = JSON.parse(row.settings_json);
      const letters = JSON.parse(row.letters_json);
      const now = new Date().toISOString();
      const letter = {
        id: crypto.randomUUID(),
        refNo: nextSectionReference(user.sectionName, settings, letters),
        submittedByUserId: user.id,
        subject,
        fromSection: user.sectionName,
        fromRef,
        priority: 'Routine',
        remarks,
        receivedOn: new Date(receivedTime).toISOString(),
        status: 'received',
        stageSince: new Date(receivedTime).toISOString(),
        officer: '',
        draftRef: '',
        signedOn: null,
        dispatchMode: '',
        dispatchRef: '',
        dispatchedAt: null,
        history: [{ at: now, action: 'Submitted by section user', status: 'received', by: user.username }],
        createdAt: now,
        updatedAt: now,
        attachment: attachment ? { name: attachment.filename, type: attachment.contentType } : null,
        wordDocument: wordDocument ? { name: wordDocument.filename, type: wordDocument.contentType } : null
      };
      letters.push(letter);
      const revision = row.revision + 1;
      if (attachment) {
        db.prepare('INSERT INTO letter_attachments (letter_id, filename, content_type, data, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(letter.id, attachment.filename, attachment.contentType, attachment.data, now);
      }
      if (wordDocument) {
        db.prepare('INSERT INTO word_document_attachments (letter_id, filename, content_type, data, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(letter.id, wordDocument.filename, wordDocument.contentType, wordDocument.data, now);
      }
      db.prepare('UPDATE portal_state SET letters_json = ?, initialized = 1, revision = ? WHERE id = 1')
        .run(JSON.stringify(letters), revision);
      db.exec('COMMIT');
      return sendJson(res, 201, { ok: true, letter, revision });
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const submissionMatch = url.pathname.match(/^\/api\/submissions\/([a-f0-9-]+)$/i);
  if (submissionMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const user = requireSectionUser(req, res);
    if (!user) return;
    let body = {};
    let attachment = null;
    let wordDocument = null;
    let values = null;
    if (req.method === 'PATCH') {
      body = await readBody(req, 24 * 1024 * 1024);
      const subject = String(body.subject || '').trim();
      const fromRef = String(body.fromRef || '').trim();
      const remarks = String(body.remarks || '').trim();
      const receivedOn = String(body.receivedOn || '');
      const receivedTime = Date.parse(receivedOn);
      if (!subject || subject.length > 240) return sendJson(res, 400, { error: 'Enter a subject under 240 characters.' });
      if (fromRef.length > 120 || remarks.length > 1000) return sendJson(res, 400, { error: 'The reference or remarks are too long.' });
      if (!Number.isFinite(receivedTime)) return sendJson(res, 400, { error: 'Enter a valid received date.' });
      try {
        attachment = body.signedLetter ? parseSignedLetter(body.signedLetter)
          : body.attachment ? parseAttachment(body.attachment) : null;
        wordDocument = body.wordDocument ? parseWordDocument(body.wordDocument) : null;
      }
      catch (err) { return sendJson(res, err.status || 400, { error: err.message }); }
      values = { subject, fromRef, remarks, receivedOn: new Date(receivedTime).toISOString() };
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT letters_json, revision FROM portal_state WHERE id = 1').get();
      const letters = JSON.parse(row.letters_json);
      const index = letters.findIndex((letter) => letter.id === submissionMatch[1]);
      const letter = letters[index];
      if (!ownsSectionSubmission(letter, user)) {
        db.exec('ROLLBACK');
        return sendJson(res, 404, { error: 'Your submitted letter was not found.' });
      }
      if (letter.status !== 'received') {
        db.exec('ROLLBACK');
        return sendJson(res, 409, { error: 'This letter is now being handled by the Technical Section. Only an administrator can edit or delete it.' });
      }
      const revision = row.revision + 1;
      if (req.method === 'DELETE') {
        letters.splice(index, 1);
        db.prepare('DELETE FROM letter_attachments WHERE letter_id = ?').run(letter.id);
        db.prepare('DELETE FROM word_document_attachments WHERE letter_id = ?').run(letter.id);
        db.prepare('UPDATE portal_state SET letters_json = ?, revision = ? WHERE id = 1')
          .run(JSON.stringify(letters), revision);
        db.exec('COMMIT');
        return sendJson(res, 200, { ok: true, revision });
      }

      const now = new Date().toISOString();
      letter.subject = values.subject;
      letter.fromRef = values.fromRef;
      letter.remarks = values.remarks;
      letter.receivedOn = values.receivedOn;
      letter.updatedAt = now;
      letter.history = Array.isArray(letter.history) ? letter.history : [];
      letter.history.push({ at: now, action: 'Section submission updated', status: 'received', by: user.username });
      if (attachment) {
        letter.attachment = { name: attachment.filename, type: attachment.contentType };
        db.prepare(`INSERT INTO letter_attachments (letter_id, filename, content_type, data, created_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(letter_id) DO UPDATE SET
          filename = excluded.filename, content_type = excluded.content_type,
          data = excluded.data, created_at = excluded.created_at`)
          .run(letter.id, attachment.filename, attachment.contentType, attachment.data, now);
      }
      if (wordDocument) {
        letter.wordDocument = { name: wordDocument.filename, type: wordDocument.contentType };
        db.prepare(`INSERT INTO word_document_attachments (letter_id, filename, content_type, data, created_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(letter_id) DO UPDATE SET
          filename = excluded.filename, content_type = excluded.content_type,
          data = excluded.data, created_at = excluded.created_at`)
          .run(letter.id, wordDocument.filename, wordDocument.contentType, wordDocument.data, now);
      }
      db.prepare('UPDATE portal_state SET letters_json = ?, revision = ? WHERE id = 1')
        .run(JSON.stringify(letters), revision);
      db.exec('COMMIT');
      return sendJson(res, 200, { ok: true, letter, revision });
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const attachmentMatch = url.pathname.match(/^\/api\/letters\/([a-f0-9-]+)\/attachment$/i);
  if (attachmentMatch && req.method === 'GET') {
    const user = requireLogin(req, res, false);
    if (!user) return;
    const row = db.prepare('SELECT filename, content_type, data FROM letter_attachments WHERE letter_id = ?').get(attachmentMatch[1]);
    if (!row) return sendJson(res, 404, { error: 'Source letter not found.' });
    if (user.role !== 'admin') {
      if (user.role !== 'section_user' || !user.sectionName) {
        return sendJson(res, 403, { error: 'You cannot access this source letter.' });
      }
      const stateRow = db.prepare('SELECT letters_json FROM portal_state WHERE id = 1').get();
      const letter = JSON.parse(stateRow.letters_json).find((item) => item.id === attachmentMatch[1]);
      if (!letter || letter.fromSection !== user.sectionName) {
        return sendJson(res, 403, { error: 'You cannot access this source letter.' });
      }
    }
    const encodedFilename = encodeURIComponent(row.filename.toWellFormed()).replace(/['()*]/g, (char) =>
      '%' + char.charCodeAt(0).toString(16).toUpperCase());
    res.writeHead(200, {
      'content-type': row.content_type,
      'content-disposition': `attachment; filename="source-letter"; filename*=UTF-8''${encodedFilename}`,
      'content-length': row.data.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    return res.end(row.data);
  }

  const wordDocumentMatch = url.pathname.match(/^\/api\/letters\/([a-f0-9-]+)\/word-document$/i);
  if (wordDocumentMatch && req.method === 'GET') {
    const user = requireLogin(req, res, false);
    if (!user) return;
    const letterId = wordDocumentMatch[1];
    const row = db.prepare('SELECT filename, content_type, data FROM word_document_attachments WHERE letter_id = ?').get(letterId);
    if (!row) return sendJson(res, 404, { error: 'Word document not found.' });
    if (user.role !== 'admin') {
      if (user.role !== 'section_user' || !user.sectionName) {
        return sendJson(res, 403, { error: 'You cannot access this Word document.' });
      }
      const stateRow = db.prepare('SELECT letters_json FROM portal_state WHERE id = 1').get();
      const letter = JSON.parse(stateRow.letters_json).find((item) => item.id === letterId);
      if (!letter || letter.fromSection !== user.sectionName) {
        return sendJson(res, 403, { error: 'You cannot access this Word document.' });
      }
    }
    const encodedFilename = encodeURIComponent(row.filename.toWellFormed()).replace(/['()*]/g, (char) =>
      '%' + char.charCodeAt(0).toString(16).toUpperCase());
    res.writeHead(200, {
      'content-type': row.content_type,
      'content-disposition': `attachment; filename="word-document"; filename*=UTF-8''${encodedFilename}`,
      'content-length': row.data.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    return res.end(row.data);
  }

  const signedPdfMatch = url.pathname.match(/^\/api\/letters\/([a-z0-9-]+)\/signed-pdf$/i);
  if (signedPdfMatch && req.method === 'GET') {
    const user = requireLogin(req, res, false);
    if (!user) return;
    const stateRow = db.prepare('SELECT letters_json FROM portal_state WHERE id = 1').get();
    const letter = JSON.parse(stateRow.letters_json).find((item) => item.id === signedPdfMatch[1]);
    if (!letter || letter.status !== 'dispatched') return sendJson(res, 404, { error: 'Signed letter not found.' });
    if (user.role !== 'admin' && !(user.role === 'section_user' && user.sectionName === letter.fromSection)) {
      return sendJson(res, 403, { error: 'You cannot access this signed letter.' });
    }
    const row = db.prepare('SELECT filename, data FROM signed_letter_attachments WHERE letter_id = ?').get(signedPdfMatch[1]);
    if (!row) return sendJson(res, 404, { error: 'Signed letter not found.' });
    const encodedFilename = encodeURIComponent(row.filename.toWellFormed()).replace(/['()*]/g, (char) =>
      '%' + char.charCodeAt(0).toString(16).toUpperCase());
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="signed-letter.pdf"; filename*=UTF-8''${encodedFilename}`,
      'content-length': row.data.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    return res.end(row.data);
  }

  if (req.method === 'GET' && url.pathname === '/api/accounts') {
    if (!requireLogin(req, res, true)) return;
    const accounts = db.prepare('SELECT id, username_cipher, is_main_admin, role, section_name FROM accounts ORDER BY is_main_admin DESC, role, section_name, username_hash').all()
      .map((row) => ({
        id: row.id,
        username: decryptUsername(row.username_cipher),
        isMainAdmin: !!row.is_main_admin,
        role: row.role,
        sectionName: row.section_name || ''
      }));
    return sendJson(res, 200, { accounts });
  }

  if (req.method === 'GET' && url.pathname === '/api/drafters') {
    if (!requireAdmin(req, res)) return;
    const drafters = db.prepare(`SELECT username_cipher FROM accounts
      WHERE is_main_admin = 1 OR role = 'admin' ORDER BY is_main_admin DESC, username_hash`).all()
      .map((row) => decryptUsername(row.username_cipher));
    return sendJson(res, 200, { drafters });
  }

  if (url.pathname === '/api/main-admin' && req.method === 'PATCH') {
    if (!requireLogin(req, res, true)) return;
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!USERNAME_RE.test(username)) return sendJson(res, 400, { error: 'Username must be 3 to 24 letters, numbers, dots, dashes, or underscores.' });
    const duplicate = accountByUsername(username);
    if (duplicate && !duplicate.is_main_admin) return sendJson(res, 409, { error: 'That username is already in use.' });
    if (password && password.length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
    const current = db.prepare('SELECT password_salt, password_hash FROM accounts WHERE is_main_admin = 1').get();
    const salt = password ? crypto.randomBytes(16).toString('hex') : current.password_salt;
    const passwordHash = password
      ? crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, 'sha256').toString('hex')
      : current.password_hash;
    db.prepare(`UPDATE accounts SET username_hash = ?, username_cipher = ?, password_salt = ?, password_hash = ?
      WHERE is_main_admin = 1`).run(hashUsername(username), encryptUsername(username), salt, passwordHash);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/api/accounts' && req.method === 'POST') {
    if (!requireLogin(req, res, true)) return;
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const role = body.role === 'section_user' ? 'section_user' : 'admin';
    const sectionName = role === 'section_user' ? String(body.sectionName || '').trim() : '';
    if (!USERNAME_RE.test(username)) return sendJson(res, 400, { error: 'Username must be 3 to 24 letters, numbers, dots, dashes, or underscores.' });
    if (password.length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
    if (role === 'section_user' && !activeSection(sectionName)) return sendJson(res, 400, { error: 'Choose an active section for this user.' });
    if (accountByUsername(username)) return sendJson(res, 409, { error: 'That username is already in use.' });
    createAccount(username, password, false, role, sectionName);
    return sendJson(res, 201, { ok: true });
  }

  const accountMatch = url.pathname.match(/^\/api\/accounts\/([a-f0-9-]+)$/i);
  if (accountMatch && req.method === 'PATCH') {
    if (!requireLogin(req, res, true)) return;
    const body = await readBody(req);
    const account = db.prepare('SELECT id, is_main_admin, role, section_name FROM accounts WHERE id = ?').get(accountMatch[1]);
    if (!account || account.is_main_admin) return sendJson(res, 404, { error: 'Administrator account not found.' });
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const role = body.role === 'section_user' ? 'section_user' : 'admin';
    const sectionName = role === 'section_user' ? String(body.sectionName || '').trim() : '';
    if (!USERNAME_RE.test(username)) return sendJson(res, 400, { error: 'Username must be 3 to 24 letters, numbers, dots, dashes, or underscores.' });
    if (role === 'section_user' && !activeSection(sectionName)) return sendJson(res, 400, { error: 'Choose an active section for this user.' });
    const duplicate = accountByUsername(username);
    if (duplicate && duplicate.id !== account.id) return sendJson(res, 409, { error: 'That username is already in use.' });
    if (password && password.length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
    const salt = password ? crypto.randomBytes(16).toString('hex') : null;
    const passwordHash = password ? crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, 'sha256').toString('hex') : null;
    if (password) {
      db.prepare(`UPDATE accounts SET username_hash = ?, username_cipher = ?, password_salt = ?, password_hash = ?, role = ?, section_name = ? WHERE id = ?`)
        .run(hashUsername(username), encryptUsername(username), salt, passwordHash, role, sectionName || null, account.id);
    } else {
      db.prepare('UPDATE accounts SET username_hash = ?, username_cipher = ?, role = ?, section_name = ? WHERE id = ?')
        .run(hashUsername(username), encryptUsername(username), role, sectionName || null, account.id);
    }
    return sendJson(res, 200, { ok: true });
  }

  if (accountMatch && req.method === 'DELETE') {
    if (!requireLogin(req, res, true)) return;
    const result = db.prepare('DELETE FROM accounts WHERE id = ? AND is_main_admin = 0').run(accountMatch[1]);
    if (!result.changes) return sendJson(res, 404, { error: 'Administrator account not found.' });
    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 404, { error: 'API route not found.' });
}

function serveStatic(req, res, urlPath) {
  let filePath = path.resolve(root, '.' + (urlPath === '/' ? '/index.html' : urlPath));
  const relative = path.relative(root, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative === 'data' || relative.startsWith('data' + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }
  fs.stat(filePath, (statErr, stat) => {
    if (!statErr && stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      res.writeHead(200, {
        'content-type': types[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      });
      res.end(data);
    });
  });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url || '/', 'http://localhost'); }
  catch { res.writeHead(400); return res.end('Bad request'); }
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'Server error.' });
    });
    return;
  }
  let urlPath;
  try { urlPath = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); return res.end('Bad request'); }
  serveStatic(req, res, urlPath);
});

server.listen(port, host, () => {
  console.log('Letter portal running at http://127.0.0.1:' + port);
  console.log('SQLite database: ' + path.join(dataDir, 'portal.sqlite'));
  console.log('Initial Main admin account is seeded; change its temporary password after signing in.');
});
