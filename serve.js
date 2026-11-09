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
const SESSION_MS = 8 * 60 * 60 * 1000;
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
    initialized INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO portal_state (id, settings_json, letters_json, initialized)
    VALUES (1, '{}', '[]', 0);
`);

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
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
  const row = db.prepare(`SELECT a.id, a.username_cipher, a.is_main_admin, s.expires_at
    FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?`).get(tokenHash);
  if (!row || row.expires_at <= Date.now()) {
    if (row) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  return { id: row.id, username: decryptUsername(row.username_cipher), isMainAdmin: !!row.is_main_admin };
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

function accountByUsername(username) {
  const row = db.prepare('SELECT * FROM accounts WHERE username_hash = ?').get(hashUsername(username));
  if (!row) return null;
  return Object.assign({}, row, { username: decryptUsername(row.username_cipher) });
}

function createAccount(username, password, isMainAdmin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, 'sha256').toString('hex');
  db.prepare(`INSERT INTO accounts
    (id, username_hash, username_cipher, password_salt, password_hash, is_main_admin, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(isMainAdmin ? 'main-admin' : crypto.randomUUID(), hashUsername(username), encryptUsername(username), salt,
      passwordHash, isMainAdmin ? 1 : 0, new Date().toISOString());
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
    const expires = Date.now() + SESSION_MS;
    db.prepare('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)').run(tokenHash, account.id, expires);
    return sendJson(res, 200, { user: { id: account.id, username: account.username, isMainAdmin: !!account.is_main_admin } }, {
      'set-cookie': `elx_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${COOKIE_SECURE}`
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
    return sendJson(res, 200, { user: user || null });
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const row = db.prepare('SELECT settings_json, letters_json, initialized FROM portal_state WHERE id = 1').get();
    return sendJson(res, 200, {
      settings: JSON.parse(row.settings_json),
      letters: JSON.parse(row.letters_json),
      initialized: !!row.initialized
    });
  }

  if (req.method === 'PUT' && url.pathname === '/api/state') {
    if (!requireLogin(req, res, false)) return;
    const body = await readBody(req);
    if (!body.settings || !Array.isArray(body.letters)) return sendJson(res, 400, { error: 'Invalid portal state.' });
    db.prepare('UPDATE portal_state SET settings_json = ?, letters_json = ?, initialized = 1 WHERE id = 1')
      .run(JSON.stringify(body.settings), JSON.stringify(body.letters));
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/accounts') {
    if (!requireLogin(req, res, true)) return;
    const accounts = db.prepare('SELECT id, username_cipher, is_main_admin FROM accounts ORDER BY is_main_admin DESC, username_hash').all()
      .map((row) => ({ id: row.id, username: decryptUsername(row.username_cipher), isMainAdmin: !!row.is_main_admin }));
    return sendJson(res, 200, { accounts });
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
    if (!USERNAME_RE.test(username)) return sendJson(res, 400, { error: 'Username must be 3 to 24 letters, numbers, dots, dashes, or underscores.' });
    if (password.length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
    if (accountByUsername(username)) return sendJson(res, 409, { error: 'That username is already in use.' });
    createAccount(username, password, false);
    return sendJson(res, 201, { ok: true });
  }

  const accountMatch = url.pathname.match(/^\/api\/accounts\/([a-f0-9-]+)$/i);
  if (accountMatch && req.method === 'PATCH') {
    if (!requireLogin(req, res, true)) return;
    const body = await readBody(req);
    const account = db.prepare('SELECT id, is_main_admin FROM accounts WHERE id = ?').get(accountMatch[1]);
    if (!account || account.is_main_admin) return sendJson(res, 404, { error: 'Administrator account not found.' });
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!USERNAME_RE.test(username)) return sendJson(res, 400, { error: 'Username must be 3 to 24 letters, numbers, dots, dashes, or underscores.' });
    const duplicate = accountByUsername(username);
    if (duplicate && duplicate.id !== account.id) return sendJson(res, 409, { error: 'That username is already in use.' });
    if (password && password.length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
    const salt = password ? crypto.randomBytes(16).toString('hex') : null;
    const passwordHash = password ? crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, 'sha256').toString('hex') : null;
    if (password) {
      db.prepare(`UPDATE accounts SET username_hash = ?, username_cipher = ?, password_salt = ?, password_hash = ? WHERE id = ?`)
        .run(hashUsername(username), encryptUsername(username), salt, passwordHash, account.id);
    } else {
      db.prepare('UPDATE accounts SET username_hash = ?, username_cipher = ? WHERE id = ?')
        .run(hashUsername(username), encryptUsername(username), account.id);
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
