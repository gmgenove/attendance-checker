const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { DateTime } = require('luxon'); // Better timezone handling
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const TIMEZONE = "Asia/Manila";

// --- HELPERS ---
const getManilaNow = () => DateTime.now().setZone(TIMEZONE);

// Simple GET route for UptimeRobot
app.get('/ping', (req, res) => res.send('System Awake'));

// 3. Simple Router for all other actions
app.post('/api', async (req, res) => {
  const { action, ...payload } = req.body;

  try {
	// --- ROUTES ---
    switch (action) {
      // --- SIGN IN (Hybrid SHA256/Bcrypt) ---
      case 'signin': {
        const { id, password, role } = payload;
        const result = await pool.query('SELECT * FROM sys_users WHERE user_id = $1 AND user_role = $2', [id, role]);
        
        if (result.rows.length === 0) return res.status(404).json({ ok: false, error: 'User not found' });
        const user = result.rows[0];

        let isValid = false;
        // Check if hash is bcrypt ($2b$...) or old SHA-256
        if (user.password_hash.startsWith('$2b$')) {
          isValid = await bcrypt.compare(password, user.password_hash);
        } else {
          const sha256Hash = crypto.createHash('sha256').update(password).digest('hex');
          if (sha256Hash === user.password_hash) {
            isValid = true;
            // Upgrade to bcrypt on the fly
            const newHash = await bcrypt.hash(password, 10);
            await pool.query('UPDATE sys_users SET password_hash = $1 WHERE user_id = $2', [newHash, id]);
          }
        }

        if (!isValid) return res.status(401).json({ ok: false, error: 'Invalid credentials' });
        return res.json({ ok: true, user: { id: user.user_id, name: user.user_name, role: user.user_role } });
      }

      // --- SIGN UP ---
      case 'signup': {
        const { id, password, role } = payload;
        // Verify user exists in roster first (same as your GAS logic)
        const check = await pool.query('SELECT * FROM sys_users WHERE user_id = $1 AND user_role = $2', [id, role]);
        if (check.rows.length === 0) return res.json({ ok: false, error: 'ID not found in roster' });
        if (check.rows[0].password_hash) return res.json({ ok: false, error: 'Account already exists' });

        const hash = await bcrypt.hash(password, 10);
        await pool.query('UPDATE sys_users SET password_hash = $1 WHERE user_id = $2', [hash, id]);
        return res.json({ ok: true, message: 'Signup successful' });
      }

	  // 1. Get Today's Schedule
	  case 'today_schedule': {
		  try {
			const now = getManilaNow();
			const dayName = now.toFormat('ccc'); // Mon, Tue, etc.
		
			const query = `
			  SELECT s.*, u.user_name as professor_name 
			  FROM schedules s
			  LEFT JOIN sys_users u ON s.professor_id = u.user_id
			  WHERE $1 = ANY(s.days)
			`;
			const result = await pool.query(query, [dayName]);
			
			// Format times for frontend
			const schedule = result.rows.map(row => ({
			  ...row,
			  start_time: row.start_time.slice(0, 5), // HH:mm
			  end_time: row.end_time.slice(0, 5)
			}));
		
			return res.json({ ok: true, schedule });
		  } catch (err) {
			return res.json({ ok: false, error: err.message });
		  }
	  }
		
	  // 2. Check-in Logic
	  case 'checkin': {
		  const { class_code, student_id } = req.body;
		  const now = getManilaNow();
		  const dateStr = now.toISODate();
		
		  try {
			// A. Check for existing attendance (Duplicate Prevention)
			const existing = await pool.query(
			  'SELECT attendance_status FROM attendance WHERE class_date = $1 AND class_code = $2 AND student_id = $3',
			  [dateStr, class_code, student_id]
			);
		
			if (existing.rows.length > 0) {
			  return res.json({ ok: true, status: existing.rows[0].attendance_status, message: 'Already checked in' });
			}
		
			// B. Get Class Start Time
			const schedResult = await pool.query('SELECT start_time FROM schedules WHERE class_code = $1', [class_code]);
			if (schedResult.rows.length === 0) throw new Error('Class not found');
			
			const [hh, mm] = schedResult.rows[0].start_time.split(':');
			const classStart = now.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
		
			// C. Window Logic (Using your 10/10/20 window logic)
			const diffMins = now.diff(classStart, 'minutes').minutes;
		
			// Hardcoded config (or fetch from a 'config' table)
			const checkinOpen = -10; // Opens 10 mins before
			const lateThreshold = 5; // Late after 5 mins
			const absentThreshold = 10; // Absent after 10 mins
		
			if (diffMins < checkinOpen) return res.json({ ok: false, error: 'Check-in not open yet' });
			if (diffMins > absentThreshold) return res.json({ ok: false, error: 'Check-in closed (Absent)' });
		
			let status = 'PRESENT';
			if (diffMins > lateThreshold) status = 'LATE';
		
			// D. Save to Postgres
			await pool.query(
			  'INSERT INTO attendance (class_date, class_code, student_id, attendance_status, time_in) VALUES ($1, $2, $3, $4, $5)',
			  [dateStr, class_code, student_id, status, now.toFormat('HH:mm:ss')]
			);
		
			return res.json({ ok: true, status, timestamp: now.toFormat('HH:mm:ss') });
		  } catch (err) {
			return res.json({ ok: false, error: err.message });
		  }
	  }

      // --- GET ATTENDANCE (For UI status check) ---
      case 'get_attendance': {
        const { class_code, student_id } = payload;
        const date = DateTime.now().setZone(TIMEZONE).toISODate();
        const result = await pool.query(
          'SELECT attendance_status, time_in FROM attendance WHERE class_date = $1 AND class_code = $2 AND student_id = $3',
          [date, class_code, student_id]
        );
        return res.json({ ok: true, record: result.rows[0] || { status: 'not_recorded' } });
      }

      // --- DROPDOWNS (For Officer Reports) ---
      case 'get_dropdowns': {
        const classes = await pool.query('SELECT class_code as code, class_name as name FROM schedules');
        const students = await pool.query('SELECT user_id, user_name FROM sys_users WHERE user_role = \'student\'');
        return res.json({ ok: true, classes: classes.rows, students: students.rows });
      }

      // --- CONFIG ---
      case 'getConfig': {
        // You can store these in a 'config' table, but hardcoding here matches your GAS setup
        return res.json({
          ok: true,
          config: {
            checkin_window_minutes: 10,
            late_window_minutes: 5,
            absent_window_minutes: 10,
            adjustment_end: '2026-12-31' 
          }
        });
      }

	  case 'report': {
		  const { type, class_code, student_id } = payload;
		  let rows = [];
		  let title = "";
		  let filename = "";
		
		  if (type === 'class') {
		    const res = await pool.query(
		      `SELECT a.class_date, a.student_id, u.user_name, a.attendance_status, a.time_in 
		       FROM attendance a 
		       JOIN sys_users u ON a.student_id = u.user_id 
		       WHERE a.class_code = $1 ORDER BY a.class_date DESC, u.user_name ASC`,
		      [class_code]
		    );
		    rows = res.rows;
		    title = `Class Attendance Report: ${class_code}`;
		    filename = `Report_Class_${class_code}.pdf`;
		  } else {
		    const res = await pool.query(
		      `SELECT a.class_date, a.class_code, s.class_name, a.attendance_status, a.time_in 
		       FROM attendance a 
		       JOIN schedules s ON a.class_code = s.class_code 
		       WHERE a.student_id = $1 ORDER BY a.class_date DESC`,
		      [student_id]
		    );
		    rows = res.rows;
		    const userRes = await pool.query('SELECT user_name FROM sys_users WHERE user_id = $1', [student_id]);
		    title = `Student Attendance Report: ${userRes.rows[0]?.name || student_id}`;
		    filename = `Report_Student_${student_id}.pdf`;
		  }
		
		  // --- Generate PDF using pdf-lib ---
		  const pdfDoc = await PDFDocument.create();
		  let page = pdfDoc.addPage([600, 800]);
		  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
		  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
		
		  page.drawText(title, { x: 50, y: 750, size: 18, font: boldFont });
		  page.drawText(`Generated on: ${getManilaNow().toFormat('f')}`, { x: 50, y: 730, size: 10, font });
		
		  let y = 700;
		  // Header Row
		  page.drawText('Date', { x: 50, y, size: 10, font: boldFont });
		  page.drawText(type === 'class' ? 'Student' : 'Class', { x: 150, y, size: 10, font: boldFont });
		  page.drawText('Status', { x: 400, y, size: 10, font: boldFont });
		  page.drawText('Time', { x: 500, y, size: 10, font: boldFont });
		
		  y -= 20;
		
		  // Data Rows
		  rows.forEach((row) => {
		    if (y < 50) { // Add new page if space is low
		      page = pdfDoc.addPage([600, 800]);
		      y = 750;
		    }
		    const dateStr = DateTime.fromJSDate(row.date).toISODate();
		    const secondCol = type === 'class' ? row.name : row.class_name;
		    
		    page.drawText(dateStr, { x: 50, y, size: 9, font });
		    page.drawText(String(secondCol).substring(0, 30), { x: 150, y, size: 9, font });
		    page.drawText(row.status, { x: 400, y, size: 9, font });
		    page.drawText(row.time_in || '--', { x: 500, y, size: 9, font });
		    y -= 15;
		  });
		
		  const pdfBytes = await pdfDoc.save();
		  const pdfBase64 = Buffer.from(pdfBytes).toString('base64');
		
		  return res.json({ ok: true, pdfMain: pdfBase64, filename });
	  }

	  case 'check_holiday': {
	    const today = getManilaNow().toISODate();
	    const result = await pool.query('SELECT holiday_name, holiday_type FROM holidays WHERE holiday_date = $1', [today]);
	    
	    if (result.rows.length > 0) {
	        return res.json({ 
	            ok: true, 
	            isHoliday: true, 
	            holidayName: result.rows[0].holiday_name, 
	            holidayType: result.rows[0].holiday_type 
	        });
	    }
	    return res.json({ ok: true, isHoliday: false });
	  }

	  case 'health_check': {
		  try {
		    // Perform a simple query to verify DB connection
		    const result = await pool.query('SELECT NOW() as server_time');
		    return res.json({
		      ok: true,
		      status: "Healthy",
		      db_time: result.rows[0].server_time,
		      uptime: process.uptime().toFixed(2) + " seconds"
		    });
		  } catch (err) {
		    return res.status(500).json({ 
		      ok: false, 
		      status: "Database Connection Error", 
		      error: err.message 
		    });
		  }
	  }

      default:
        return res.status(400).json({ ok: false, error: `Action ${action} not implemented` });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error: ' + err.message });
  }
});

const initDb = async () => {
  const queryText = `
    CREATE TABLE IF NOT EXISTS sys_users (
      user_id TEXT PRIMARY KEY, 
      user_name TEXT, 
      user_role TEXT, 
      password_hash TEXT
    );
    
    CREATE TABLE IF NOT EXISTS schedules (
      class_code TEXT PRIMARY KEY, 
      class_name TEXT, 
      days TEXT[], 
      start_time TIME, 
      end_time TIME, 
      professor_id TEXT
    );
    
    CREATE TABLE IF NOT EXISTS attendance (
      class_date DATE, 
      class_code TEXT REFERENCES schedules(class_code), 
      student_id TEXT REFERENCES sys_users(user_id), 
      attendance_status TEXT, 
      time_in TIME, 
      professor_id TEXT REFERENCES professors(professor_id),
      reason TEXT,
      constraint pk_attendance_data primary key (class_date, class_code, student_id)
    );
        
    CREATE TABLE IF NOT EXISTS roster (
      student_id TEXT PRIMARY KEY, 
      student_name TEXT
    );
        
    CREATE TABLE IF NOT EXISTS professors (
      professor_id TEXT PRIMARY KEY, 
      professor_name TEXT
    );
        
    CREATE TABLE IF NOT EXISTS config (
      config_key TEXT PRIMARY KEY, 
      config_value TEXT,
      description TEXT
    );
        
    CREATE TABLE IF NOT EXISTS holidays (
      holiday_date DATE PRIMARY KEY,
      holiday_name TEXT,
      holiday_type TEXT
    );
    
    INSERT INTO config (config_key, config_value, description) VALUES ('sem1_start', '2025-09-01', 'Start date of 1st semester') ON CONFLICT DO NOTHING;
    INSERT INTO config (config_key, config_value, description) VALUES ('sem1_end', '2026-01-17', 'End date of 1st semester') ON CONFLICT DO NOTHING;
    INSERT INTO config (config_key, config_value, description) VALUES ('sem1_adjustment_start', '2025-09-01', 'Adjustment period start (Sem 1)') ON CONFLICT DO NOTHING;
    INSERT INTO config (config_key, config_value, description) VALUES ('sem1_adjustment_end', '2025-11-30', 'Adjustment period end (Sem 1)') ON CONFLICT DO NOTHING;
    INSERT INTO config (config_key, config_value, description) VALUES ('sem2_start', '2026-02-09', 'Start date of 2nd semester') ON CONFLICT DO NOTHING;
    INSERT INTO config (config_key, config_value, description) VALUES ('sem2_end', '2026-06-21', 'End date of 2nd semester') ON CONFLICT DO NOTHING;
    INSERT INTO config (config_key, config_value, description) VALUES ('sem2_adjustment_start', '2026-02-09', 'Adjustment period start (Sem 2)') ON CONFLICT DO NOTHING;
    INSERT INTO config (config_key, config_value, description) VALUES ('sem2_adjustment_end', '2026-03-06', 'Adjustment period end (Sem 2)') ON CONFLICT DO NOTHING;
    INSERT INTO config (config_key, config_value, description) VALUES ('checkin_window_minutes', '10', 'Minutes before class check-in opens') ON CONFLICT DO NOTHING;
    INSERT INTO config (config_key, config_value, description) VALUES ('late_window_minutes', '5', 'Minutes after class start considered “late”') ON CONFLICT DO NOTHING;
    INSERT INTO config (config_key, config_value, description) VALUES ('absent_window_minutes', '20', 'Minutes after class start considered “absent”') ON CONFLICT DO NOTHING;
    INSERT INTO config (config_key, config_value, description) VALUES ('current_sem', 'auto', 'Use “auto” for automatic semester detection') ON CONFLICT DO NOTHING;
    INSERT INTO config (config_key, config_value, description) VALUES ('checkout_window_minutes', '10', 'Minutes before end of class, check-out opens') ON CONFLICT DO NOTHING;
        
    INSERT INTO holidays (holiday_date, holiday_name, holiday_type) VALUES ('2026-01-01', 'New Years Day', 'Regular Holiday') ON CONFLICT DO NOTHING;
    INSERT INTO holidays (holiday_date, holiday_name, holiday_type) VALUES ('2026-04-02', 'Maundy Thursday', 'Regular Holiday') ON CONFLICT DO NOTHING;
    INSERT INTO holidays (holiday_date, holiday_name, holiday_type) VALUES ('2026-04-03', 'Good Friday', 'Regular Holiday') ON CONFLICT DO NOTHING;
    INSERT INTO holidays (holiday_date, holiday_name, holiday_type) VALUES ('2026-04-09', 'Araw ng Kagitingan', 'Regular Holiday') ON CONFLICT DO NOTHING;
    INSERT INTO holidays (holiday_date, holiday_name, holiday_type) VALUES ('2026-05-01', 'Labor Day', 'Regular Holiday') ON CONFLICT DO NOTHING;
    INSERT INTO holidays (holiday_date, holiday_name, holiday_type) VALUES ('2026-06-12', 'Independence Day', 'Regular Holiday') ON CONFLICT DO NOTHING;
    INSERT INTO holidays (holiday_date, holiday_name, holiday_type) VALUES ('2026-08-31', 'National Heroes Day', 'Regular Holiday') ON CONFLICT DO NOTHING;
    INSERT INTO holidays (holiday_date, holiday_name, holiday_type) VALUES ('2026-11-30', 'Bonifacio Day', 'Regular Holiday') ON CONFLICT DO NOTHING;
    INSERT INTO holidays (holiday_date, holiday_name, holiday_type) VALUES ('2026-12-25', 'Christmas Day', 'Regular Holiday') ON CONFLICT DO NOTHING;
    INSERT INTO holidays (holiday_date, holiday_name, holiday_type) VALUES ('2026-12-30', 'Rizal Day', 'Regular Holiday') ON CONFLICT DO NOTHING;
    INSERT INTO holidays (holiday_date, holiday_name, holiday_type) VALUES ('2026-08-21', 'Ninoy Aquino Day', 'Special Non-Working Holiday') ON CONFLICT DO NOTHING;
    INSERT INTO holidays (holiday_date, holiday_name, holiday_type) VALUES ('2026-11-01', 'All Saints Day', 'Special Non-Working Holiday') ON CONFLICT DO NOTHING;
    INSERT INTO holidays (holiday_date, holiday_name, holiday_type) VALUES ('2026-12-08', 'Feast of the Immaculate Conception of Mary', 'Special Non-Working Holiday') ON CONFLICT DO NOTHING;
    INSERT INTO holidays (holiday_date, holiday_name, holiday_type) VALUES ('2026-12-31', 'Last Day of the Year', 'Special Non-Working Holiday') ON CONFLICT DO NOTHING;
    INSERT INTO holidays (holiday_date, holiday_name, holiday_type) VALUES ('2026-02-17', 'Chinese New Year', 'Special Non-Working Holiday') ON CONFLICT DO NOTHING;
    INSERT INTO holidays (holiday_date, holiday_name, holiday_type) VALUES ('2026-04-04', 'Black Saturday', 'Special Non-Working Holiday') ON CONFLICT DO NOTHING;
    INSERT INTO holidays (holiday_date, holiday_name, holiday_type) VALUES ('2026-11-02', 'All Souls Day', 'Special Non-Working Holiday') ON CONFLICT DO NOTHING;
    INSERT INTO holidays (holiday_date, holiday_name, holiday_type) VALUES ('2026-12-24', 'Christmas Eve', 'Special Non-Working Holiday') ON CONFLICT DO NOTHING;
  `;
  try {
    await pool.query(queryText);
    console.log("✅ Database tables initialized successfully");
  } catch (err) {
    console.error("❌ Error initializing database:", err);
  }
};
initDb();	// Call the migration script

const autoTagAbsentees = async () => {
  console.log("Running auto-tag absentee check...");
  try {
    const now = getManilaNow();
    const dayName = now.toFormat('ccc');
    const dateStr = now.toISODate();

    // 1. Find classes that ended more than 10 mins ago today
    const schedules = await pool.query(
      "SELECT * FROM schedules WHERE $1 = ANY(days)", 
      [dayName]
    );

    for (const sched of schedules.rows) {
      const [hh, mm] = sched.start_time.split(':');
      const classStart = now.set({ hour: hh, minute: mm, second: 0 });
      const diffMins = now.diff(classStart, 'minutes').minutes;

      // If it's 11+ minutes past start time, mark missing students as ABSENT
      if (diffMins > 10) {
        await pool.query(`
          INSERT INTO attendance (class_date, class_code, student_id, attendance_status, time_in)
          SELECT $1, $2, u.user_id, 'ABSENT', '00:00:00'
          FROM sys_users u
          WHERE u.user_role = 'student'
          AND NOT EXISTS (
            SELECT 1 FROM attendance a 
            WHERE a.class_date = $1 AND a.class_code = $2 AND a.student_id = u.user_id
          )
        `, [dateStr, sched.class_code]);
      }
    }
  } catch (err) {
    console.error("Auto-tag error:", err);
  }
};

// Run check every 30 minutes
setInterval(autoTagAbsentees, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
