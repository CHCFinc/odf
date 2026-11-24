'use strict';
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'value') n.value = v; else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) { if (c == null || c === false) continue; n.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return n;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? MONTHS[+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1] : ''; };
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const now = new Date();
const curSY = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1; // school year starts in July
const syLabel = (y) => y + '-' + String((y + 1) % 100).padStart(2, '0');
const ord = (n) => n + 'th';
const DOING = ['In high school', 'In college', 'Trade or certificate program', 'College and working', 'Working full time', 'Working part time', 'Military', 'Looking for work', 'Other', 'Could not reach'];

let dir = { schools: [], companies: [] }, tab = 'students', report = null, schoolPick = null;
let me = null, students = [], loaded = false, openId = null, openRef = null, editingId = null, panel = null, lastLoad = 0;

async function api(method, url, body) {
  let r;
  try {
    r = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'odf' }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) { throw new Error('Could not reach the server. Check your connection and try again.'); }
  let d = {};
  try { d = await r.json(); } catch (e) { /* no body */ }
  if (r.status === 401 && url !== '/api/login') { showLogin(); throw new Error(d.error || 'Sign in to continue.'); }
  if (!r.ok) { if (d.mustChange) forcePassword(); throw new Error(d.error || 'Something went wrong. Try again.'); }
  return d;
}

/* ---------- views ---------- */
function closeDialogs() { for (const d of document.querySelectorAll('dialog[open]')) d.close(); }
function showLogin() {
  me = null; students = []; dir = { schools: [], companies: [] }; loaded = false; closeDialogs();
  $('view-app').hidden = true; $('view-login').hidden = false; $('l-pass').value = ''; $('l-email').focus();
}
function showApp() {
  $('view-login').hidden = true; $('view-app').hidden = false;
  $('who').textContent = me.name || me.email;
  $('open-staff').hidden = me.role !== 'admin';
  if (me.mustChange) forcePassword(); else load();
}
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault(); $('login-err').textContent = ''; $('login-go').disabled = true;
  try { me = (await api('POST', '/api/login', { email: $('l-email').value, password: $('l-pass').value })).user; showApp(); }
  catch (err) { $('login-err').textContent = err.message; }
  $('login-go').disabled = false;
});
$('sign-out').addEventListener('click', async () => { try { await api('POST', '/api/logout'); } catch (e) { /* signed out either way */ } showLogin(); });

/* ---------- password ---------- */
let passForced = false;
function openPassword(forced) {
  passForced = forced;
  $('pass-title').textContent = forced ? 'Set your own password' : 'Change password';
  $('pass-why').textContent = forced ? 'You signed in with a temporary password. Replace it to continue.' : '';
  $('pass-why').hidden = !forced; $('pass-cancel').hidden = forced; $('pass-err').textContent = '';
  $('p-cur').value = forced ? $('l-pass').value : ''; $('p-new').value = ''; $('p-again').value = '';
  if (!$('dlg-pass').open) $('dlg-pass').showModal();
  (forced && $('p-cur').value ? $('p-new') : $('p-cur')).focus();
}
function forcePassword() { if (me) me.mustChange = true; openPassword(true); }
$('open-pass').addEventListener('click', () => openPassword(false));
$('pass-cancel').addEventListener('click', () => $('dlg-pass').close());
$('dlg-pass').addEventListener('cancel', (e) => { if (passForced) e.preventDefault(); });
$('pass-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('p-new').value !== $('p-again').value) { $('pass-err').textContent = 'The two new passwords do not match.'; return; }
  try {
    await api('POST', '/api/password', { current: $('p-cur').value, next: $('p-new').value });
    const wasForced = passForced; passForced = false; me.mustChange = false; $('l-pass').value = ''; $('dlg-pass').close();
    if (wasForced) load();
  } catch (err) { $('pass-err').textContent = err.message; }
});

/* ---------- data ---------- */
const isDue = (s) => {
  if (s.status === 'Enrolled') return false;
  const l = s.checkins[0];
  if (!l || !l.date) return true;
  return Date.now() - new Date(l.date + 'T12:00:00').getTime() > 365 * 864e5;
};
const gradeNow = (s) => {
  const g = parseInt(s.grade, 10), y = parseInt(s.schoolYear, 10);
  if (!g || !y) return '';
  const n = g + (curSY - y);
  if (n <= 12) return n === g ? '' : ord(n) + ' now (est.)';
  return 'HS class of ' + (y + 13 - g) + ' (est.)';
};
const fullName = (s) => ((s.firstName || '') + ' ' + (s.lastName || '')).trim() || 'Unnamed student';
const ageOf = (dob) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob || ''); if (!m) return 0; const t = new Date(); let a = t.getFullYear() - +m[1]; if (t.getMonth() + 1 < +m[2] || (t.getMonth() + 1 === +m[2] && t.getDate() < +m[3])) a--; return a > 0 && a < 120 ? a : 0; };
const pill = (s) => el('span', { class: 'pill p-' + (s === 'Left early' ? 'Left' : s), text: s || 'Enrolled' });
function setState(title, body) { const n = $('state'); n.replaceChildren(el('strong', { text: title }), body || ''); n.hidden = false; }

async function load() {
  lastLoad = Date.now();
  try {
    const [a, b] = await Promise.all([api('GET', '/api/students'), api('GET', '/api/directory')]);
    students = a.students; dir = b; loaded = true; render(); renderTab();
    if (openId) { const s = students.find((x) => x.id === openId); if (!s || JSON.stringify(s) !== JSON.stringify(openRef)) renderDetail(); }
  } catch (err) {
    if (me && !loaded) { $('tablebox').hidden = true; setState('Students did not load', err.message); }
  }
}
window.addEventListener('focus', () => { if (me && !me.mustChange && Date.now() - lastLoad > 30000) load(); });

function filtered() {
  const q = $('q').value.trim().toLowerCase(), co = $('f-cohort').value, st = $('f-stat').value, due = $('f-due').checked;
  return students.filter((s) => {
    if (co && s.schoolYear !== co) return false;
    if (st && s.status !== st) return false;
    if (due && !isDue(s)) return false;
    if (q) { const hay = [fullName(s), s.school, s.careers, s.hobbies, ...s.internships.map((i) => i.company)].join(' ').toLowerCase(); if (!hay.includes(q)) return false; }
    return true;
  });
}

