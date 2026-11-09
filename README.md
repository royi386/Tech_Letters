# Technical Section · Letter Monitoring — Electric Loco Shed, Erode

A three-page portal for tracking letters that come to the Technical Section from the tech
sections, through drafting and signature, until they are dispatched.

- **`index.html` — status board.** Read-only view of where every letter is right now.
- **`admin.html` — admin console.** The register: enter letters, move them, dispatch them.
- **`management.html` — Management.** Maintains the list of sections and administrator-managed user accounts.

The admin console and the Management page use server-side username/password authentication and a
server-verified captcha. Letter records, settings, and account data are stored in SQLite. No npm
packages or internet connection are required; use Node.js 24 or newer.

## Running it

Double-clicking `index.html` usually works, but browsers treat local files inconsistently.
The reliable way is the bundled server:

```bash
node serve.js
```

Then open <http://127.0.0.1:5173>. The admin console is at `/admin.html` and section management
at `/management.html`.

The initial Main admin login is username `roy`, password `asdfasdf`. Change this password
immediately after signing in from Management → Administrator accounts. Both protected pages show
a sign-in form; account creation is only available to the Main admin.

For other computers, set `HOST=0.0.0.0` and `COOKIE_SECURE=1`, then place the server behind a
trusted HTTPS reverse proxy. Do not send passwords over plain HTTP on a shared network.

## Signing in

Usernames are indexed by a keyed HMAC and stored encrypted for display; they are not stored as
plain text in SQLite. Passwords use salted PBKDF2 hashes. Sessions are held server-side and use an
HttpOnly cookie. The Main admin can create additional administrator accounts and manage their
usernames/passwords from Management. Other administrators can manage letters, sections, and portal
settings, but cannot create or manage accounts.

## Sections

The portal ships with the Technical Section's sections:

Tech 1 - General · Tech 2 - Amrith Bharath · Tech 4 - Inspection Reports · Tech 6 - Failure
reports · Tech 7 - Audit · Tech 8 - Warranty · Tech 10A - E3TM · Tech 10B - E3AUX ·
Tech 10C - E4A & E4B · Tech 10D - E5A · Tech 10E - E5B1 & E5B2 · Tech 11 - Mechanical ·
Tech 12 - Pneumatic · Tech 13 - Safety Audit · Tech 14 - PCDO · Tech 18 - MIP · Tech 19 - MSG ·
Tech 27 - FAM · Tech 31 - CLW BLW PLW · Tech 33 - Other Shed Attention · Tech 35 - POH & MTR ·
Tech 36 - MW & FAB · Tech 37 - Training · Tech 38 - FRPCPY · Tech 40 - MCDO · Tech 41 - SIV ·
Tech 43 - 3 Phase Locos · Tech 44 - MOM · Tech 45 - PPIO · Tech 46 - Maintenance Instruction ·
Tech 47 - Material & Stores · Tech 48 - KAVACH · Tech 49 - CMT Lab

**Management** lists them with a count of letters in each, allows adding a new section, and
removing one (with a confirmation that names any letters already recorded under it). Administrators
also use this page to manage user and administrator accounts. Removing a
section only takes it out of the pickers for future entries — existing letters keep the name and
stay in the register, and the board filters still offer every section that appears in a record.

## How a letter moves

| Stage | Shown on the board as | Next action in the console |
| --- | --- | --- |
| Received from a section | Received from sections | **Start draft preparation** |
| Draft being prepared | Draft preparation | **Submit to officer** |
| Submitted to ADEE-1 / ADEE-2 / DEE / Sr.DEE | Submitted for signature (officer named) | **Record signature**, or **Return for revision** |
| Signed by the officer | Signed — to dispatch | **Record dispatch** |
| Sent by E-Office / Email / Telegram / Post | Dispatched · last 48 hrs | — |

- **Return for revision** sends the draft back to Draft preparation and records the officer's
  observation in the letter's movement history.
- **Record dispatch** asks for the route, the date and time, and an optional dispatch reference.
- **48-hour rule:** a dispatched letter leaves the status board exactly 48 hours after the
  dispatch date and time entered. It is not deleted — the admin console keeps it, and ticking
  **Show archive (over 48 hrs)** shows it there. **Reopen (undo dispatch)** corrects a mistake.

Every action is appended to the letter's movement history with the date, time and the
"Recorded by" name from Settings.

## Settings and backup

Settings covers the shed and section names, the "Recorded by" name, the letter reference prefix,
the officers, the dispatch routes, the number of days after which a pending letter is marked
delayed, and a backup panel.

## Where the data lives — read this before real use

Records, settings, account hashes, and sessions are stored in `data/portal.sqlite`. The generated
`data/app.key` encrypts usernames and keys their HMAC lookup values; keep it private and back it up
with the database. If the key is lost, encrypted usernames cannot be recovered. The server must be
running for sign-in and database-backed changes.

Use **Settings → Download backup** regularly. **Restore backup** replaces database letters and
settings with the file's contents; sign-in credentials are not included. The register can also be
exported as CSV.

## Files

```
index.html          status board
admin.html          admin console
management.html     section list maintenance
assets/styles.css   styles and print layout
assets/app.js       store, workflow, views, sign-in, captcha, backup
serve.js            SQLite API and static server
data/portal.sqlite  database (generated on first run)
data/app.key        encryption/HMAC key (generated on first run; keep private)
```
