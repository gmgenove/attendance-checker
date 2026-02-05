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

	  case 'checkout': {
		const { class_code, student_id } = payload;
		const now = getManilaNow();
		const dateStr = now.toISODate();
		const timeStr = now.toFormat('HH:mm:ss');
		
		// Updated columns: class_date instead of date, attendance_status instead of status
		const check = await pool.query(
			"SELECT attendance_status FROM attendance WHERE class_date = $1 AND class_code = $2 AND student_id = $3",
			[dateStr, class_code, student_id]
		);
		
		if (check.rows.length === 0) return res.json({ ok: false, error: "You must check in before checking out." });
		
		await pool.query(
			"UPDATE attendance SET time_out = $1 WHERE class_date = $2 AND class_code = $3 AND student_id = $4",
			[timeStr, dateStr, class_code, student_id]
		);
		
		return res.json({ ok: true, time_out: timeStr });
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

	  case 'prof_dashboard': {
			const { class_code } = payload;
			const date = getManilaNow().toISODate();
			
			// 1. Get counts for the header cards
			const stats = await pool.query(`
				SELECT attendance_status, COUNT(*) as count 
				FROM attendance 
				WHERE class_code = $1 AND class_date = $2
				GROUP BY attendance_status
			`, [class_code, date]);
			
			// 2. Get the ENTIRE roster with their current status for this class/date
		    const roster = await pool.query(`
			    SELECT 
					u.user_id, 
			        u.user_name, 
			        a.time_in, 
			        COALESCE(a.attendance_status, 'NOT YET ARRIVED') as status
			    FROM sys_users u
			    LEFT JOIN attendance a ON u.user_id = a.student_id AND a.class_code = $1 AND a.class_date = $2
			    WHERE u.user_role = 'student'
			    ORDER BY 
			        CASE WHEN a.attendance_status IS NULL THEN 1 ELSE 0 END,
			        a.time_in DESC, 
			        u.user_name ASC
			`, [class_code, date]);
			
			return res.json({ 
				ok: true, 
				stats: stats.rows, 
				roster: roster.rows 
			});
	  }

	  case 'prof_summary': {
	    const { class_code } = payload;
		const summary = await pool.query(`
		    SELECT  
		        u.user_name,
		        COUNT(CASE WHEN a.attendance_status = 'PRESENT' THEN 1 END) as present_count,
		        COUNT(CASE WHEN a.attendance_status = 'LATE' THEN 1 END) as late_count,
		        COUNT(CASE WHEN a.attendance_status = 'ABSENT' THEN 1 END) as absent_count,
		        COUNT(CASE WHEN a.attendance_status = 'INCOMPLETE' THEN 1 END) as incomplete_count
		    FROM sys_users u
		    LEFT JOIN attendance a ON u.user_id = a.student_id AND a.class_code = $1
		    WHERE u.user_role = 'student'
		    GROUP BY u.user_id, u.user_name
		    ORDER BY u.user_name ASC
		`, [class_code]);
	
	    return res.json({ ok: true, summary: summary.rows });
	  }

	  case 'report': {
		  const { type, class_code, student_id } = payload;
		  const pdfDoc = await PDFDocument.create();
		  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
		  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
		  let filename = "";
		
		  if (type === 'class') {
		    // 1. Fetch Class Header & Schedule Info
		    const classInfo = await pool.query(
		      `SELECT s.*, u.user_name as professor_name 
		       FROM schedules s 
		       JOIN sys_users u ON s.professor_id = u.user_id 
		       WHERE s.class_code = $1`, [class_code]
		    );
		    
		    // 2. Fetch Attendance Records (The "ClassReport" Tab)
		    const records = await pool.query(
		      `SELECT a.*, u.user_name 
		       FROM attendance a 
		       JOIN sys_users u ON a.student_id = u.user_id 
		       WHERE a.class_code = $1 ORDER BY a.class_date DESC`, [class_code]
		    );
		
		    // 3. Fetch Excuse Logs (The "ClassExcuseLog" Tab)
		    const excuses = await pool.query(
		      `SELECT a.class_date, u.student_id, u.user_name, a.reason 
		       FROM attendance a 
		       JOIN sys_users u ON a.student_id = u.user_id 
		       WHERE a.class_code = $1 AND a.reason IS NOT NULL`, [class_code]
		    );
		
		    filename = `ClassReport_${class_code}.pdf`;
		    await generateClassPDF(pdfDoc, classInfo.rows[0], records.rows, excuses.rows, font, boldFont);
		
		  } else if (type === 'person') {
		    // 1. Fetch Student Info
		    const studentInfo = await pool.query('SELECT user_name FROM sys_users WHERE user_id = $1', [student_id]);
		    
		    // 2. Fetch Student History (The "StudentReport" Tab)
		    const history = await pool.query(
		      `SELECT a.*, s.class_name, a.reason
		       FROM attendance a 
		       JOIN schedules s ON a.class_code = s.class_code 
		       WHERE a.student_id = $1 AND a.reason IS NOT NULL ORDER BY a.class_date DESC`, [student_id]
		    );
		
		    filename = `StudentReport_${student_id}.pdf`;
		    await generateStudentPDF(pdfDoc, studentInfo.rows[0], history.rows, font, boldFont);
		  }
		
		  const pdfBytes = await pdfDoc.save();
		  return res.json({ ok: true, pdfMain: Buffer.from(pdfBytes).toString('base64'), filename });
	  }

	  // --- DROPDOWNS (For Officer Reports) ---
      case 'get_dropdowns': {
        const classes = await pool.query('SELECT class_code as code, class_name as name FROM schedules');
        const students = await pool.query('SELECT user_id, user_name FROM sys_users WHERE user_role = \'student\'');
        return res.json({ ok: true, classes: classes.rows, students: students.rows });
      }

	  case 'change_password': {
		    const { user_id, current_password, new_password } = payload;
		
		    // 1. Fetch user from DB
		    const result = await pool.query("SELECT password_hash FROM sys_users WHERE user_id = $1", [user_id]);
		    if (result.rows.length === 0) return res.json({ ok: false, error: "User not found." });
		
		    const user = result.rows[0];
		
		    // 2. Verify current password
		    const isValid = await bcrypt.compare(current_password, user.password_hash);
		    if (!isValid) return res.json({ ok: false, error: "Current password is incorrect." });
		
		    // 3. Hash and save new password
		    const newHash = await bcrypt.hash(new_password, 10);
		    await pool.query("UPDATE sys_users SET password_hash = $1 WHERE user_id = $2", [newHash, user_id]);
		
		    return res.json({ ok: true, message: "Password updated successfully!" });
	  }

	  case 'reset_single_password': {
	    const { target_user_id } = payload;
	    const hashed = await bcrypt.hash("password1234", 10);
	    await pool.query("UPDATE sys_users SET password_hash = $1 WHERE user_id = $2", [hashed, target_user_id]);
	    return res.json({ ok: true, message: "Password reset to pass123" });
	  }

	  case 'bulk_password_reset': {
	    // Only allow Officers or Professors to perform this
	    if (currentUser.role === 'student') {
	        return res.status(403).json({ ok: false, error: "Unauthorized access." });
	    }
	
	    const defaultPassword = "pass123"; // You can change this default
	    const hashedDefault = await bcrypt.hash(defaultPassword, 10);
	
	    try {
	        // Reset all students in the sys_users table
	        const result = await pool.query(
	            "UPDATE sys_users SET password_hash = $1 WHERE user_role = 'student'",
	            [hashedDefault]
	        );
	
	        return res.json({ 
	            ok: true, 
	            message: `Successfully reset passwords for ${result.rowCount} students to: ${defaultPassword}` 
	        });
	    } catch (err) {
	        return res.json({ ok: false, error: err.message });
	    }
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
	
	  case 'credit_attendance': {
	    const { class_code, student_id } = payload;
	    const now = getManilaNow();

		const config = await pool.query("SELECT config_value FROM config WHERE config_key = 'sem2_adjustment_end'");
		// Define your adjustment window (e.g., first 2 weeks of the semester)
		const adjustmentEnd = DateTime.fromISO(config.rows[0].config_value).setZone(TIMEZONE);
	
	    if (now > adjustmentEnd) {
	        return res.json({ ok: false, error: "Adjustment period has ended." });
	    }
	
	    // Mark as CREDITED for today (or use your logic to loop through semester dates)
		await pool.query(`
		    INSERT INTO attendance (class_date, class_code, student_id, attendance_status, time_in)
		    VALUES ($1, $2, $3, 'CREDITED', $4)
		    ON CONFLICT (class_date, class_code, student_id) 
		    DO UPDATE SET attendance_status = 'CREDITED'
		`, [now.toISODate(), class_code, student_id, now.toFormat('HH:mm:ss')]);
	
	    return res.json({ ok: true, message: "Attendance credited successfully." });
	  }

	  case 'submit_excuse': {
	    const { class_code, student_id, reason } = payload;
	    const now = getManilaNow();
	    const dateStr = now.toISODate();
	
	    if (!reason || reason.trim().length < 5) {
	        return res.json({ ok: false, error: "Please provide a valid reason (min 5 characters)." });
	    }
	
	    // This updates an existing record (Late/Absent/Incomplete) 
	    // or creates a new one marked as 'EXCUSED'
	    await pool.query(`
	        INSERT INTO attendance (class_date, class_code, student_id, attendance_status, reason, time_in)
	        VALUES ($1, $2, $3, 'EXCUSED', $4, $5)
	        ON CONFLICT (class_date, class_code, student_id) 
	        DO UPDATE SET reason = $4, attendance_status = 'EXCUSED'
	    `, [dateStr, class_code, student_id, reason.trim(), now.toFormat('HH:mm:ss')]);
	
	    return res.json({ ok: true, message: "Excuse filed successfully." });
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

async function generateClassPDF(pdfDoc, info, records, excuses, font, bold) {
  let page = pdfDoc.addPage([600, 800]);
  let y = 750;

  // Header Section (mimicking Excel top rows)
  page.drawText(`Class Code: ${info.class_code}`, { x: 50, y, size: 12, font: bold });
  page.drawText(`Class Name: ${info.class_name}`, { x: 50, y: y - 15, size: 10, font });
  page.drawText(`Professor: ${info.professor_name}`, { x: 50, y: y - 30, size: 10, font });
  y -= 60;

  // Attendance Table
  page.drawText('Attendance Log', { x: 50, y, size: 12, font: bold });
  y -= 20;
  records.forEach(r => {
    if (y < 50) { page = pdfDoc.addPage([600, 800]); y = 750; }
    const date = DateTime.fromJSDate(r.class_date).toFormat('yyyy-MM-dd');
    page.drawText(`${date} | ${r.user_name.substring(0,25)} | ${r.attendance_status}`, { x: 50, y, size: 9, font });
    y -= 15;
  });

  // Excuse Log Section (New Page)
  if (excuses.length > 0) {
    page = pdfDoc.addPage([600, 800]);
    y = 750;
    page.drawText('Class Excuse Log', { x: 50, y, size: 14, font: bold });
    y -= 30;
    excuses.forEach(e => {
      const date = DateTime.fromJSDate(e.class_date).toFormat('yyyy-MM-dd');
      page.drawText(`${date} - ${e.user_name}: ${e.reason}`, { x: 50, y, size: 9, font });
      y -= 15;
    });
  }
}

async function generateStudentPDF(pdfDoc, studentInfo, history, font, bold) {
  let page = pdfDoc.addPage([600, 800]);
  let y = 750;

  page.drawText(`Student Name: ${studentInfo.user_name}`, { x: 50, y, size: 14, font: bold });
  page.drawText(`Generated on: ${getManilaNow().toFormat('yyyy-MM-dd HH:mm')}`, { x: 50, y: y - 20, size: 10, font });
  y -= 60;

  // Table Headers
  page.drawText('Date', { x: 50, y, size: 10, font: bold });
  page.drawText('Class', { x: 150, y, size: 10, font: bold });
  page.drawText('Status', { x: 400, y, size: 10, font: bold });
  y -= 20;

  history.forEach(h => {
    if (y < 50) { page = pdfDoc.addPage([600, 800]); y = 750; }
    const date = DateTime.fromJSDate(h.class_date).toFormat('yyyy-MM-dd');
    page.drawText(date, { x: 50, y, size: 9, font });
    page.drawText(h.class_name.substring(0, 30), { x: 150, y, size: 9, font });
    page.drawText(h.attendance_status, { x: 400, y, size: 9, font });
    
    // If there is an excuse reason, print it on the next line
    if (h.reason) {
      y -= 12;
      page.drawText(`Reason: ${h.reason}`, { x: 160, y, size: 8, font, color: rgb(0.4, 0.4, 0.4) });
    }
    y -= 15;
  });
}

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
      time_out TIME,
      reason TEXT,
      PRIMARY KEY (class_date, class_code, student_id)
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
  console.log("Running auto-tag maintenance...");
  try {
    const now = getManilaNow();
    const dayName = now.toFormat('ccc');
    const dateStr = now.toISODate();

    const schedules = await pool.query(
      "SELECT * FROM schedules WHERE $1 = ANY(days)", 
      [dayName]
    );

    for (const sched of schedules.rows) {
      const [endHH, endMM] = sched.end_time.split(':');
      const classEnd = now.set({ hour: endHH, minute: endMM, second: 0 });

      // Only process classes that ended at least 30 minutes ago
      if (now > classEnd.plus({ minutes: 30 })) {
        
        // A. Mark completely missing students as ABSENT
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

        // B. Mark "Forgetful" students as INCOMPLETE
        // (They checked in but never checked out)
		await pool.query(`
		  UPDATE attendance 
		  SET attendance_status = 'INCOMPLETE'
		  WHERE class_date = $1
		  AND class_code = $2 
		  AND time_out IS NULL 
		  AND attendance_status IN ('PRESENT', 'LATE')
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
