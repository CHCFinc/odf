// ODF Student Tracker: Express + MySQL, built for GoDaddy Node.js Hosting.
const express = require('express');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const app = express();
const port = process.env.PORT || 3000;

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 5,
  dateStrings: true,
  charset: 'utf8mb4',
});

const SESSION_HOURS = 12;
const COOKIE = 'odf_sid';
const STATUSES = ['Enrolled', 'Completed', 'Left early'];
const DOING = ['In high school', 'In college', 'Trade or certificate program', 'College and working', 'Working full time',
  'Working part time', 'Military', 'Looking for work', 'Other', 'Could not reach'];
const GRADES = ['', '8', '9', '10', '11', '12', 'Other'];

/* ---------- schema (safe to run on every start, and from two instances at once) ---------- */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(190) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL DEFAULT '',
    role VARCHAR(10) NOT NULL DEFAULT 'staff',
    pass_hash VARCHAR(255) NOT NULL,
    must_change TINYINT(1) NOT NULL DEFAULT 0,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) PRIMARY KEY,
    user_id INT NOT NULL,
    expires_at DATETIME NOT NULL,
    INDEX idx_sessions_user (user_id),
    CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS students (
    id INT AUTO_INCREMENT PRIMARY KEY,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    school VARCHAR(200) NOT NULL DEFAULT '',
    school_year VARCHAR(7) NOT NULL DEFAULT '',
    entry_date DATE NULL,
    grade VARCHAR(10) NOT NULL DEFAULT '',
    status VARCHAR(20) NOT NULL DEFAULT 'Enrolled',
    email VARCHAR(190) NOT NULL DEFAULT '',
    phone VARCHAR(40) NOT NULL DEFAULT '',
    careers VARCHAR(500) NOT NULL DEFAULT '',
    hobbies VARCHAR(500) NOT NULL DEFAULT '',
    notes TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS internships (
    id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    company VARCHAR(200) NOT NULL DEFAULT '',
    role VARCHAR(200) NOT NULL DEFAULT '',
    start_date DATE NULL,
    end_date DATE NULL,
    notes TEXT NULL,
    INDEX idx_internships_student (student_id),
    CONSTRAINT fk_internships_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS checkins (
    id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    checkin_date DATE NOT NULL,
    doing VARCHAR(60) NOT NULL DEFAULT '',
    place VARCHAR(200) NOT NULL DEFAULT '',
    detail VARCHAR(200) NOT NULL DEFAULT '',
    notes TEXT NULL,
    recorded_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_checkins_student (student_id),
    CONSTRAINT fk_checkins_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS schools (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(200) NOT NULL UNIQUE,
    address VARCHAR(300) NOT NULL DEFAULT '',
    contact_name VARCHAR(120) NOT NULL DEFAULT '',
    contact_email VARCHAR(190) NOT NULL DEFAULT '',
    contact_phone VARCHAR(40) NOT NULL DEFAULT '',
    notes TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS companies (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(200) NOT NULL UNIQUE,
    address VARCHAR(300) NOT NULL DEFAULT '',
    contact_name VARCHAR(120) NOT NULL DEFAULT '',
    contact_email VARCHAR(190) NOT NULL DEFAULT '',
    contact_phone VARCHAR(40) NOT NULL DEFAULT '',
    notes TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // One face photo per student, kept in the database so it survives redeploys.
  `CREATE TABLE IF NOT EXISTS student_photos (
    student_id INT PRIMARY KEY,
    data MEDIUMBLOB NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_photos_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Carry names already typed on student and internship records into the two directories.
  "INSERT IGNORE INTO schools (name) SELECT DISTINCT TRIM(school) FROM students WHERE TRIM(school) <> ''",
  "INSERT IGNORE INTO companies (name) SELECT DISTINCT TRIM(company) FROM internships WHERE TRIM(company) <> ''",
];

// Columns added after the first release. Existing rows keep working: every one is blank by default.
const TXT = (n) => `VARCHAR(${n}) NOT NULL DEFAULT ''`;
const ADDED_COLUMNS = {
  students: {
    middle_name: TXT(100), dob: 'DATE NULL', gender: TXT(40), sexual_orientation: TXT(60), ethnicity: TXT(60), race: TXT(80), medical: TXT(500),
    street: TXT(200), apt: TXT(60), city: TXT(80), state: TXT(20), zip: TXT(12), nycha: TXT(120), working_papers: TXT(20), college_accepted: TXT(300),
    linkedin: TXT(200), instagram: TXT(200), tiktok: TXT(200), facebook: TXT(200), other_link: TXT(200),
    parent_name: TXT(200), parent_email: TXT(190), parent_phone: TXT(120), parent_phone2: TXT(120), emergency_name: TXT(200), emergency_phone: TXT(120),
  },
  schools: { contact_title: TXT(120) },
  companies: { contact_title: TXT(120) },
};
async function addColumns(table, cols) {
  const [rows] = await pool.query('SELECT COLUMN_NAME AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?', [table]);
  const have = new Set(rows.map((r) => r.c.toLowerCase()));
  for (const [name, def] of Object.entries(cols)) {
    if (have.has(name)) continue;
    // Preview and live can start together; the loser of that race sees "duplicate column", which is fine.
    try { await pool.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`); } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
  }
}

/* ---------- helpers ---------- */
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const dateOrNull = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
async function checkPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[2], 'hex');
  const key = await scrypt(pw, Buffer.from(parts[1], 'hex'), expected.length || 64);
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}
const passwordProblem = (pw) => (typeof pw !== 'string' || pw.length < 10 ? 'Use a password of at least 10 characters.' : pw.length > 200 ? 'That password is too long.' : '');

function readCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return '';
}
function setCookie(req, res, value, maxAgeSec) {
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
}

/* ---------- app setup ---------- */
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
app.use('/api/students/:id/photo', express.json({ limit: '1mb' })); // a photo arrives as text inside the request
app.use('/api/students/import', express.json({ limit: '2mb' })); // a CSV import carries many rows at once
app.use('/api', express.json({ limit: '100kb' }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  // Every change must come from this app's own pages: other sites cannot send this header.
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'odf') return res.status(403).json({ error: 'Request refused.' });
  next();
});

const auth = wrap(async (req, res, next) => {
  const token = readCookie(req);
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
  const [rows] = await pool.execute(
    `SELECT u.id, u.email, u.name, u.role, u.must_change FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > NOW() AND u.active = 1`, [sha256(token)]);
  if (!rows.length) return res.status(401).json({ error: 'Sign in to continue.' });
  req.user = rows[0];
  req.tokenHash = sha256(token);
  next();
});
// Staff with a temporary password can do nothing but replace it.
const ready = (req, res, next) => (req.user.must_change ? res.status(403).json({ error: 'Set a new password first.', mustChange: true }) : next());
const admin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Only an admin can do that.' }));
const me = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, mustChange: !!u.must_change });

/* ---------- sign in / out ---------- */
const attempts = new Map(); // email -> { count, until }
app.post('/api/login', wrap(async (req, res) => {
  const email = str(req.body.email, 190).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const a = attempts.get(email);
  if (a && a.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const [rows] = await pool.execute('SELECT * FROM users WHERE email = ? AND active = 1', [email]);
  const user = rows[0];
  const ok = await checkPassword(password, user ? user.pass_hash : 'scrypt$00$00') && !!user;
  if (!ok) {
    const count = (a && a.until > Date.now() - 9e5 ? a.count : 0) + 1;
    attempts.set(email, { count, until: count >= 8 ? Date.now() + 9e5 : Date.now() });
    if (attempts.size > 5000) attempts.clear();
    return res.status(401).json({ error: 'That email and password do not match.' });
  }
  attempts.delete(email);
  const token = crypto.randomBytes(32).toString('hex');
  await pool.execute('DELETE FROM sessions WHERE expires_at < NOW()');
  await pool.execute('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))', [sha256(token), user.id, SESSION_HOURS]);
  setCookie(req, res, token, SESSION_HOURS * 3600);
  res.json({ user: me(user) });
}));
app.post('/api/logout', auth, wrap(async (req, res) => {
  await pool.execute('DELETE FROM sessions WHERE token_hash = ?', [req.tokenHash]);
  setCookie(req, res, '', 0);
  res.json({ ok: true });
}));
app.get('/api/me', auth, (req, res) => res.json({ user: me(req.user) }));
app.post('/api/password', auth, wrap(async (req, res) => {
  const [rows] = await pool.execute('SELECT pass_hash FROM users WHERE id = ?', [req.user.id]);
  if (!(await checkPassword(String(req.body.current || ''), rows[0].pass_hash))) return res.status(400).json({ error: 'Your current password is not right.' });
  const problem = passwordProblem(req.body.next);
  if (problem) return res.status(400).json({ error: problem });
  if (req.body.next === req.body.current) return res.status(400).json({ error: 'Choose a password different from the current one.' });
  await pool.execute('UPDATE users SET pass_hash = ?, must_change = 0 WHERE id = ?', [await hashPassword(req.body.next), req.user.id]);
  await pool.execute('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [req.user.id, req.tokenHash]);
  res.json({ ok: true });
}));

/* ---------- students ---------- */
// column: [name in requests and responses, longest value kept]
const TEXT_COLS = {
  first_name: ['firstName', 100], middle_name: ['middleName', 100], last_name: ['lastName', 100], school: ['school', 200],
  school_year: ['schoolYear', 7], grade: ['grade', 10], status: ['status', 20], email: ['email', 190], phone: ['phone', 40],
  careers: ['careers', 500], hobbies: ['hobbies', 500], notes: ['notes', 5000],
  gender: ['gender', 40], sexual_orientation: ['sexualOrientation', 60], ethnicity: ['ethnicity', 60], race: ['race', 80], medical: ['medical', 500],
  street: ['street', 200], apt: ['apt', 60], city: ['city', 80], state: ['state', 20], zip: ['zip', 12], nycha: ['nycha', 120],
  working_papers: ['workingPapers', 20], college_accepted: ['collegeAccepted', 300],
  linkedin: ['linkedin', 200], instagram: ['instagram', 200], tiktok: ['tiktok', 200], facebook: ['facebook', 200], other_link: ['otherLink', 200],
  parent_name: ['parentName', 200], parent_email: ['parentEmail', 190], parent_phone: ['parentPhone', 120], parent_phone2: ['parentPhone2', 120],
  emergency_name: ['emergencyName', 200], emergency_phone: ['emergencyPhone', 120],
};
const DATE_COLS = { entry_date: 'entryDate', dob: 'dob' };
const WORKING_PAPERS = ['', 'Yes', 'No', 'Pending'];

function studentFields(b) {
  const f = {};
  for (const [col, [key, max]] of Object.entries(TEXT_COLS)) f[col] = str(b[key], max);
  for (const [col, key] of Object.entries(DATE_COLS)) f[col] = dateOrNull(b[key]);
  if (!f.first_name || !f.last_name) return { error: 'First and last name are required.' };
  if (!/^\d{4}-\d{2}$/.test(f.school_year)) return { error: 'Pick the school year the student entered.' };
  if (!STATUSES.includes(f.status)) return { error: 'Pick a program status.' };
  if (!GRADES.includes(f.grade)) return { error: 'Pick a grade from the list.' };
  if (!WORKING_PAPERS.includes(f.working_papers)) return { error: 'Pick a working papers answer from the list.' };
  if (f.email && !validEmail(f.email)) return { error: 'That student email does not look right.' };
  if (f.parent_email && !validEmail(f.parent_email)) return { error: 'That parent email does not look right.' };
  return { f };
}
const insertStudent = (db, f, userId) => {
  const cols = Object.keys(f);
  return db.execute(`INSERT INTO students (${cols.join(', ')}, updated_by) VALUES (${cols.map(() => '?').join(', ')}, ?)`, [...cols.map((c) => f[c]), userId]);
};
app.get('/api/students', auth, ready, wrap(async (req, res) => {
  const [students] = await pool.query(
    `SELECT s.*, u.name AS updated_by_name, (SELECT UNIX_TIMESTAMP(p.updated_at) FROM student_photos p WHERE p.student_id = s.id) AS photo_v
     FROM students s LEFT JOIN users u ON u.id = s.updated_by ORDER BY s.last_name, s.first_name`);
  const [interns] = await pool.query('SELECT * FROM internships ORDER BY start_date DESC, id DESC');
  const [checks] = await pool.query(
    `SELECT c.*, u.name AS by_name FROM checkins c LEFT JOIN users u ON u.id = c.recorded_by ORDER BY c.checkin_date DESC, c.id DESC`);
  const byId = new Map();
  const out = students.map((s) => {
    // photo is 0 when there is none; otherwise a number that changes whenever the photo does, so browsers fetch the new one
    const o = { id: s.id, photo: Number(s.photo_v) || 0, updatedAt: s.updated_at, updatedByName: s.updated_by_name || '', internships: [], checkins: [] };
    for (const [col, [key]] of Object.entries(TEXT_COLS)) o[key] = s[col] || '';
    for (const [col, key] of Object.entries(DATE_COLS)) o[key] = s[col] || '';
    byId.set(s.id, o);
    return o;
  });
  for (const i of interns) {
    const s = byId.get(i.student_id);
    if (s) s.internships.push({ id: i.id, company: i.company, role: i.role, start: i.start_date || '', end: i.end_date || '', notes: i.notes || '' });
  }
  for (const c of checks) {
    const s = byId.get(c.student_id);
    if (s) s.checkins.push({ id: c.id, date: c.checkin_date, doing: c.doing, where: c.place, detail: c.detail, notes: c.notes || '', byName: c.by_name || '' });
  }
  res.json({ students: out });
}));
app.post('/api/students', auth, ready, wrap(async (req, res) => {
  const { f, error } = studentFields(req.body);
  if (error) return res.status(400).json({ error });
  await ensureOrg('schools', f.school);
  const [r] = await insertStudent(pool, f, req.user.id);
  res.json({ id: r.insertId });
}));
// Bulk import from a CSV the page has already read and tidied. Each row is checked again here.
app.post('/api/students/import', auth, ready, wrap(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'There are no rows to import.' });
  if (rows.length > 1000) return res.status(400).json({ error: 'Import at most 1,000 students at a time.' });
  const key = (a, b, y) => `${a}|${b}|${y}`.toLowerCase();
  const [existing] = await pool.query('SELECT first_name, last_name, school_year FROM students');
  const seen = new Set(existing.map((s) => key(s.first_name, s.last_name, s.school_year)));
  const problems = [];
  let added = 0, skipped = 0;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (let n = 0; n < rows.length; n++) {
      const b = rows[n] && typeof rows[n] === 'object' ? rows[n] : {};
      const { f, error } = studentFields(b);
      if (error) { problems.push({ row: Number(b.row) || n + 1, error }); continue; }
      const k = key(f.first_name, f.last_name, f.school_year);
      if (seen.has(k)) { skipped++; continue; }
      seen.add(k);
      if (f.school) await conn.execute('INSERT IGNORE INTO schools (name) VALUES (?)', [f.school]);
      const [r] = await insertStudent(conn, f, req.user.id);
      const company = str(b.company, 200);
      if (company) {
        // A company new to the directory keeps the address and contact given in the file.
        const contactEmail = str(b.companyContactEmail, 190);
        await conn.execute('INSERT IGNORE INTO companies (name, address, contact_name, contact_title, contact_phone, contact_email) VALUES (?, ?, ?, ?, ?, ?)',
          [company, str(b.companyAddress, 300), str(b.companyContact, 120), str(b.companyContactTitle, 120), str(b.companyContactPhone, 40), validEmail(contactEmail) ? contactEmail : '']);
        await conn.execute('INSERT INTO internships (student_id, company, role, start_date, end_date, notes) VALUES (?, ?, ?, ?, ?, ?)',
          [r.insertId, company, str(b.role, 200), dateOrNull(b.internStart), dateOrNull(b.internEnd), '']);
      }
      added++;
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  res.json({ added, skipped, problems });
}));
app.put('/api/students/:id', auth, ready, wrap(async (req, res) => {
  const { f, error } = studentFields(req.body);
  if (error) return res.status(400).json({ error });
  await ensureOrg('schools', f.school);
  const cols = Object.keys(f);
  const [r] = await pool.execute(`UPDATE students SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = NOW(), updated_by = ? WHERE id = ?`,
    [...cols.map((c) => f[c]), req.user.id, Number(req.params.id) || 0]);
  if (!r.affectedRows) return res.status(404).json({ error: 'That student record no longer exists.' });
  res.json({ ok: true });
}));
app.delete('/api/students/:id', auth, ready, admin, wrap(async (req, res) => {
  await pool.execute('DELETE FROM students WHERE id = ?', [Number(req.params.id) || 0]);
  res.json({ ok: true });
}));

