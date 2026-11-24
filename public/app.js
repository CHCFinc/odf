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
function openForm(s) {
  editingId = s ? s.id : null;
  $('form-title').textContent = s ? 'Edit ' + fullName(s) : 'Add student';
  $('form-err').textContent = '';
  $('f-first').value = s ? s.firstName : ''; $('f-last').value = s ? s.lastName : '';
  schoolPick = orgPicker('schools', s ? s.school : '', 'f-school', 'School', false); $('f-school-box').replaceChildren(schoolPick.node);
  const y = s && s.schoolYear ? s.schoolYear : syLabel(curSY);
  if (![...yearSel.options].some((o) => o.value === y)) yearSel.append(el('option', { value: y, text: y }));
  yearSel.value = y;
  $('f-entry').value = s ? s.entryDate : ''; $('f-grade').value = s ? s.grade : ''; $('f-status').value = s ? s.status : 'Enrolled';
  $('f-email').value = s ? s.email : ''; $('f-phone').value = s ? s.phone : ''; $('f-careers').value = s ? s.careers : '';
  $('f-hobbies').value = s ? s.hobbies : ''; $('f-notes').value = s ? s.notes : '';
  $('dlg-form').showModal(); $('f-first').focus();
}
$('add-student').addEventListener('click', () => openForm(null));
$('form-cancel').addEventListener('click', () => $('dlg-form').close());
$('student-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = (id) => $(id).value.trim();
  const data = { firstName: v('f-first'), lastName: v('f-last'), school: schoolPick.value(), schoolYear: $('f-year').value, entryDate: $('f-entry').value,
    grade: $('f-grade').value, status: $('f-status').value, email: v('f-email'), phone: v('f-phone'), careers: v('f-careers'), hobbies: v('f-hobbies'), notes: v('f-notes') };
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
      fact('Email', s.email), fact('Phone', s.phone), fact('Hobbies', s.hobbies),
      fact('Initial career interests', s.careers, true), s.notes ? fact('Notes', s.notes, true) : null),
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
  const head = ['First name', 'Last name', 'School', 'School year entered', 'Date entered', 'Grade at entry', 'Status', 'Email', 'Phone', 'Career interests', 'Hobbies', 'Internships', 'Check-ins recorded', 'Latest check-in date', 'Latest check-in', 'Where', 'Details', 'Check-in due', 'Notes'];
  downloadCSV('odf-students', head, filtered().map((s) => { const l = s.checkins[0] || {}; return [s.firstName, s.lastName, s.school, s.schoolYear, s.entryDate, s.grade, s.status, s.email, s.phone, s.careers, s.hobbies,
    s.internships.map((i) => i.company).filter(Boolean).join('; '), s.checkins.length, l.date, l.doing, l.where, l.detail, isDue(s) ? 'Yes' : 'No', s.notes]; }));
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
    el('td', { text: d.address }), el('td', { text: d.contactName }),
    el('td', {}, d.contactPhone, d.contactEmail ? el('div', { class: d.contactPhone ? 'sub' : '', text: d.contactEmail }) : null),
    el('td', { text: d.uses }))));
}
function openOrg(kind, d) {
  orgKind = kind; orgId = d ? d.id : null;
  $('org-title').textContent = d ? 'Edit ' + d.name : 'Add ' + orgWord(kind);
  $('org-err').textContent = '';
  $('o-name').value = d ? d.name : ''; $('o-address').value = d ? d.address : ''; $('o-contact').value = d ? d.contactName : '';
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
  const body = { name: $('o-name').value, address: $('o-address').value, contactName: $('o-contact').value, contactPhone: $('o-phone').value, contactEmail: $('o-email').value, notes: $('o-notes').value };
  try {
    if (orgId) await api('PUT', '/api/' + orgKind + '/' + orgId, body); else await api('POST', '/api/' + orgKind, body);
    $('dlg-org').close(); await load();
  } catch (err) { $('org-err').textContent = err.message; }
  $('org-save').disabled = false;
});

/* ---------- reports ---------- */
const REPORTS = { enrollment: 'Enrollment', outcomes: 'Alumni outcomes', internships: 'Internship placements', due: 'Check-ins due' };
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
  $('r-company').hidden = type !== 'internships'; $('r-status').hidden = type !== 'enrollment';
  const year = $('r-year').value, school = $('r-school').value, company = $('r-company').value, status = type === 'enrollment' ? $('r-status').value : '';
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

/* ---------- start ---------- */
(async () => {
  try { me = (await fetch('/api/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)) || {}).user || null; } catch (e) { me = null; }
  if (me) showApp(); else showLogin();
})();
