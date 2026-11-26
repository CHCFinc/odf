# ODF Student Tracker

Tracks students in CHCF's Opening the Doors to the Future (ODF) program: intake details, internships, and a yearly check-in after they finish. It also keeps a directory of partner schools and host companies with a contact at each, and produces four reports (enrollment, alumni outcomes, internship placements, check-ins due) that can be filtered, printed or downloaded as CSV. Staff sign in with an email and password; there is no public sign-up.

Built for GoDaddy Node.js Hosting: a Node.js 22 Express app with a managed MySQL database.

Each student record also holds a date of birth, home address, parent and emergency contacts, demographics, and allergy or medical notes, and all staff accounts can see them. A record can also carry social media links and one face photo, which the browser shrinks to a small square before upload and the app stores in the database; photos are served only to signed-in staff. Social Security numbers are deliberately not stored, and the CSV import skips any such column.

## Deploy on GoDaddy Node.js Hosting

1. Create a Node.js app in GoDaddy and connect this repository (or upload a zip of it without `node_modules`).
2. Add the managed MySQL database to the app. GoDaddy supplies `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` and `DB_PASSWORD`; the app reads them and creates its tables on first start.
3. Add two environment variables for the first admin account:
   - `ADMIN_EMAIL`: the email you will sign in with
   - `ADMIN_PASSWORD`: a temporary password of at least 10 characters
4. Preview, then publish. Sign in with those details; you are asked to set your own password straight away.
5. Once you can sign in, remove `ADMIN_PASSWORD` from the environment variables. It is only read when no accounts exist.

Preview and published versions share one database, so anything entered in a preview is real data.

## Accounts

- **Admin**: everything staff can do, plus adding staff accounts, resetting passwords, deactivating accounts and deleting student records.
- **Staff**: add and edit students, internships and check-ins.

An admin adds each person under "Staff accounts" with a temporary password and passes it on directly. The person replaces it at first sign-in. Sign-ins last 12 hours. Eight wrong passwords in a row lock that email for 15 minutes.

## Run locally

Needs Node.js 22 and a MySQL database.

```
npm install
DB_HOST=127.0.0.1 DB_PORT=3306 DB_NAME=odf DB_USER=odf DB_PASSWORD=... \
ADMIN_EMAIL=you@example.org ADMIN_PASSWORD=temporary-pass npm start
```

## Layout

- `server.js`: the API, sign-in and database schema
- `public/`: the pages staff use (`index.html`, `app.js`, `app.css`)

Student records are personal information about young people. Keep the repository private, never commit a `.env` file, and give accounts only to staff who need them.