// A school or company named on a record is added to its directory if it is not there yet.
const ensureOrg = (table, name) => (name ? pool.execute(`INSERT IGNORE INTO ${table} (name) VALUES (?)`, [name]) : null);
/* ---------- student photos ---------- */
const MAX_PHOTO_BYTES = 400 * 1024;
app.get('/api/students/:id/photo', auth, ready, wrap(async (req, res) => {
  const [rows] = await pool.execute('SELECT data FROM student_photos WHERE student_id = ?', [Number(req.params.id) || 0]);
  if (!rows.length) return res.status(404).json({ error: 'No photo.' });
  // Only signed-in staff get this far. "private" keeps shared caches from storing it.
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.type('image/jpeg').send(rows[0].data);
}));
app.put('/api/students/:id/photo', auth, ready, wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(typeof req.body.image === 'string' ? req.body.image : '');
  if (!m) return res.status(400).json({ error: 'That photo could not be read. Try a JPG or PNG file.' });
  const data = Buffer.from(m[1], 'base64');
  // The page always sends a small JPEG it has redrawn itself; anything else is refused.
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) return res.status(400).json({ error: 'That photo could not be read. Try a JPG or PNG file.' });
  if (data.length > MAX_PHOTO_BYTES) return res.status(400).json({ error: 'That photo is too large.' });
  if (!(await studentExists(id))) return res.status(404).json({ error: 'That student record no longer exists.' });
  await pool.execute('INSERT INTO student_photos (student_id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = NOW()', [id, data]);
  await touch(id, req.user.id);
  res.json({ ok: true });
}));
app.delete('/api/students/:id/photo', auth, ready, wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  await pool.execute('DELETE FROM student_photos WHERE student_id = ?', [id]);
  await touch(id, req.user.id);
  res.json({ ok: true });
}));

