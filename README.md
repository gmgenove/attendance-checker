# attendance-checker
SETUP
1) Create a new Google Spreadsheet
- Make four sheets (tabs) named exactly: roster, schedule, attendance, people


2) Populate roster sheet columns (header row): id | name | passcode
Example rows:
20201001 | Juan Dela Cruz | pass123


3) Populate people sheet columns: id | name | role | passcode | discord
Example:
prof01 | Prof Arce | professor | profpass | profdiscord#1234
officer1 | Alice | officer | officerpass | alice#4567


4) Populate schedule sheet columns: classId | subject | dayOfWeek | startTime | endTime
- dayOfWeek: numeric 0=Sun,1=Mon,...6=Sat
- startTime/endTime as HH:MM in 24h format
Example:
CS101A | Programming 1 | 2 | 08:00 | 09:30


5) attendance sheet columns: date | time | classId | userId | status
(Apps Script will append rows automatically)


6) In the Spreadsheet go to Extensions → Apps Script, paste the Apps Script code from above (the apps_script block), save.


7) Deploy the Apps Script as a Web App: Publish → Deploy as web app (or Deploy -> New deployment)
- Set "Execute as" to: Me (so the script can read and write the sheet)
- Set "Who has access" to: Anyone (or Anyone with link) OR restrict to your domain if using Workspace.
- Copy the Web App URL and paste into the front-end constant GAS_BASE in index.html.


8) Host the front-end index.html on GitHub Pages or any static host (Netlify, Vercel, GitHub Pages). Replace GAS_BASE with the deployed URL.


9) Notes on roles & permissions:
- Students: defined in roster. They can only check themselves in (checkin function uses userId provided by logged-in user and records that user).
- Professors & Officers: defined in people sheet with a role field. Professors can download reports using the Generate button.
- Admin: add a person with role 'admin' in people sheet to have full access.


10) Improvements & security:
- Use Google Sign-In or deploy the Apps Script as "Only people in your org" for better auth.
- Add server-side validation that the POSTing origin is your site (via referer) or include an API key.
- Add uniqueness check to prevent multiple checkins in same class and to record geolocation if needed.