function render() {
  $('st-total').textContent = students.length;
  $('st-enrolled').textContent = students.filter((s) => s.status === 'Enrolled').length;
  $('st-alumni').textContent = students.filter((s) => s.status !== 'Enrolled').length;
  $('st-due').textContent = students.filter(isDue).length;

  const sel = $('f-cohort'), keep = sel.value, years = [...new Set(students.map((s) => s.schoolYear).filter(Boolean))].sort().reverse();
  sel.replaceChildren(el('option', { value: '', text: 'All entry years' }), ...years.map((y) => el('option', { value: y, text: 'Entered ' + y })));
  sel.value = years.includes(keep) ? keep : '';

  if (!loaded) return;
  const rows = filtered();
  if (!students.length) {
    $('tablebox').hidden = true;
    setState('No students yet', 'Use Add student to enter current participants, and past students too: pick the school year they entered and set their status to Completed.');
    return;
  }
  if (!rows.length) { $('tablebox').hidden = true; setState('No students match', 'Clear the search or filters to see everyone.'); return; }
  $('state').hidden = true; $('tablebox').hidden = false;
  $('rows').replaceChildren(...rows.map((s) => {
    const l = s.checkins[0], gn = gradeNow(s), due = isDue(s);
    return el('tr', {},
      el('td', {}, el('button', { class: 'name', type: 'button', text: fullName(s), onclick: () => openDetail(s.id) }), el('div', { class: 'sub', text: s.school || '' })),
      el('td', {}, s.schoolYear || '', el('div', { class: 'sub', text: fmtDate(s.entryDate) })),
      el('td', {}, s.grade ? (parseInt(s.grade, 10) ? ord(s.grade) : s.grade) : '', el('div', { class: 'sub', text: gn })),
      el('td', { text: s.careers || '' }),
      el('td', {}, pill(s.status)),
      el('td', {}, due ? el('span', { class: 'pill p-due', text: 'Check-in due' }) : null,
        l ? el('div', { class: due ? 'sub' : '', text: (l.doing || 'Checked in') + (l.date ? ' · ' + fmtDate(l.date) : '') })
          : el('div', { class: 'sub', text: s.status === 'Enrolled' ? 'Starts after the program' : 'None yet' })));
  }));
}

/* ---------- school / company picker: choose from the directory, or add a new name ---------- */
function orgPicker(kind, current, id, label, required) {
  const one = kind === 'schools' ? 'school' : 'company';
  const names = dir[kind].map((d) => d.name);
  if (current && !names.includes(current)) names.push(current);
  const fresh = el('input', { id: id + '-new', autocomplete: 'off', maxlength: 200, placeholder: 'New ' + one + ' name', 'aria-label': 'New ' + one + ' name', hidden: true });
  const sel = el('select', { id, required },
    el('option', { value: '', text: required ? 'Choose a ' + one : 'Not recorded' }),
    names.map((n) => el('option', { value: n, text: n })),
    el('option', { value: '__new', text: 'Add a new ' + one + '\u2026' }));
  sel.value = current || '';
  sel.addEventListener('change', () => { fresh.hidden = sel.value !== '__new'; fresh.required = !fresh.hidden; if (!fresh.hidden) fresh.focus(); });
  return { node: el('div', { class: 'picker' }, el('label', {}, label, sel), fresh), value: () => (sel.value === '__new' ? fresh.value.trim() : sel.value) };
}

/* ---------- add / edit student ---------- */
const yearSel = $('f-year');
for (let y = curSY + 1; y >= curSY - 30; y--) yearSel.append(el('option', { value: syLabel(y), text: syLabel(y) }));
// form field id -> student property
const FORM_FIELDS = { 'f-first': 'firstName', 'f-middle': 'middleName', 'f-last': 'lastName', 'f-dob': 'dob', 'f-email': 'email', 'f-phone': 'phone',
  'f-entry': 'entryDate', 'f-grade': 'grade', 'f-status': 'status', 'f-papers': 'workingPapers', 'f-college': 'collegeAccepted', 'f-careers': 'careers', 'f-hobbies': 'hobbies',
  'f-street': 'street', 'f-apt': 'apt', 'f-city': 'city', 'f-state': 'state', 'f-zip': 'zip', 'f-nycha': 'nycha',
  'f-pname': 'parentName', 'f-pemail': 'parentEmail', 'f-pphone': 'parentPhone', 'f-pphone2': 'parentPhone2', 'f-ename': 'emergencyName', 'f-ephone': 'emergencyPhone',
  'f-gender': 'gender', 'f-orient': 'sexualOrientation', 'f-ethnicity': 'ethnicity', 'f-race': 'race', 'f-medical': 'medical', 'f-notes': 'notes' };
function openForm(s) {
  editingId = s ? s.id : null;
  $('form-title').textContent = s ? 'Edit ' + fullName(s) : 'Add student';
  $('form-err').textContent = '';
  for (const [id, key] of Object.entries(FORM_FIELDS)) $(id).value = s ? (s[key] || '') : '';
  if (!s) $('f-status').value = 'Enrolled';
  schoolPick = orgPicker('schools', s ? s.school : '', 'f-school', 'School', false); $('f-school-box').replaceChildren(schoolPick.node);
  const y = s && s.schoolYear ? s.schoolYear : syLabel(curSY);
  if (![...yearSel.options].some((o) => o.value === y)) yearSel.append(el('option', { value: y, text: y }));
  yearSel.value = y;
  $('dlg-form').showModal(); $('f-first').focus();
}
$('add-student').addEventListener('click', () => openForm(null));
$('form-cancel').addEventListener('click', () => $('dlg-form').close());
$('student-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = { school: schoolPick.value(), schoolYear: $('f-year').value };
  for (const [id, key] of Object.entries(FORM_FIELDS)) data[key] = $(id).value.trim();
  const btn = $('form-save'); btn.disabled = true;
  try {
    if (editingId) await api('PUT', '/api/students/' + editingId, data); else await api('POST', '/api/students', data);
    $('dlg-form').close(); await load();
  } catch (err) { $('form-err').textContent = err.message; }
  btn.disabled = false;
});

