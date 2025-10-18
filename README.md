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


6) In the Spreadsheet go to Extensions → Apps Script, paste the Apps Script code below and save.

    <!-- ===================================================================
                            GOOGLE APPS SCRIPT (BACKEND)
      Paste the following code into the script editor for your Google Sheet (Extensions → Apps Script)
      Then deploy as Web App (execute as: Me; who has access: Anyone with link OR Only you / your org)
  
      IMPORTANT: Update SHEET names to match the sheet you create (roster, schedule, attendance, people)
  
      File: apps_script.gs
  =================================================================== -->
  
  <script type="text/plain" id="apps_script">// ---------- Apps Script code (server side) ----------
  // Paste this into Apps Script editor and save as Code.gs
  
  const SHEET_NAME_ROSTER = 'roster';
  const SHEET_NAME_SCHEDULE = 'schedule';
  const SHEET_NAME_ATTEND = 'attendance';
  const SHEET_NAME_PEOPLE = 'people';
  
  function doGet(e){
    // simple router for GET actions
    try{
      const action = e.parameter.action;
      if (!action) return ContentService.createTextOutput(JSON.stringify({ok:false,error:'no action'})).setMimeType(ContentService.MimeType.JSON);
      if (action === 'getScheduleForDay') return jsonOk(getScheduleForToday());
      if (action === 'listPeople') return jsonOk(listPeople());
      if (action === 'listClasses') return jsonOk(listClasses());
      return jsonOk({});
    }catch(err){ return jsonErr(err.message);} 
  }
  
  function doPost(e){
    try{
      const action = e.parameter.action || JSON.parse(e.postData.contents).action || null;
      const payload = e.postData ? JSON.parse(e.postData.contents) : {};
      if (!action) return jsonErr('no action');
      if (action === 'login') return jsonOk(login(payload));
      if (action === 'checkin') return jsonOk(checkin(payload));
      if (action === 'downloadReport') return jsonOk(downloadReport(payload));
      if (action === 'getMyAttendance') return jsonOk(getMyAttendance(payload));
      return jsonErr('unknown action');
    }catch(err){ return jsonErr(err.message);} 
  }
  
  // helpers
  function jsonOk(data){ return ContentService.createTextOutput(JSON.stringify({ok:true,data:data})).setMimeType(ContentService.MimeType.JSON); }
  function jsonErr(msg){ return ContentService.createTextOutput(JSON.stringify({ok:false,error:msg})).setMimeType(ContentService.MimeType.JSON); }
  
  function getSpreadsheet(){ return SpreadsheetApp.getActiveSpreadsheet(); }
  
  function login(payload){
    const ss = getSpreadsheet();
    const roster = ss.getSheetByName(SHEET_NAME_ROSTER);
    const people = ss.getSheetByName(SHEET_NAME_PEOPLE);
    const role = payload.role; const id = payload.id; const pass = payload.pass;
    // search roster for students
    if (role === 'student'){
      const vals = roster.getDataRange().getValues(); // header: id,name,passcode
      for (let i=1;i<vals.length;i++){
        if (String(vals[i][0]) === String(id) && String(vals[i][2]) === String(pass)){
          return {user:{id:vals[i][0],name:vals[i][1],role:'student'}};
        }
      }
      return {error:'invalid student credentials'};
    }
    // officers / professors / admin
    const pvals = people.getDataRange().getValues(); // header: id,name,role,passcode,discord
    for (let i=1;i<pvals.length;i++){
      if (String(pvals[i][0]) === String(id) && String(pvals[i][3]) === String(pass)){
        return {user:{id:pvals[i][0],name:pvals[i][1],role:pvals[i][2],discord:pvals[i][4]}};
      }
    }
    return {error:'invalid credentials'};
  }
  
  function getScheduleForToday(){
    // schedule sheet columns: classId,subject,dayOfWeek,startTime,endTime
    const ss = getSpreadsheet();
    const sh = ss.getSheetByName(SHEET_NAME_SCHEDULE);
    const vals = sh.getDataRange().getValues();
    const dow = new Date().getDay(); // 0 Sun, 1 Mon...
    // The user's "section" schedule is assumed to be all entries on the schedule sheet
    const res = [];
    for (let i=1;i<vals.length;i++){
      const row = vals[i];
      const rowDow = parseInt(row[2]);
      if (rowDow === dow){ res.push({classId:row[0],subject:row[1],dayOfWeek:row[2],startTime:row[3],endTime:row[4]}); }
    }
    return res;
  }
  
  function listPeople(){
    const ss = getSpreadsheet();
    const sh = ss.getSheetByName(SHEET_NAME_PEOPLE);
    const vals = sh.getDataRange().getValues();
    const out=[];
    for (let i=1;i<vals.length;i++) out.push({id:vals[i][0],name:vals[i][1],role:vals[i][2],discord:vals[i][4]});
    return out;
  }
  
  function listClasses(){
    const ss = getSpreadsheet();
    const sh = ss.getSheetByName(SHEET_NAME_SCHEDULE];
  }
  
  function listClasses(){
    const ss = getSpreadsheet();
    const sh = ss.getSheetByName(SHEET_NAME_SCHEDULE);
    const vals = sh.getDataRange().getValues();
    const out=[];
    for (let i=1;i<vals.length;i++) out.push({classId:vals[i][0],subject:vals[i][1]});
    return out;
  }
  
  function checkin(payload){
    const ss = getSpreadsheet();
    const sh = ss.getSheetByName(SHEET_NAME_SCHEDULE);
    const as = ss.getSheetByName(SHEET_NAME_ATTEND);
    const classId = payload.classId; const userId=payload.userId;
    // find class start time
    const vals = sh.getDataRange().getValues();
    let found = null;
    for (let i=1;i<vals.length;i++) if (String(vals[i][0])===String(classId)) { found=vals[i]; break; }
    if (!found) return {error:'class not found'};
    const startTime = found[3]; // "HH:MM"
    const date = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const now = new Date();
    const parts = startTime.split(':');
    const st = new Date(); st.setHours(parseInt(parts[0]),parseInt(parts[1]),0,0);
    const openWindow = new Date(st.getTime() - 10*60000);
    const lateThreshold = new Date(st.getTime() + 5*60000);
    const absentThreshold = new Date(st.getTime() + 10*60000);
    if (now < openWindow) return {error:'check-in not open yet'};
    if (now >= absentThreshold) return {error:'check-in closed (marked absent)'};
    const status = now <= lateThreshold ? 'Present' : 'Late';
    // record attendance: date,time,classId,userId,status
    as.appendRow([date,Utilities.formatDate(now, Session.getScriptTimeZone(), 'HH:mm:ss'),classId,userId,status]);
    return {status};
  }
  
  function downloadReport(payload){
    // simple CSV generator. payload: date, classId, type, userId
    const date = payload.date;
    const classId = payload.classId;
    const type = payload.type;
    const ss = getSpreadsheet();
    const as = ss.getSheetByName(SHEET_NAME_ATTEND);
    const vals = as.getDataRange().getValues();
    const rows = [ ['date','time','classId','userId','status'] ];
    for (let i=1;i<vals.length;i++){
      const r = vals[i];
      if (date && date !== '' && r[0] !== date) continue;
      if (classId && classId !== 'all' && r[2] !== classId) continue;
      rows.push([r[0],r[1],r[2],r[3],r[4]]);
    }
    // convert to CSV
    const csv = rows.map(r=>r.map(c=> '"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n');
    return {csv};
  }
  
  function getMyAttendance(payload){
    const userId = payload.userId;
    const ss = getSpreadsheet();
    const as = ss.getSheetByName(SHEET_NAME_ATTEND);
    const vals = as.getDataRange().getValues();
    const out = [];
    for (let i=1;i<vals.length;i++) if (String(vals[i][3]) === String(userId)) out.push({date:vals[i][0],time:vals[i][1],classId:vals[i][2],status:vals[i][4]});
    return out;
  }
  
  // end of apps script
  </script>


8) Deploy the Apps Script as a Web App: Publish → Deploy as web app (or Deploy -> New deployment)
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