const touch = (id, userId) => pool.execute('UPDATE students SET updated_at = NOW(), updated_by = ? WHERE id = ?', [userId, id]);
const studentExists = async (id) => (await pool.execute('SELECT id FROM students WHERE id = ?', [id]))[0].length > 0;

app.post('/api/students/:id/internships', auth, ready, wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  const company = str(req.body.company, 200);
  if (!company) return res.status(400).json({ error: 'Enter the company name.' });
  if (!(await studentExists(id))) return res.status(404).json({ error: 'That student record no longer exists.' });
  await ensureOrg('companies', company);
  await pool.execute('INSERT INTO internships (student_id, company, role, start_date, end_date, notes) VALUES (?, ?, ?, ?, ?, ?)',
    [id, company, str(req.body.role, 200), dateOrNull(req.body.start), dateOrNull(req.body.end), str(req.body.notes, 5000)]);
  await touch(id, req.user.id);
  res.json({ ok: true });
}));
app.delete('/api/internships/:id', auth, ready, wrap(async (req, res) => {
  const iid = Number(req.params.id) || 0;
  const [rows] = await pool.execute('SELECT student_id FROM internships WHERE id = ?', [iid]);
  await pool.execute('DELETE FROM internships WHERE id = ?', [iid]);
  if (rows.length) await touch(rows[0].student_id, req.user.id);
  res.json({ ok: true });
}));
app.post('/api/students/:id/checkins', auth, ready, wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  const date = dateOrNull(req.body.date);
  const doing = str(req.body.doing, 60);
  if (!date) return res.status(400).json({ error: 'Enter the check-in date.' });
  if (!DOING.includes(doing)) return res.status(400).json({ error: 'Pick what the student is doing now.' });
  if (!(await studentExists(id))) return res.status(404).json({ error: 'That student record no longer exists.' });
  await pool.execute('INSERT INTO checkins (student_id, checkin_date, doing, place, detail, notes, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, date, doing, str(req.body.where, 200), str(req.body.detail, 200), str(req.body.notes, 5000), req.user.id]);
  await touch(id, req.user.id);
  res.json({ ok: true });
}));
app.delete('/api/checkins/:id', auth, ready, wrap(async (req, res) => {
  const cid = Number(req.params.id) || 0;
  const [rows] = await pool.execute('SELECT student_id FROM checkins WHERE id = ?', [cid]);
  await pool.execute('DELETE FROM checkins WHERE id = ?', [cid]);
  if (rows.length) await touch(rows[0].student_id, req.user.id);
  res.json({ ok: true });
}));