/* ---------- student record ---------- */
function openDetail(id) { openId = id; openRef = null; panel = null; renderDetail(); if (!$('dlg-detail').open) $('dlg-detail').showModal(); }
$('dlg-detail').addEventListener('close', () => { openId = null; openRef = null; panel = null; });
function confirmBtn(label, run) {
  let armed = false;
  const b = el('button', { class: 'btn link', type: 'button', text: label, onclick: () => {
    if (!armed) { armed = true; b.textContent = 'Click again to confirm'; setTimeout(() => { armed = false; b.textContent = label; }, 4000); } else run();
  } });
  return b;
}
const act = async (method, url, body) => { try { await api(method, url, body); } catch (e) { /* the reload below shows the real state */ } await load(); };

function renderDetail() {
  const s = students.find((x) => x.id === openId), box = $('detail');
  const close = el('button', { class: 'btn small', type: 'button', text: 'Close', onclick: () => $('dlg-detail').close() });
  if (!s) { box.replaceChildren(el('p', { class: 'empty', text: 'This record was removed.' }), el('div', { class: 'actions' }, close)); return; }
  openRef = s;
  const fact = (k, v, full) => el('div', { class: full ? 'full' : '' }, el('span', { text: k }), v || 'Not recorded');
  const gn = gradeNow(s);
  const kids = [
    el('div', { class: 'dlghead' },
      el('div', {}, el('h2', { text: fullName(s) }), el('div', { class: 'pills' }, pill(s.status), isDue(s) ? el('span', { class: 'pill p-due', text: 'Check-in due' }) : null)),
      el('div', { class: 'actions' }, el('button', { class: 'btn small', type: 'button', text: 'Edit details', onclick: () => openForm(s) }), close)),
    el('div', { class: 'facts' },
      fact('School', s.school), fact('Entered ODF', [s.schoolYear, fmtDate(s.entryDate)].filter(Boolean).join(' · ')),
      fact('Grade', s.grade ? (parseInt(s.grade, 10) ? ord(s.grade) + ' at entry' : s.grade) + (gn ? ' · ' + gn : '') : ''),
      fact('Email', s.email), fact('Phone', s.phone), fact('Date of birth', fmtDate(s.dob) + (ageOf(s.dob) ? ' · age ' + ageOf(s.dob) : '')),
      fact('Working papers (I-9)', s.workingPapers), fact('College accepted to', s.collegeAccepted), fact('Hobbies', s.hobbies),
      fact('Initial career interests', s.careers, true),
      el('h3', { text: 'Home address' }),
      fact('Address', [s.street, s.apt].filter(Boolean).join(', ')), fact('City, state, zip', [[s.city, s.state].filter(Boolean).join(', '), s.zip].filter(Boolean).join(' ')), fact('NYCHA', s.nycha),
      el('h3', { text: 'Parent and emergency contacts' }),
      fact('Parent or guardian', s.parentName), fact('Parent email', s.parentEmail), fact('Parent phone', [s.parentPhone, s.parentPhone2].filter(Boolean).join(' · ')),
      fact('Emergency contact', s.emergencyName), fact('Emergency phone', s.emergencyPhone),
      el('h3', { text: 'Demographics and health' }),
      fact('Gender', s.gender), fact('Sexual orientation', s.sexualOrientation), fact('Ethnicity', s.ethnicity), fact('Race', s.race),
      fact('Allergies and medical notes', s.medical, true), s.notes ? fact('Notes', s.notes, true) : null),
  ];

  kids.push(el('section', { class: 'block' },
    el('div', { class: 'blockhead' }, el('h3', { text: 'Internships' }), panel !== 'intern' && el('button', { class: 'btn small', type: 'button', text: 'Add internship', onclick: () => { panel = 'intern'; renderDetail(); } })),
    panel === 'intern' ? internForm(s) : null,
    s.internships.length ? s.internships.map((i) => el('div', { class: 'item' },
      el('div', {}, el('strong', { text: i.company || 'Company not recorded' }), i.role ? ' · ' + i.role : '',
        el('div', { class: 'sub', text: [fmtDate(i.start), fmtDate(i.end)].filter(Boolean).join(' to ') }), i.notes ? el('p', { text: i.notes }) : null),
      confirmBtn('Remove', () => act('DELETE', '/api/internships/' + i.id))))
      : (panel === 'intern' ? null : el('p', { class: 'empty', text: 'No internship placements recorded.' }))));

  kids.push(el('section', { class: 'block' },
    el('div', { class: 'blockhead' }, el('h3', { text: 'Yearly check-ins' }), panel !== 'checkin' && el('button', { class: 'btn small primary', type: 'button', text: 'Record check-in', onclick: () => { panel = 'checkin'; renderDetail(); } })),
    panel === 'checkin' ? checkinForm(s) : null,
    s.checkins.length ? s.checkins.map((c) => el('div', { class: 'item ci' },
      el('div', {}, el('strong', { text: c.doing || 'Checked in' }), c.date ? ' · ' + fmtDate(c.date) : '',
        (c.where || c.detail) ? el('div', { class: 'sub', text: [c.where, c.detail].filter(Boolean).join(' · ') }) : null,
        c.notes ? el('p', { text: c.notes }) : null, c.byName ? el('div', { class: 'sub', text: 'Recorded by ' + c.byName }) : null),
      confirmBtn('Remove', () => act('DELETE', '/api/checkins/' + c.id))))
      : (panel === 'checkin' ? null : el('p', { class: 'empty', text: 'No check-ins yet. Record one each year after the student finishes the program.' }))));

  kids.push(el('div', { class: 'actions' },
    el('span', { class: 'sub grow', text: s.updatedAt ? 'Last updated ' + fmtDate(s.updatedAt) + (s.updatedByName ? ' by ' + s.updatedByName : '') : '' }),
    me.role === 'admin' && confirmBtn('Delete this student record', async () => { await act('DELETE', '/api/students/' + s.id); $('dlg-detail').close(); })));
  box.replaceChildren(...kids.filter(Boolean));
}

