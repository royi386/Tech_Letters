/* SQLite-backed letter portal. Requires Node.js 24+ for node:sqlite. */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
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
  CREATE TABLE IF NOT EXISTS portal_screenshot_attachments (
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

const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const MAX_BACKUP_ENTRIES = 60000;
const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let archiveSize = 22;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.from(file.data);
    if (!name.length || name.length > 0xffff || data.length > 0xffffffff) {
      throw new Error('A backup file exceeds the ZIP format limits.');
    }
    archiveSize += 76 + name.length * 2 + data.length;
    if (archiveSize > MAX_BACKUP_BYTES) throw new Error('The backup exceeds the 256 MB limit.');
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  if (files.length > MAX_BACKUP_ENTRIES) throw new Error('Too many files in the backup.');
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat(localParts.concat(centralDirectory, end));
}

function readZip(data) {
  if (data.length < 22 || data.length > MAX_BACKUP_BYTES) {
    throw Object.assign(new Error('The ZIP backup is empty or exceeds the 256 MB limit.'), { status: 400 });
  }
  const minimum = Math.max(0, data.length - 22 - 0xffff);
  let endOffset = -1;
  for (let offset = data.length - 22; offset >= minimum; offset--) {
    if (data.readUInt32LE(offset) === 0x06054b50) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw Object.assign(new Error('The selected file is not a valid ZIP backup.'), { status: 400 });
  const disk = data.readUInt16LE(endOffset + 4);
  const centralDisk = data.readUInt16LE(endOffset + 6);
  const diskEntries = data.readUInt16LE(endOffset + 8);
  const entryCount = data.readUInt16LE(endOffset + 10);
  const centralSize = data.readUInt32LE(endOffset + 12);
  const centralOffset = data.readUInt32LE(endOffset + 16);
  if (disk || centralDisk || diskEntries !== entryCount || entryCount > MAX_BACKUP_ENTRIES ||
      centralOffset + centralSize > endOffset) {
    throw Object.assign(new Error('The ZIP backup has an unsupported structure.'), { status: 400 });
  }
  const files = new Map();
  let offset = centralOffset;
  let totalSize = 0;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) {
      throw Object.assign(new Error('The ZIP backup directory is invalid.'), { status: 400 });
    }
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const checksum = data.readUInt32LE(offset + 16);
    const compressedSize = data.readUInt32LE(offset + 20);
    const uncompressedSize = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    const centralEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (centralEnd > data.length || (flags & 1) || (method !== 0 && method !== 8) ||
        compressedSize === 0xffffffff || uncompressedSize === 0xffffffff ||
        uncompressedSize > MAX_BACKUP_BYTES || totalSize + uncompressedSize > MAX_BACKUP_BYTES) {
      throw Object.assign(new Error('The ZIP backup contains an unsupported or oversized file.'), { status: 400 });
    }
    const nameBytes = data.subarray(offset + 46, offset + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    if (!name || !Buffer.from(name, 'utf8').equals(nameBytes) || files.has(name)) {
      throw Object.assign(new Error('The ZIP backup contains an invalid or duplicate filename.'), { status: 400 });
    }
    if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== 0x04034b50) {
      throw Object.assign(new Error('The ZIP backup file data is invalid.'), { status: 400 });
    }
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const fileStart = localOffset + 30 + localNameLength + localExtraLength;
    const fileEnd = fileStart + compressedSize;
    if (fileEnd > data.length) throw Object.assign(new Error('The ZIP backup file data is truncated.'), { status: 400 });
    const compressed = data.subarray(fileStart, fileEnd);
    let contents;
    try {
      contents = method === 0 ? Buffer.from(compressed)
        : zlib.inflateRawSync(compressed, { maxOutputLength: MAX_BACKUP_BYTES });
    } catch {
      throw Object.assign(new Error('A file in the ZIP backup could not be decompressed.'), { status: 400 });
    }
    if (contents.length !== uncompressedSize || crc32(contents) !== checksum) {
      throw Object.assign(new Error('A file in the ZIP backup failed its integrity check.'), { status: 400 });
    }
    totalSize += contents.length;
    files.set(name, contents);
    offset = centralEnd;
  }
  return files;
}

function readBinaryBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > maxBytes) {
        reject(Object.assign(new Error('The uploaded backup exceeds the size limit.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks, length)));
    req.on('error', reject);
  });
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

function sectionCanAccessLetter(letterId, user) {
  if (!user.sectionName) return false;
  const row = db.prepare('SELECT letters_json FROM portal_state WHERE id = 1').get();
  const letter = JSON.parse(row.letters_json).find((item) => item.id === letterId);
  return !!letter && letter.fromSection === user.sectionName;
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

function parseSourcePdf(value) {
  const attachment = parseAttachment(Object.assign({}, value, { type: 'application/pdf' }));
  if (!/\.pdf$/i.test(attachment.filename) || attachment.data.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw Object.assign(new Error('Choose a valid PDF file for the source letter.'), { status: 400 });
  }
  return attachment;
}

function parsePortalScreenshot(value) {
  const attachment = parseAttachment(value);
  const extension = path.extname(attachment.filename).toLowerCase();
  const isPng = extension === '.png' && attachment.contentType === 'image/png' &&
    attachment.data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = (extension === '.jpg' || extension === '.jpeg') && attachment.contentType === 'image/jpeg' &&
    attachment.data[0] === 0xff && attachment.data[1] === 0xd8;
  if (!isPng && !isJpeg) {
    throw Object.assign(new Error('Choose a valid PNG or JPG screenshot.'), { status: 400 });
  }
  return attachment;
}

function withAttachmentNames(letters) {
  const files = db.prepare('SELECT letter_id, filename FROM signed_letter_attachments').all();
  const signedNames = new Map(files.map((file) => [file.letter_id, file.filename]));
  const screenshotFiles = db.prepare('SELECT letter_id, filename FROM portal_screenshot_attachments').all();
  const screenshotNames = new Map(screenshotFiles.map((file) => [file.letter_id, file.filename]));
  return letters.map((letter) => Object.assign({}, letter, {
    signedPdfName: signedNames.get(String(letter.id)) || '',
    portalScreenshotName: screenshotNames.get(String(letter.id)) || ''
  }));
}

function makeBackup() {
  const row = db.prepare('SELECT settings_json, letters_json FROM portal_state WHERE id = 1').get();
  const letters = withAttachmentNames(JSON.parse(row.letters_json));
  const letterIndexes = new Map(letters.map((letter, index) => [String(letter.id), index]));
  const files = [{ name: 'backup.json', data: null }];
  const attachments = [];
  const tables = [
    { kind: 'source', table: 'letter_attachments' },
    { kind: 'word', table: 'word_document_attachments' },
    { kind: 'signed', table: 'signed_letter_attachments' },
    { kind: 'screenshot', table: 'portal_screenshot_attachments' }
  ];
  for (const type of tables) {
    const rows = db.prepare(`SELECT letter_id, filename, content_type, data FROM ${type.table}`).all();
    for (const file of rows) {
      const index = letterIndexes.get(String(file.letter_id));
      if (index == null) continue;
      const archivePath = `attachments/${index}/${type.kind}`;
      attachments.push({
        letterId: String(file.letter_id),
        kind: type.kind,
        name: file.filename,
        type: file.content_type,
        path: archivePath
      });
      files.push({ name: archivePath, data: file.data });
    }
  }
  files[0].data = Buffer.from(JSON.stringify({
    app: 'elx-letter-monitor',
    version: 2,
    exportedAt: new Date().toISOString(),
    settings: JSON.parse(row.settings_json),
    letters,
    attachments
  }, null, 2));
  return createZip(files);
}

function restoreBackup(archive) {
  const files = readZip(archive);
  const manifestFile = files.get('backup.json');
  if (!manifestFile) throw Object.assign(new Error('The ZIP does not contain a portal backup.'), { status: 400 });
  let manifest;
  try { manifest = JSON.parse(manifestFile.toString('utf8')); }
  catch { throw Object.assign(new Error('The backup manifest could not be read.'), { status: 400 }); }
  if (!manifest || manifest.app !== 'elx-letter-monitor' || !manifest.settings ||
      typeof manifest.settings !== 'object' || Array.isArray(manifest.settings) ||
      !Array.isArray(manifest.letters) || !Array.isArray(manifest.attachments)) {
    throw Object.assign(new Error('The ZIP does not contain a valid portal backup.'), { status: 400 });
  }

  const indexes = new Map();
  const letters = manifest.letters.map((letter, index) => {
    if (!letter || typeof letter !== 'object' || !letter.id || typeof letter.id !== 'string' ||
        indexes.has(letter.id)) {
      throw Object.assign(new Error('The backup contains an invalid or duplicate letter.'), { status: 400 });
    }
    indexes.set(letter.id, index);
    return Object.assign({}, letter, {
      attachment: null,
      wordDocument: null,
      signedPdfName: '',
      portalScreenshotName: ''
    });
  });
  const storedFiles = [];
  const seen = new Set();
  const kinds = new Set(['source', 'word', 'signed', 'screenshot']);
  for (const item of manifest.attachments) {
    if (!item || !indexes.has(item.letterId) || !kinds.has(item.kind)) {
      throw Object.assign(new Error('The backup contains an invalid attachment record.'), { status: 400 });
    }
    const key = item.letterId + ':' + item.kind;
    const index = indexes.get(item.letterId);
    const expectedPath = `attachments/${index}/${item.kind}`;
    if (seen.has(key) || item.path !== expectedPath) {
      throw Object.assign(new Error('The backup contains an invalid or duplicate attachment path.'), { status: 400 });
    }
    seen.add(key);
    const data = files.get(expectedPath);
    if (!data) throw Object.assign(new Error('A file referenced by the backup is missing.'), { status: 400 });
    const value = { name: item.name, type: item.type, data: data.toString('base64') };
    const attachment = item.kind === 'source' ? parseSourcePdf(value)
      : item.kind === 'word' ? parseWordDocument(value)
        : item.kind === 'signed' ? parseSignedPdf(value) : parsePortalScreenshot(value);
    const letter = letters[index];
    if (item.kind === 'source') letter.attachment = { name: attachment.filename, type: attachment.contentType };
    if (item.kind === 'word') letter.wordDocument = { name: attachment.filename, type: attachment.contentType };
    if (item.kind === 'signed') letter.signedPdfName = attachment.filename;
    if (item.kind === 'screenshot') {
      if (letter.fromSection !== 'Tech 8 - Warranty') {
        throw Object.assign(new Error('Portal screenshots can only be restored for Tech 8 - Warranty letters.'), { status: 400 });
      }
      letter.portalScreenshotName = attachment.filename;
    }
    storedFiles.push({ letterId: item.letterId, kind: item.kind, attachment });
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('SELECT revision FROM portal_state WHERE id = 1').get();
    const activeSections = new Set(manifest.settings.sections || []);
    const assigned = db.prepare("SELECT DISTINCT section_name FROM accounts WHERE role = 'section_user' AND section_name IS NOT NULL").all();
    if (assigned.some((row) => !activeSections.has(row.section_name))) {
      throw Object.assign(new Error('Reassign or remove section users before restoring settings without their section.'), { status: 409 });
    }
    const revision = current.revision + 1;
    db.prepare('UPDATE portal_state SET settings_json = ?, letters_json = ?, initialized = 1, revision = ? WHERE id = 1')
      .run(JSON.stringify(manifest.settings), JSON.stringify(letters), revision);
    db.exec(`DELETE FROM letter_attachments;
      DELETE FROM word_document_attachments;
      DELETE FROM signed_letter_attachments;
      DELETE FROM portal_screenshot_attachments;`);
    const statements = {
      source: db.prepare('INSERT INTO letter_attachments (letter_id, filename, content_type, data, created_at) VALUES (?, ?, ?, ?, ?)'),
      word: db.prepare('INSERT INTO word_document_attachments (letter_id, filename, content_type, data, created_at) VALUES (?, ?, ?, ?, ?)'),
      signed: db.prepare('INSERT INTO signed_letter_attachments (letter_id, filename, content_type, data, created_at) VALUES (?, ?, ?, ?, ?)'),
      screenshot: db.prepare('INSERT INTO portal_screenshot_attachments (letter_id, filename, content_type, data, created_at) VALUES (?, ?, ?, ?, ?)')
    };
    const now = new Date().toISOString();
    for (const item of storedFiles) {
      statements[item.kind].run(item.letterId, item.attachment.filename, item.attachment.contentType, item.attachment.data, now);
    }
    db.exec('COMMIT');
    return { revision, count: letters.length };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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

  if (req.method === 'POST' && url.pathname === '/api/change-password') {
    const user = requireLogin(req, res, false);
    if (!user) return;
    const body = await readBody(req);
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');
    if (newPassword.length < 8) return sendJson(res, 400, { error: 'Use a password of at least 8 characters.' });
    const account = db.prepare('SELECT password_salt, password_hash FROM accounts WHERE id = ?').get(user.id);
    const candidate = crypto.pbkdf2Sync(currentPassword, account.password_salt, PASSWORD_ITERATIONS, 32, 'sha256').toString('hex');
    if (!safeEqualHex(candidate, account.password_hash)) {
      return sendJson(res, 400, { error: 'The current password is incorrect.' });
    }
    if (currentPassword === newPassword) {
      return sendJson(res, 400, { error: 'Choose a new password different from your current password.' });
    }
    const cookie = String(req.headers.cookie || '').split(';').map((part) => part.trim())
      .find((part) => part.startsWith('elx_session='));
    const token = decodeURIComponent(cookie.slice('elx_session='.length));
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.pbkdf2Sync(newPassword, salt, PASSWORD_ITERATIONS, 32, 'sha256').toString('hex');
    db.prepare('UPDATE accounts SET password_salt = ?, password_hash = ? WHERE id = ?')
      .run(salt, passwordHash, user.id);
    db.prepare('DELETE FROM sessions WHERE account_id = ? AND token_hash != ?').run(user.id, tokenHash);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/backup') {
    if (!requireAdmin(req, res)) return;
    const archive = makeBackup();
    const filename = 'letter-register-' + new Date().toISOString().slice(0, 10) + '.zip';
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
      'content-length': archive.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    return res.end(archive);
  }

  if (req.method === 'PUT' && url.pathname === '/api/backup') {
    if (!requireAdmin(req, res)) return;
    const archive = await readBinaryBody(req, MAX_BACKUP_BYTES);
    const result = restoreBackup(archive);
    return sendJson(res, 200, { ok: true, revision: result.revision, count: result.count });
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const row = db.prepare('SELECT settings_json, letters_json, initialized, revision FROM portal_state WHERE id = 1').get();
    const settings = JSON.parse(row.settings_json);
    const letters = JSON.parse(row.letters_json);
    return sendJson(res, 200, {
      settings,
      letters: withAttachmentNames(letters),
      initialized: !!row.initialized,
      revision: row.revision
    });
  }

  if (req.method === 'PUT' && url.pathname === '/api/state') {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req, 16 * 1024 * 1024);
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
    let sourcePdf = null;
    if (body.sourcePdf) {
      const sourceLetterId = String(body.sourcePdf.letterId || '');
      const sourceLetter = body.letters.find((letter) => String(letter.id) === sourceLetterId);
      if (!sourceLetter) return sendJson(res, 400, { error: 'The source PDF must belong to a letter in the register.' });
      sourcePdf = Object.assign(parseSourcePdf(body.sourcePdf), { letterId: sourceLetterId });
    }
    let portalScreenshot = null;
    if (body.portalScreenshot) {
      const screenshotLetterId = String(body.portalScreenshot.letterId || '');
      const screenshotLetter = body.letters.find((letter) => String(letter.id) === screenshotLetterId);
      if (!screenshotLetter || screenshotLetter.fromSection !== 'Tech 8 - Warranty' ||
          screenshotLetter.status !== 'dispatched') {
        return sendJson(res, 400, { error: 'A portal screenshot must belong to a dispatched Tech 8 - Warranty letter.' });
      }
      portalScreenshot = Object.assign(parsePortalScreenshot(body.portalScreenshot), { letterId: screenshotLetterId });
    }
    const lettersForStorage = body.letters.map(({ signedPdfName, portalScreenshotName, ...letter }) => letter);
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT revision FROM portal_state WHERE id = 1').get();
      if (!Number.isInteger(body.revision) || body.revision !== current.revision) {
        db.exec('ROLLBACK');
        return sendJson(res, 409, { error: 'The register changed in another session. Reload the page before saving again.' });
      }
      const currentLetters = JSON.parse(db.prepare('SELECT letters_json FROM portal_state WHERE id = 1').get().letters_json);
      const currentById = new Map(currentLetters.map((letter) => [String(letter.id), letter]));
      const missingPortalScreenshot = body.letters.some((letter) => {
        const previous = currentById.get(String(letter.id));
        return letter.fromSection === 'Tech 8 - Warranty' && letter.status === 'dispatched' &&
          (!previous || previous.status !== 'dispatched') &&
          (!portalScreenshot || portalScreenshot.letterId !== String(letter.id));
      });
      if (missingPortalScreenshot) {
        db.exec('ROLLBACK');
        return sendJson(res, 400, { error: 'Attach a portal screenshot when dispatching a Tech 8 - Warranty letter.' });
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
      for (const attachment of db.prepare('SELECT letter_id FROM portal_screenshot_attachments').all()) {
        if (!retainedLetterIds.has(attachment.letter_id)) {
          db.prepare('DELETE FROM portal_screenshot_attachments WHERE letter_id = ?').run(attachment.letter_id);
        }
      }
      if (signedPdf) {
        db.prepare(`INSERT INTO signed_letter_attachments (letter_id, filename, content_type, data, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(letter_id) DO UPDATE SET filename = excluded.filename, content_type = excluded.content_type,
            data = excluded.data, created_at = excluded.created_at`)
          .run(signedPdf.letterId, signedPdf.filename, signedPdf.contentType, signedPdf.data, new Date().toISOString());
      }
      if (sourcePdf) {
        db.prepare(`INSERT INTO letter_attachments (letter_id, filename, content_type, data, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(letter_id) DO UPDATE SET filename = excluded.filename, content_type = excluded.content_type,
            data = excluded.data, created_at = excluded.created_at`)
          .run(sourcePdf.letterId, sourcePdf.filename, sourcePdf.contentType, sourcePdf.data, new Date().toISOString());
      }
      if (portalScreenshot) {
        db.prepare(`INSERT INTO portal_screenshot_attachments (letter_id, filename, content_type, data, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(letter_id) DO UPDATE SET filename = excluded.filename, content_type = excluded.content_type,
            data = excluded.data, created_at = excluded.created_at`)
          .run(portalScreenshot.letterId, portalScreenshot.filename, portalScreenshot.contentType, portalScreenshot.data, new Date().toISOString());
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

  const submissionMatch = url.pathname.match(/^\/api\/submissions\/([a-z0-9-]+)$/i);
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

  const attachmentMatch = url.pathname.match(/^\/api\/letters\/([a-z0-9-]+)\/attachment$/i);
  if (attachmentMatch && req.method === 'GET') {
    const user = requireLogin(req, res, false);
    if (!user) return;
    if (user.role !== 'admin' && (user.role !== 'section_user' || !sectionCanAccessLetter(attachmentMatch[1], user))) {
      return sendJson(res, 404, { error: 'Source letter not found.' });
    }
    const row = db.prepare('SELECT filename, content_type, data FROM letter_attachments WHERE letter_id = ?').get(attachmentMatch[1]);
    if (!row) return sendJson(res, 404, { error: 'Source letter not found.' });
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

  const wordDocumentMatch = url.pathname.match(/^\/api\/letters\/([a-z0-9-]+)\/word-document$/i);
  if (wordDocumentMatch && req.method === 'GET') {
    const user = requireLogin(req, res, false);
    if (!user) return;
    const letterId = wordDocumentMatch[1];
    if (user.role !== 'admin' && (user.role !== 'section_user' || !sectionCanAccessLetter(letterId, user))) {
      return sendJson(res, 404, { error: 'Word document not found.' });
    }
    const row = db.prepare('SELECT filename, content_type, data FROM word_document_attachments WHERE letter_id = ?').get(letterId);
    if (!row) return sendJson(res, 404, { error: 'Word document not found.' });
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
    if (user.role !== 'admin' && (user.role !== 'section_user' || !user.sectionName)) {
      return sendJson(res, 404, { error: 'Signed letter not found.' });
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

  const portalScreenshotMatch = url.pathname.match(/^\/api\/letters\/([a-z0-9-]+)\/portal-screenshot$/i);
  if (portalScreenshotMatch && req.method === 'GET') {
    const user = requireLogin(req, res, false);
    if (!user) return;
    const letterId = portalScreenshotMatch[1];
    if (user.role !== 'admin' && (user.role !== 'section_user' || !sectionCanAccessLetter(letterId, user))) {
      return sendJson(res, 404, { error: 'Portal screenshot not found.' });
    }
    const row = db.prepare('SELECT filename, content_type, data FROM portal_screenshot_attachments WHERE letter_id = ?').get(letterId);
    if (!row) return sendJson(res, 404, { error: 'Portal screenshot not found.' });
    const encodedFilename = encodeURIComponent(row.filename.toWellFormed()).replace(/['()*]/g, (char) =>
      '%' + char.charCodeAt(0).toString(16).toUpperCase());
    res.writeHead(200, {
      'content-type': row.content_type,
      'content-disposition': `inline; filename="portal-screenshot"; filename*=UTF-8''${encodedFilename}`,
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