/* ---------- schools and companies ---------- */
const ORGS = {
  schools: { one: 'school', refTable: 'students', refCol: 'school', refWord: 'student record' },
  companies: { one: 'company', refTable: 'internships', refCol: 'company', refWord: 'internship' },
};
function orgFields(b) {
  const f = { name: str(b.name, 200), address: str(b.address, 300), contact_name: str(b.contactName, 120), contact_title: str(b.contactTitle, 120),
    contact_email: str(b.contactEmail, 190), contact_phone: str(b.contactPhone, 40), notes: str(b.notes, 5000) };
  if (!f.name) return { error: 'Enter a name.' };
  if (f.contact_email && !validEmail(f.contact_email)) return { error: 'That contact email does not look right.' };
  return { f };
}
app.get('/api/directory', auth, ready, wrap(async (req, res) => {
  const out = {};
  for (const [table, o] of Object.entries(ORGS)) {
    const [rows] = await pool.query(
      `SELECT d.*, (SELECT COUNT(*) FROM ${o.refTable} r WHERE r.${o.refCol} = d.name) AS uses FROM ${table} d ORDER BY d.name`);
    out[table] = rows.map((d) => ({ id: d.id, name: d.name, address: d.address, contactName: d.contact_name, contactTitle: d.contact_title || '', contactEmail: d.contact_email,
      contactPhone: d.contact_phone, notes: d.notes || '', uses: Number(d.uses) }));
  }
  res.json(out);
}));
for (const [table, o] of Object.entries(ORGS)) {
  app.post(`/api/${table}`, auth, ready, wrap(async (req, res) => {
    const { f, error } = orgFields(req.body);
    if (error) return res.status(400).json({ error });
    try {
      await pool.execute(`INSERT INTO ${table} (name, address, contact_name, contact_title, contact_email, contact_phone, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [f.name, f.address, f.contact_name, f.contact_title, f.contact_email, f.contact_phone, f.notes]);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: `A ${o.one} with that name is already on the list.` });
      throw e;
    }
    res.json({ ok: true });
  }));
  app.put(`/api/${table}/:id`, auth, ready, wrap(async (req, res) => {
    const { f, error } = orgFields(req.body);
    if (error) return res.status(400).json({ error });
    const id = Number(req.params.id) || 0;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(`SELECT name FROM ${table} WHERE id = ? FOR UPDATE`, [id]);
      if (!rows.length) { await conn.rollback(); return res.status(404).json({ error: `That ${o.one} is no longer on the list.` }); }
      await conn.execute(`UPDATE ${table} SET name=?, address=?, contact_name=?, contact_title=?, contact_email=?, contact_phone=?, notes=? WHERE id=?`,
        [f.name, f.address, f.contact_name, f.contact_title, f.contact_email, f.contact_phone, f.notes, id]);
      // A rename follows through to every record that used the old name.
      if (rows[0].name !== f.name) await conn.execute(`UPDATE ${o.refTable} SET ${o.refCol} = ? WHERE ${o.refCol} = ?`, [f.name, rows[0].name]);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: `A ${o.one} with that name is already on the list.` });
      throw e;
    } finally { conn.release(); }
    res.json({ ok: true });
  }));
  app.delete(`/api/${table}/:id`, auth, ready, admin, wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const [rows] = await pool.execute(`SELECT name FROM ${table} WHERE id = ?`, [id]);
    if (rows.length) {
      const [[{ n }]] = await pool.execute(`SELECT COUNT(*) AS n FROM ${o.refTable} WHERE ${o.refCol} = ?`, [rows[0].name]);
      if (n) return res.status(400).json({ error: `${n} ${o.refWord}${n === 1 ? ' uses' : 's use'} this ${o.one}. Change those first, then delete it.` });
      await pool.execute(`DELETE FROM ${table} WHERE id = ?`, [id]);
    }
    res.json({ ok: true });
  }));
}

/* ---------- staff accounts (admins only) ---------- */
app.get('/api/users', auth, ready, admin, wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT id, email, name, role, active, must_change FROM users ORDER BY active DESC, name, email');
  res.json({ users: rows.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, active: !!u.active, mustChange: !!u.must_change })) });
}));
app.post('/api/users', auth, ready, admin, wrap(async (req, res) => {
  const email = str(req.body.email, 190).toLowerCase();
  const name = str(req.body.name, 120);
  const role = req.body.role === 'admin' ? 'admin' : 'staff';
  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!name) return res.status(400).json({ error: 'Enter the person’s name.' });
  const problem = passwordProblem(req.body.password);
  if (problem) return res.status(400).json({ error: problem });
  try {
    await pool.execute('INSERT INTO users (email, name, role, pass_hash, must_change) VALUES (?, ?, ?, ?, 1)', [email, name, role, await hashPassword(req.body.password)]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Someone already has an account with that email.' });
    throw e;
  }
  res.json({ ok: true });
}));
app.put('/api/users/:id', auth, ready, admin, wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [id]);
  const u = rows[0];
  if (!u) return res.status(404).json({ error: 'That account no longer exists.' });
  const role = req.body.role === 'admin' || req.body.role === 'staff' ? req.body.role : u.role;
  const active = typeof req.body.active === 'boolean' ? (req.body.active ? 1 : 0) : u.active;
  if (id === req.user.id && (role !== 'admin' || !active)) return res.status(400).json({ error: 'You cannot remove your own admin access.' });
  if (req.body.password !== undefined) {
    const problem = passwordProblem(req.body.password);
    if (problem) return res.status(400).json({ error: problem });
    await pool.execute('UPDATE users SET pass_hash = ?, must_change = 1 WHERE id = ?', [await hashPassword(req.body.password), id]);
    await pool.execute('DELETE FROM sessions WHERE user_id = ?', [id]);
  }
  await pool.execute('UPDATE users SET role = ?, active = ? WHERE id = ?', [role, active, id]);
  if (!active) await pool.execute('DELETE FROM sessions WHERE user_id = ?', [id]);
  res.json({ ok: true });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request refused.' });
  console.error('Request failed:', req.method, req.path, err && err.message);
  res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
});

/* ---------- start ---------- */
async function start() {
  for (const k of ['DB_HOST', 'DB_NAME', 'DB_USER']) {
    if (!process.env[k]) throw new Error(`${k} is not set. Add the managed MySQL database to this app in GoDaddy Node.js Hosting.`);
  }
  for (const sql of SCHEMA) await pool.query(sql);
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) await addColumns(table, cols);
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM users');
  if (!n) {
    const email = str(process.env.ADMIN_EMAIL, 190).toLowerCase();
    const pw = process.env.ADMIN_PASSWORD || '';
    if (validEmail(email) && !passwordProblem(pw)) {
      try {
        await pool.execute("INSERT INTO users (email, name, role, pass_hash, must_change) VALUES (?, 'Administrator', 'admin', ?, 1)", [email, await hashPassword(pw)]);
        console.log(`Created the first admin account for ${email}.`);
      } catch (e) { if (e.code !== 'ER_DUP_ENTRY') throw e; }
    } else {
      console.warn('No accounts exist yet. Set ADMIN_EMAIL and ADMIN_PASSWORD (10+ characters) and restart to create the first admin.');
    }
  }
  app.listen(port, '0.0.0.0', () => console.log(`ODF Student Tracker listening on ${port}`));
}
start().catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