function inlineForm(fields, saveLabel, submit) {
  const err = el('span', { class: 'err', role: 'alert' });
  return el('form', { class: 'inline', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    try { await submit(); panel = null; openRef = null; await load(); } catch (ex) { err.textContent = ex.message; }
  } }, el('div', { class: 'grid' }, fields),
  el('div', { class: 'actions' }, err, el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => { panel = null; renderDetail(); } }), el('button', { class: 'btn primary', type: 'submit', text: saveLabel })));
}
function internForm(s) {
  const co = orgPicker('companies', '', 'i-company', 'Company', true), ro = el('input', { id: 'i-role', autocomplete: 'off', maxlength: 200 }),
    st = el('input', { id: 'i-start', type: 'date' }), en = el('input', { id: 'i-end', type: 'date' }), no = el('textarea', { id: 'i-notes', maxlength: 5000 });
  return inlineForm([co.node, el('label', {}, 'Role or department', ro), el('label', {}, 'Start date', st), el('label', {}, 'End date', en), el('label', { class: 'full' }, 'Notes', no)],
    'Save internship', () => api('POST', '/api/students/' + s.id + '/internships', { company: co.value(), role: ro.value, start: st.value, end: en.value, notes: no.value }));
}
function checkinForm(s) {
  const da = el('input', { id: 'c-date', type: 'date', required: true, value: today() }), doing = el('select', { id: 'c-doing' }, DOING.map((d) => el('option', { text: d }))),
    wh = el('input', { id: 'c-where', autocomplete: 'off', placeholder: 'School or employer', maxlength: 200 }),
    de = el('input', { id: 'c-detail', autocomplete: 'off', placeholder: 'Major, field or job title', maxlength: 200 }), no = el('textarea', { id: 'c-notes', maxlength: 5000 });
  return inlineForm([el('label', {}, 'Check-in date', da), el('label', {}, 'What they are doing now', doing), el('label', {}, 'Where', wh), el('label', {}, 'Details', de), el('label', { class: 'full' }, 'Notes', no)],
    'Save check-in', () => api('POST', '/api/students/' + s.id + '/checkins', { date: da.value, doing: doing.value, where: wh.value, detail: de.value, notes: no.value }));
}

/* ---------- filters and export ---------- */
['q', 'f-cohort', 'f-stat', 'f-due'].forEach((id) => $(id).addEventListener(id === 'q' ? 'input' : 'change', render));
function downloadCSV(name, head, rows) {
  // A leading apostrophe stops a spreadsheet from running a cell that starts like a formula.
  const esc = (v) => { let t = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
  const url = URL.createObjectURL(new Blob(['\ufeff' + [head, ...rows].map((r) => r.map(esc).join(',')).join('\r\n')], { type: 'text/csv' }));
  const a = el('a', { href: url, download: name + '-' + today() + '.csv' });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('get-csv').addEventListener('click', () => {
  const cols = IMPORT_COLS.filter(([k]) => !EXPORT_SKIP.includes(k));
  const head = [...cols.map((c) => c[1]), 'Internships', 'Check-ins recorded', 'Latest check-in date', 'Latest check-in', 'Where', 'Details', 'Check-in due'];
  downloadCSV('odf-students', head, filtered().map((s) => { const l = s.checkins[0] || {}; return [...cols.map(([k]) => s[k]),
    s.internships.map((i) => i.company).filter(Boolean).join('; '), s.checkins.length, l.date, l.doing, l.where, l.detail, isDue(s) ? 'Yes' : 'No']; }));
});

/* ---------- import students from CSV ---------- */
const IMPORT_COLS = [
  ['firstName', 'First name'], ['middleName', 'Middle name'], ['lastName', 'Last name'], ['school', 'School'], ['schoolYear', 'School year entered'], ['entryDate', 'Date entered'],
  ['grade', 'Grade at entry'], ['status', 'Status'], ['email', 'Email'], ['phone', 'Phone'], ['dob', 'Date of birth'],
  ['gender', 'Gender'], ['sexualOrientation', 'Sexual orientation'], ['ethnicity', 'Ethnicity'], ['race', 'Race'], ['medical', 'Allergies and medical'],
  ['street', 'Street address'], ['apt', 'Apt, floor or location'], ['city', 'City'], ['state', 'State'], ['zip', 'Zip code'], ['nycha', 'NYCHA'],
  ['workingPapers', 'Has working papers (I-9)'], ['collegeAccepted', 'College accepted'],
  ['parentName', 'Parent name'], ['parentEmail', 'Parent email'], ['parentPhone', 'Parent phone'], ['parentPhone2', 'Parent phone 2'],
  ['emergencyName', 'Emergency contact name'], ['emergencyPhone', 'Emergency contact phone'],
  ['careers', 'Career interests'], ['hobbies', 'Hobbies'], ['notes', 'Notes'],
  ['company', 'Internship company'], ['role', 'Internship role'], ['internStart', 'Internship start'], ['internEnd', 'Internship end'],
  ['companyAddress', 'Internship address'], ['companyContact', 'Internship contact name'], ['companyContactTitle', 'Internship contact job title'],
  ['companyContactPhone', 'Internship contact phone'], ['companyContactEmail', 'Internship contact email'],
];
const EXPORT_SKIP = ['company', 'role', 'internStart', 'internEnd', 'companyAddress', 'companyContact', 'companyContactTitle', 'companyContactPhone', 'companyContactEmail'];
// Other spellings of the same headers, as they appear on the ODF intake sheet. Keys are lower-case letters and digits only.
const IMPORT_ALIASES = { firstname: 'firstName', lastname: 'lastName', middlename: 'middleName', schoolyear: 'schoolYear', entrydate: 'entryDate', grade: 'grade', juniorsenior: 'grade',
  phonenumber: 'phone', dateofbirth: 'dob', dob: 'dob', allergiesmedical: 'medical', aptfloorlocation: 'apt', zip: 'zip', workingpapers: 'workingPapers',
  parentsname: 'parentName', parentphone2: 'parentPhone2', emergencycontact: 'emergencyPhone', careerinterest: 'careers',
  company: 'company', internshiplocationname: 'company', internshipstartdate: 'internStart', internshipenddate: 'internEnd',
  contactnameatinternshiplocation: 'companyContact', contactnameatinternshiplocationjobtitle: 'companyContactTitle',
  contactnameatinternshiplocationphonenumber: 'companyContactPhone', contactnameatinternshiplocationemailaddress: 'companyContactEmail' };
let importText = '';
let importRows = [];
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c, i) => c.trim() !== '' && !(i === 0 && /^\d+$/.test(c.trim()))));
}
const normKey = (h) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
function toISO(v) {
  v = v.trim(); if (!v) return '';
  let iso = null, m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  if (m) iso = m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(v); // US order: month/day/year
  if (m) iso = (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
  if (!iso) return null;
  const d = new Date(iso + 'T12:00:00Z'); // rejects impossible dates such as month 13 or Feb 30
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}
function toSchoolYear(v, entryISO) {
  v = v.trim();
  const m = /^(\d{4})(?:\s*[-\/–]\s*(\d{2}|\d{4}))?$/.exec(v);
  if (m) return syLabel(+m[1]);
  if (!v && entryISO) { const y = +entryISO.slice(0, 4), mo = +entryISO.slice(5, 7); return syLabel(mo >= 7 ? y : y - 1); }
  return null;
}
function toStatus(v) {
  const t = v.trim().toLowerCase();
  if (!t) return $('import-status').value;
  if (/^(completed|complete|alumni|alumnus|alumna|graduated|finished)$/.test(t)) return 'Completed';
  if (/^(enrolled|active|current)$/.test(t)) return 'Enrolled';
  if (/^(left early|left|withdrew|withdrawn|dropped)$/.test(t)) return 'Left early';
  return null;
}
function toGrade(v) {
  const t = v.trim(); if (!t) return '';
  const words = { freshman: '9', sophomore: '10', junior: '11', senior: '12' }[t.toLowerCase()];
  if (words) return words;
  const m = /(\d{1,2})/.exec(t);
  return m && ['8', '9', '10', '11', '12'].includes(m[1]) ? m[1] : 'Other';
}
function readImport(text) {
  const table = parseCSV(text);
  if (table.length < 2) return { error: 'That file has no student rows under its header row.' };
  const want = new Map([...IMPORT_COLS.map(([k, label]) => [normKey(label), k]), ...Object.entries(IMPORT_ALIASES)]);
  const cols = table[0].map((h) => want.get(normKey(h)) || null); // a Social Security column matches nothing here, so it is dropped
  if (!cols.includes('firstName') || !cols.includes('lastName')) return { error: 'The header row needs columns named First name and Last name. Download the template to see the layout.' };
  const have = new Set(students.map((s) => (s.firstName + '|' + s.lastName + '|' + s.schoolYear).toLowerCase()));
  const out = table.slice(1).map((r, n) => {
    const d = { row: n + 2 };
    // Files made by Download CSV put an apostrophe in front of cells that look like formulas.
    cols.forEach((k, i) => { if (k && d[k] == null) d[k] = (r[i] || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'(?=[=+\-@])/, '').replace(/^pending$/i, ''); });
    for (const [k] of IMPORT_COLS) if (d[k] == null) d[k] = '';
    const problems = [];
    if (!d.firstName || !d.lastName) problems.push('First or last name is missing');
    for (const k of ['entryDate', 'dob', 'internStart', 'internEnd']) { const iso = toISO(d[k]); if (iso === null) problems.push('Date "' + d[k] + '" is not readable (use 2021-09-13 or 9/13/2021)'); else d[k] = iso; }
    const sy = toSchoolYear(d.schoolYear, d.entryDate) || (!d.schoolYear && $('import-year').value) || null;
    if (!sy) problems.push(d.schoolYear ? 'School year "' + d.schoolYear + '" is not readable (use 2021-22)' : 'School year entered is missing'); else d.schoolYear = sy;
    const st = toStatus(d.status);
    if (!st) problems.push('Status "' + d.status + '" is not Enrolled, Completed or Left early'); else d.status = st;
    d.grade = toGrade(d.grade);
    d.workingPapers = ({ yes: 'Yes', y: 'Yes', no: 'No', n: 'No', pending: 'Pending' })[d.workingPapers.toLowerCase()] || '';
    if (d.parentEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.parentEmail)) problems.push('Parent email "' + d.parentEmail + '" does not look right');
    if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) problems.push('Email "' + d.email + '" does not look right');
    const key = (d.firstName + '|' + d.lastName + '|' + d.schoolYear).toLowerCase();
    d.problem = problems.join('; ');
    d.duplicate = !d.problem && have.has(key);
    if (!d.problem) have.add(key);
    return d;
  });
  return { rows: out, ignored: table[0].map((h, i) => (cols[i] ? null : h.replace(/\s+/g, ' ').trim())).filter(Boolean) };
}
function showImport(res) {
  const box = $('import-preview'); importRows = []; $('import-go').hidden = true; $('import-err').textContent = '';
  if (res.error) { box.replaceChildren(el('p', { class: 'err', text: res.error })); return; }
  const bad = res.rows.filter((d) => d.problem), dup = res.rows.filter((d) => d.duplicate);
  importRows = res.rows.filter((d) => !d.problem && !d.duplicate);
  const kids = [el('div', { class: 'counts' },
    el('span', { class: 'pill p-Enrolled', text: importRows.length + ' ready to import' }),
    bad.length ? el('span', { class: 'pill p-due', text: bad.length + ' need fixing' }) : null,
    dup.length ? el('span', { class: 'pill p-Left', text: dup.length + ' already on record, skipped' }) : null)];
  if (bad.length) kids.push(rTable('Rows that will not be imported until fixed in the file', ['Row', 'Student', 'Problem'], bad.slice(0, 50).map((d) => [d.row, (d.firstName + ' ' + d.lastName).trim(), d.problem])),
    bad.length > 50 ? el('p', { class: 'empty', text: 'Showing the first 50 of ' + bad.length + '.' }) : null);
  if (res.ignored.length) kids.push(el('p', { class: 'empty', text: 'Columns in the file that are not imported: ' + res.ignored.join(', ') + '.' }));
  if (importRows.length) kids.push(rTable('First rows as they will be imported', ['Student', 'School', 'Entered', 'Grade', 'Status', 'Internship'],
    importRows.slice(0, 5).map((d) => [d.firstName + ' ' + d.lastName, d.school, d.schoolYear, d.grade, d.status, d.company])));
  if (importRows.length > 1000) { kids.push(el('p', { class: 'err', text: 'This file has more than 1,000 students. Split it into smaller files.' })); importRows = []; }
  box.replaceChildren(...kids.filter(Boolean));
  $('import-go').hidden = !importRows.length;
  $('import-go').textContent = 'Import ' + importRows.length + (importRows.length === 1 ? ' student' : ' students');
}
$('open-import').addEventListener('click', () => { $('import-file').value = ''; $('import-preview').replaceChildren(); $('import-err').textContent = ''; $('import-go').hidden = true; importRows = []; importText = '';
  const ys = $('import-year'), keep = ys.value; ys.replaceChildren(el('option', { value: '', text: 'Nothing: flag the row' })); for (let y = curSY + 1; y >= curSY - 30; y--) ys.append(el('option', { value: syLabel(y), text: syLabel(y) })); ys.value = keep;
  $('dlg-import').showModal(); });
['import-year', 'import-status'].forEach((id) => $(id).addEventListener('change', () => { if (importText) showImport(readImport(importText)); }));
// Excel often saves CSV in its own Windows encoding rather than UTF-8; reading it as UTF-8 would garble accented names.
function decodeCSV(buf) { try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { return new TextDecoder('windows-1252').decode(buf); } }
$('import-close').addEventListener('click', () => $('dlg-import').close());
const TEMPLATE_ROW = { firstName: 'Maria', lastName: 'Example', school: 'Example High School', schoolYear: '2021-22', entryDate: '2021-09-13', grade: '11', status: 'Completed',
  email: 'maria@example.org', phone: '555-0100', careers: 'Nursing, public health', hobbies: 'Soccer', notes: 'Delete this example row',
  company: 'Example Company', role: 'Office intern', internStart: '2022-02-07', internEnd: '2022-06-10' };
$('import-template').addEventListener('click', () => downloadCSV('odf-import-template', IMPORT_COLS.map((c) => c[1]), [IMPORT_COLS.map(([k]) => TEMPLATE_ROW[k] || '')]));
$('import-file').addEventListener('change', async () => {
  const f = $('import-file').files[0]; if (!f) return;
  if (f.size > 2e6) { showImport({ error: 'That file is larger than 2 MB. Split it into smaller files.' }); return; }
  try { importText = decodeCSV(await f.arrayBuffer()); showImport(readImport(importText)); } catch (e) { importText = ''; showImport({ error: 'That file could not be read as a CSV.' }); }
});
$('import-go').addEventListener('click', async () => {
  const btn = $('import-go'); btn.disabled = true; $('import-err').textContent = '';
  try {
    const r = await api('POST', '/api/students/import', { rows: importRows });
    await load(); importRows = []; importText = ''; btn.hidden = true; $('import-file').value = '';
    $('import-preview').replaceChildren(el('div', { class: 'note' }, el('strong', { text: r.added + (r.added === 1 ? ' student' : ' students') + ' imported' }),
      [r.skipped ? r.skipped + ' already on record and skipped. ' : '', r.problems.length ? r.problems.length + ' refused by the server: ' + r.problems.slice(0, 5).map((p) => 'row ' + p.row + ' (' + p.error + ')').join(', ') : ''].join('') || 'They are now in the Students list.'));
  } catch (err) { $('import-err').textContent = err.message; }
  btn.disabled = false;
});

/* ---------- tabs ---------- */
const TABS = ['students', 'schools', 'companies', 'reports'];
function renderTab() {
  for (const t of TABS) $('tab-' + t).hidden = t !== tab;
  for (const b of document.querySelectorAll('.tab')) { if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
  if (tab === 'schools' || tab === 'companies') renderOrgs(tab);
  if (tab === 'reports') renderReport();
}
for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => { tab = b.dataset.tab; renderTab(); });

/* ---------- schools and companies ---------- */
let orgKind = 'schools', orgId = null;
const orgWord = (k) => (k === 'schools' ? 'school' : 'company');
function renderOrgs(kind) {
  const list = dir[kind];
  $(kind + '-empty').hidden = !loaded || list.length > 0; $(kind + '-box').hidden = !list.length;
  $(kind + '-rows').replaceChildren(...list.map((d) => el('tr', {},
    el('td', {}, el('button', { class: 'name', type: 'button', text: d.name, onclick: () => openOrg(kind, d) }), d.notes ? el('div', { class: 'sub', text: d.notes }) : null),
    el('td', { text: d.address }), el('td', {}, d.contactName, d.contactTitle ? el('div', { class: 'sub', text: d.contactTitle }) : null),
    el('td', {}, d.contactPhone, d.contactEmail ? el('div', { class: d.contactPhone ? 'sub' : '', text: d.contactEmail }) : null),
    el('td', { text: d.uses }))));
}
function openOrg(kind, d) {
  orgKind = kind; orgId = d ? d.id : null;
  $('org-title').textContent = d ? 'Edit ' + d.name : 'Add ' + orgWord(kind);
  $('org-err').textContent = '';
  $('o-name').value = d ? d.name : ''; $('o-address').value = d ? d.address : ''; $('o-contact').value = d ? d.contactName : ''; $('o-title').value = d ? d.contactTitle : '';
  $('o-phone').value = d ? d.contactPhone : ''; $('o-email').value = d ? d.contactEmail : ''; $('o-notes').value = d ? d.notes : '';
  $('org-delete').replaceChildren(d && me.role === 'admin' ? confirmBtn('Delete this ' + orgWord(kind), async () => {
    try { await api('DELETE', '/api/' + kind + '/' + d.id); $('dlg-org').close(); await load(); } catch (err) { $('org-err').textContent = err.message; }
  }) : '');
  $('dlg-org').showModal(); $('o-name').focus();
}
$('add-schools').addEventListener('click', () => openOrg('schools', null));
$('add-companies').addEventListener('click', () => openOrg('companies', null));
$('org-cancel').addEventListener('click', () => $('dlg-org').close());
$('org-form').addEventListener('submit', async (e) => {
  e.preventDefault(); $('org-err').textContent = ''; $('org-save').disabled = true;
  const body = { name: $('o-name').value, address: $('o-address').value, contactName: $('o-contact').value, contactTitle: $('o-title').value, contactPhone: $('o-phone').value, contactEmail: $('o-email').value, notes: $('o-notes').value };
  try {
    if (orgId) await api('PUT', '/api/' + orgKind + '/' + orgId, body); else await api('POST', '/api/' + orgKind, body);
    $('dlg-org').close(); await load();
  } catch (err) { $('org-err').textContent = err.message; }
  $('org-save').disabled = false;
});

/* ---------- reports ---------- */
const REPORTS = { enrollment: 'Enrollment', outcomes: 'Alumni outcomes', internships: 'Internship placements', due: 'Check-ins due', demographics: 'Demographics' };
function fillSelect(sel, allLabel, values) {
  const keep = sel.value;
  sel.replaceChildren(el('option', { value: '', text: allLabel }), ...values.map((v) => el('option', { value: v, text: v })));
  sel.value = values.includes(keep) ? keep : '';
}
const countBy = (items, key) => { const m = new Map(); for (const i of items) { const k = key(i); m.set(k, (m.get(k) || 0) + 1); } return m; };
const pct = (n, d) => (d ? Math.round((n / d) * 100) + '%' : '');
function rTable(title, head, rows, opts = {}) {
  const numFrom = opts.numFrom == null ? head.length : opts.numFrom;
  const cell = (tag, v, i) => el(tag, { class: i >= numFrom ? 'num' : '', text: v == null ? '' : v });
  return el('div', { class: 'rblock' }, title ? el('h3', { text: title }) : null,
    el('div', { class: 'tablebox' + (opts.wide ? ' wide' : '') }, el('table', {},
      el('thead', {}, el('tr', {}, head.map((h, i) => cell('th', h, i)))),
      el('tbody', {}, rows.map((r, n) => el('tr', { class: opts.total && n === rows.length - 1 ? 'total' : '' }, r.map((v, i) => cell('td', v, i))))))));
}
function renderReport() {
  const type = $('r-type').value;
  fillSelect($('r-year'), 'All entry years', [...new Set(students.map((s) => s.schoolYear).filter(Boolean))].sort().reverse());
  fillSelect($('r-school'), 'All schools', [...new Set(students.map((s) => s.school).filter(Boolean))].sort((a, b) => a.localeCompare(b)));
  fillSelect($('r-company'), 'All companies', [...new Set(students.flatMap((s) => s.internships.map((i) => i.company)).filter(Boolean))].sort((a, b) => a.localeCompare(b)));
  $('r-company').hidden = type !== 'internships'; $('r-status').hidden = type !== 'enrollment' && type !== 'demographics';
  const year = $('r-year').value, school = $('r-school').value, company = $('r-company').value, status = type === 'enrollment' || type === 'demographics' ? $('r-status').value : '';
  const base = students.filter((s) => (!year || s.schoolYear === year) && (!school || s.school === school) && (!status || s.status === status));
  const scope = [year ? 'Entered ' + year : 'All entry years', school || 'All schools', type === 'internships' && company ? company : null, status || null].filter(Boolean).join(' \u00b7 ');
  const blocks = [];
  let head = [], rows = [], lead = '';

  if (type === 'enrollment') {
    lead = base.length + (base.length === 1 ? ' student' : ' students');
    const years = [...new Set(base.map((s) => s.schoolYear))].sort().reverse();
    const yr = years.map((y) => { const g = base.filter((s) => s.schoolYear === y); return [y, g.length, ...['Enrolled', 'Completed', 'Left early'].map((t) => g.filter((s) => s.status === t).length)]; });
    yr.push(['Total', base.length, ...['Enrolled', 'Completed', 'Left early'].map((t) => base.filter((s) => s.status === t).length)]);
    const bySchool = [...countBy(base, (s) => s.school || 'School not recorded')].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    blocks.push(el('div', { class: 'pair' },
      rTable('By school year entered', ['School year', 'Students', 'Enrolled', 'Completed', 'Left early'], yr, { numFrom: 1, total: true }),
      rTable('By school', ['School', 'Students'], bySchool, { numFrom: 1 })));
    head = ['Student', 'School', 'Entered', 'Grade at entry', 'Status', 'Career interests'];
    rows = base.map((s) => [fullName(s), s.school, s.schoolYear, s.grade, s.status, s.careers]);
    blocks.push(rTable('Students', head, rows, { wide: true }));
  } else if (type === 'outcomes') {
    const past = base.filter((s) => s.status !== 'Enrolled'), reached = past.filter((s) => s.checkins.length);
    lead = past.length + ' past ' + (past.length === 1 ? 'student' : 'students') + ', ' + reached.length + ' with a check-in on record';
    const by = [...countBy(past, (s) => (s.checkins[0] ? s.checkins[0].doing : 'No check-in yet'))].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    blocks.push(rTable('What past students are doing now (latest check-in)', ['Outcome', 'Students', 'Share'], by.map(([k, n]) => [k, n, pct(n, past.length)]), { numFrom: 1 }));
    head = ['Student', 'School', 'Entered', 'Status', 'Latest check-in', 'Doing now', 'Where', 'Details'];
    rows = past.map((s) => { const l = s.checkins[0] || {}; return [fullName(s), s.school, s.schoolYear, s.status, fmtDate(l.date), l.doing || 'No check-in yet', l.where, l.detail]; });
    blocks.push(rTable('Past students', head, rows, { wide: true }));
  } else if (type === 'internships') {
    const list = base.flatMap((s) => s.internships.filter((i) => !company || i.company === company).map((i) => ({ s, i }))).sort((a, b) => (b.i.start || '').localeCompare(a.i.start || ''));
    lead = list.length + (list.length === 1 ? ' placement' : ' placements') + ' for ' + new Set(list.map((x) => x.s.id)).size + ' students';
    const by = [...countBy(list, (x) => x.i.company || 'Company not recorded')].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    blocks.push(rTable('By company', ['Company', 'Placements', 'Students'], by.map(([k, n]) => [k, n, new Set(list.filter((x) => (x.i.company || 'Company not recorded') === k).map((x) => x.s.id)).size]), { numFrom: 1 }));
    head = ['Student', 'School', 'Entered', 'Company', 'Role', 'Start', 'End'];
    rows = list.map(({ s, i }) => [fullName(s), s.school, s.schoolYear, i.company, i.role, fmtDate(i.start), fmtDate(i.end)]);
    blocks.push(rTable('Placements', head, rows, { wide: true }));
  } else if (type === 'demographics') {
    // Totals only: this report never lists a student by name.
    lead = base.length + (base.length === 1 ? ' student' : ' students');
    const groups = [['Gender', (s) => s.gender], ['Ethnicity', (s) => s.ethnicity], ['Race', (s) => s.race], ['Sexual orientation', (s) => s.sexualOrientation],
      ['Grade at entry', (s) => (parseInt(s.grade, 10) ? ord(s.grade) : s.grade)], ['Lives in NYCHA housing', (s) => (!s.nycha ? '' : /^(no|n)\b/i.test(s.nycha) ? 'No' : /^maybe/i.test(s.nycha) ? 'Unsure' : 'Yes')],
      ['Age today', (s) => (ageOf(s.dob) ? String(ageOf(s.dob)) : '')], ['Home zip code', (s) => s.zip]];
    head = ['Category', 'Answer', 'Students', 'Share'];
    const tables = groups.map(([title, get]) => {
      const by = [...countBy(base, (s) => get(s) || 'Not recorded')].sort((a, b) => (a[0] === 'Not recorded') - (b[0] === 'Not recorded') || b[1] - a[1] || a[0].localeCompare(b[0]));
      for (const [k, n] of by) rows.push([title, k, n, pct(n, base.length)]);
      return rTable(title, [title, 'Students', 'Share'], by.map(([k, n]) => [k, n, pct(n, base.length)]), { numFrom: 1 });
    });
    for (let i = 0; i < tables.length; i += 2) blocks.push(el('div', { class: 'pair' }, tables[i], tables[i + 1]));
  } else {
    const due = base.filter(isDue);
    lead = due.length + ' past ' + (due.length === 1 ? 'student has' : 'students have') + ' no check-in in the last 12 months';
    head = ['Student', 'School', 'Entered', 'Status', 'Last check-in', 'Email', 'Phone'];
    rows = due.map((s) => [fullName(s), s.school, s.schoolYear, s.status, s.checkins[0] ? fmtDate(s.checkins[0].date) : 'Never', s.email, s.phone]);
    blocks.push(rTable('Students to contact', head, rows, { wide: true }));
  }
  report = { name: 'odf-' + type, head, rows };
  $('report').replaceChildren(
    el('div', {}, el('h2', { text: 'ODF ' + REPORTS[type].toLowerCase() + ' report' }), el('p', { class: 'sub', text: scope + ' \u00b7 ' + lead + ' \u00b7 as of ' + fmtDate(today()) })),
    ...(rows.length ? blocks : [el('div', { class: 'note' }, el('strong', { text: 'Nothing to report' }), 'No records match these filters yet.')]));
}
['r-type', 'r-year', 'r-school', 'r-company', 'r-status'].forEach((id) => $(id).addEventListener('change', renderReport));
$('r-csv').addEventListener('click', () => { if (report) downloadCSV(report.name, report.head, report.rows); });
$('r-print').addEventListener('click', () => window.print());

/* ---------- staff accounts ---------- */
async function loadStaff() {
  const box = $('staff-list');
  let users;
  try { users = (await api('GET', '/api/users')).users; } catch (err) { box.replaceChildren(el('p', { class: 'err', text: err.message })); return; }
  box.replaceChildren(...users.map((u) => {
    const err = el('span', { class: 'err', role: 'alert' });
    const change = async (body) => { err.textContent = ''; try { await api('PUT', '/api/users/' + u.id, body); await loadStaff(); } catch (ex) { err.textContent = ex.message; } };
    const pw = el('input', { id: 'reset-' + u.id, placeholder: 'New temporary password (10+ characters)', autocomplete: 'off', 'aria-label': 'New temporary password for ' + u.name });
    const reset = el('div', { class: 'reset', hidden: true }, pw, el('button', { class: 'btn small primary', type: 'button', text: 'Set password', onclick: () => change({ password: pw.value }) }));
    const self = u.id === me.id;
    return el('div', { class: 'user' + (u.active ? '' : ' off') },
      el('div', {}, el('strong', { text: u.name || u.email }), self ? ' (you)' : '', el('div', { class: 'sub', text: u.email + ' · ' + (u.role === 'admin' ? 'Admin' : 'Staff') + (u.active ? '' : ' · Deactivated') + (u.mustChange && u.active ? ' · Has not set own password yet' : '') })),
      el('div', { class: 'actions' },
        !self && u.active && el('button', { class: 'btn small', type: 'button', text: 'Reset password', onclick: () => { reset.hidden = !reset.hidden; if (!reset.hidden) pw.focus(); } }),
        !self && u.active && el('button', { class: 'btn small', type: 'button', text: u.role === 'admin' ? 'Make staff' : 'Make admin', onclick: () => change({ role: u.role === 'admin' ? 'staff' : 'admin' }) }),
        !self && el('button', { class: 'btn small', type: 'button', text: u.active ? 'Deactivate' : 'Reactivate', onclick: () => change({ active: !u.active }) })),
      reset, err);
  }));
}
$('open-staff').addEventListener('click', () => { $('staff-err').textContent = ''; $('dlg-staff').showModal(); loadStaff(); });
$('staff-close').addEventListener('click', () => $('dlg-staff').close());
$('staff-form').addEventListener('submit', async (e) => {
  e.preventDefault(); $('staff-err').textContent = '';
  try {
    await api('POST', '/api/users', { name: $('u-name').value, email: $('u-email').value, role: $('u-role').value, password: $('u-pass').value });
    $('staff-form').reset(); await loadStaff();
  } catch (err) { $('staff-err').textContent = err.message; }
});

/* ---------- light / dark ---------- */
const THEME_LABEL = { auto: 'Match device', light: 'Light', dark: 'Dark' };
function currentTheme() { try { const t = localStorage.getItem('odf-theme'); return t === 'light' || t === 'dark' ? t : 'auto'; } catch (e) { return 'auto'; } }
function applyTheme(t) {
  try { if (t === 'auto') localStorage.removeItem('odf-theme'); else localStorage.setItem('odf-theme', t); } catch (e) { /* the choice still applies until the page is closed */ }
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  for (const b of document.querySelectorAll('.theme-btn')) { b.textContent = 'Theme: ' + THEME_LABEL[t]; b.dataset.theme = t; }
}
for (const b of document.querySelectorAll('.theme-btn')) b.addEventListener('click', () => applyTheme({ auto: 'light', light: 'dark', dark: 'auto' }[b.dataset.theme || 'auto']));
applyTheme(currentTheme());

/* ---------- start ---------- */
(async () => {
  try { me = (await fetch('/api/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)) || {}).user || null; } catch (e) { me = null; }
  if (me) showApp(); else showLogin();
})();
