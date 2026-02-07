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

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1'); // Minimal query just to check connection
    res.send('OK');
  } catch (err) {
    res.status(500).send('DB_ERROR');
  }
});

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
        // Verify user exists in roster first
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
			const { student_id } = payload;
			const now = getManilaNow();
			const dateStr = now.toISODate(); // '2026-02-07'
			const dayName = now.toFormat('ccc'); // 'Sat'

			// 1. Get the current active semester info
	        const semInfo = await getCurrentSemConfig();
	        
	        if (semInfo.sem === "None") {
	            return res.json({ ok: true, schedule: [], message: "No active semester found." });
	        }

			// 2. Filter query by Day, Semester, and Academic Year
			const query = `
			  SELECT s.*, u.user_name as professor_name, a.attendance_status as my_status, a.time_in, a.reason 
			  FROM schedules s
			  LEFT JOIN sys_users u ON s.professor_id = u.user_id
			  LEFT JOIN attendance a ON s.class_code = a.class_code 
                AND a.student_id = $1 
                AND a.class_date = $2::date
			  WHERE ($3 = ANY(s.days)
				  AND s.semester = $4 
	              AND s.academic_year = $5) 
				  OR EXISTS (
			        SELECT 1 FROM attendance ma 
			        WHERE ma.class_code = s.class_code 
			        AND ma.class_date = $2::date 
			        AND ma.attendance_status = 'PENDING'
		     )
			`;
			const result = await pool.query(query, [student_id, dateStr, dayName, semInfo.sem, semInfo.year]);
			
			// Format times for frontend
			const schedule = result.rows.map(row => ({
			  ...row,
			  start_time: DateTime.fromFormat(row.start_time, 'HH:mm:ss').toFormat('hh:mm a'),
              end_time: DateTime.fromFormat(row.end_time, 'HH:mm:ss').toFormat('hh:mm a')
			}));
		
			return res.json({ ok: true, schedule: result.rows });
		  } catch (err) {
			return res.json({ ok: false, error: err.message });
		  }
	  }
		
	  // 2. Check-in Logic
	  case 'checkin': {
		  const { class_code, student_id } = req.body;
		  const now = getManilaNow();
		  const dateStr = now.toISODate();
		  const semConfig = await getCurrentSemConfig();
		
		  try {
			// Block check-in if not in a semester
			if (!semConfig.start || semConfig.sem === "None") {
	           return res.json({ ok: false, error: "Attendance disabled outside semester dates." });
	        }
			// A. Check for existing attendance (Duplicate Prevention)
			const existing = await pool.query(
			  'SELECT attendance_status FROM attendance WHERE class_date = $1::date AND class_code = $2 AND student_id = $3',
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
			const diffMins = now.diff(classStart, 'minutes').minutes;
		
			// Window Logic (using config from the DB; Using 10/10/20 window logic)
			const checkinOpen = -(parseInt(semConfig.checkin_window_minutes) || 10);	 // Opens 10 mins before
			const lateThreshold = parseInt(semConfig.late_window_minutes) || 5;	 // Late after 5 mins
			const absentThreshold = parseInt(semConfig.absent_window_minutes) || 20;	// Absent after 10 mins
	
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
		const current = await pool.query(
			"SELECT attendance_status FROM attendance WHERE class_date = $1::date AND class_code = $2 AND student_id = $3",
			[getManilaNow().toISODate(), class_code, student_id]
		);

		if (current.rows.length > 0 && current.rows[0].attendance_status === 'EXCUSED') {
	        return res.json({ ok: false, error: "Cannot check out: You are currently marked as Excused." });
	    } else if (current.rows.length === 0) { 
			return res.json({ ok: false, error: "You must check in before checking out." }); 
		}
		
		await pool.query(
			"UPDATE attendance SET time_out = $1 WHERE class_date = $2::date AND class_code = $3 AND student_id = $4",
			[timeStr, dateStr, class_code, student_id]
		);
		
		return res.json({ ok: true, time_out: timeStr });
	  }

      // --- GET ATTENDANCE (For UI status check) ---
      case 'get_attendance': {
        const { class_code, student_id } = payload;
        const date = DateTime.now().setZone(TIMEZONE).toISODate();
        const result = await pool.query(
          'SELECT attendance_status as status, time_in, time_out FROM attendance WHERE class_date = $1::date AND class_code = $2 AND student_id = $3',
          [date, class_code, student_id]
        );
        return res.json({ ok: true, record: result.rows[0] || { status: 'not_recorded' } });
      }

	  case 'prof_dashboard': {
		const { class_code } = payload;
		const date = getManilaNow().toISODate();

		const isMakeup = await checkDateIfMakeup(date, class_code);
		
		// 1. Get counts for the header cards
		const stats = await pool.query(`
			SELECT attendance_status as status, COUNT(*) as count 
			FROM attendance 
			WHERE class_code = $1 AND class_date = $2::date
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
			LEFT JOIN attendance a ON u.user_id = a.student_id AND a.class_code = $1 AND a.class_date = $2::date
			WHERE u.user_role IN ('student', 'officer')
			ORDER BY 
				CASE WHEN a.attendance_status IS NULL THEN 1 ELSE 0 END,
				a.time_in DESC, 
				u.user_name ASC
		`, [class_code, date]);
		
		return res.json({ 
			ok: true, 
			stats: stats.rows, 
			roster: roster.rows, 
			is_makeup_session: isMakeup 
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
		    WHERE u.user_role IN ('student', 'officer')
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
	    const semConfig = await getCurrentSemConfig();
	
	    if (semConfig.sem === "None") return res.json({ ok: false, error: "No active semester found." });
	
	    if (type === 'class') {
	        const classInfo = await pool.query(`SELECT s.*, u.user_name as professor_name FROM schedules s JOIN sys_users u ON s.professor_id = u.user_id WHERE s.class_code = $1`, [class_code]);
	        if (classInfo.rows.length === 0) return res.json({ ok: false, error: "Class not found." });
	        const info = classInfo.rows[0];
	
	        let classDates = [];
	        let curr = semConfig.start;
	        while (curr <= semConfig.end) {
	            if (info.days.includes(curr.toFormat('ccc'))) classDates.push(curr);
	            curr = curr.plus({ days: 1 });
	        }
	
	        const attendance = await pool.query(`SELECT a.*, u.user_name FROM sys_users u LEFT JOIN attendance a ON u.user_id = a.student_id AND a.class_code = $1 WHERE u.user_role IN ('student', 'officer') ORDER BY u.user_name ASC`, [class_code]);
	        
	        const roster = {};
	        attendance.rows.forEach(r => {
	          if (!roster[r.student_id]) roster[r.student_id] = { name: r.user_name, records: {}, counts: { P: 0, L: 0, A: 0, E: 0, C: 0, H: 0, S: 0, D: 0 } };
			  if (r.class_date) {
			    const dStr = DateTime.fromJSDate(r.class_date).toISODate();
			    
			    // FIX: Character priority logic
			    let statusChar = r.attendance_status === 'HOLIDAY' ? 'H' : 
                 r.attendance_status === 'SUSPENDED' ? 'S' : 
                 r.attendance_status === 'CANCELLED' ? 'C' : 
				 r.attendance_status === 'DROPPED' ? 'D' :
                 r.attendance_status[0].toUpperCase();	// Default (P, L, A, E)
			
			    roster[r.student_id].records[dStr] = statusChar;
			    
			    if (roster[r.student_id].counts[statusChar] !== undefined) {
			        roster[r.student_id].counts[statusChar]++;
			    }
			  }
			});

			const excuses = await pool.query(
			    `SELECT a.class_date, u.user_name, a.reason 
			     FROM attendance a 
			     JOIN sys_users u ON a.student_id = u.user_id 
			     WHERE a.class_code = $1 AND (a.reason IS NOT NULL OR a.attendance_status = 'SUSPENDED')
			     ORDER BY a.class_date DESC`, [class_code]
			);
	
	        await generateClassMatrixPDF(pdfDoc, info, classDates, roster, semConfig, font, boldFont);
	        await appendExcuseLogPage(pdfDoc, "CLASS EXCUSE LOG", excuses.rows, font, boldFont, "name");
	        
	    } else if (type === 'person') {
	        const studentRes = await pool.query('SELECT user_name FROM sys_users WHERE user_id = $1', [student_id]);
	        const attendance = await pool.query(`SELECT a.*, s.class_name FROM attendance a JOIN schedules s ON a.class_code = s.class_code WHERE a.student_id = $1 ORDER BY s.class_name ASC`, [student_id]);
	        
	        const subjects = {};
	        attendance.rows.forEach(r => {
			    if (!subjects[r.class_code]) {
			        subjects[r.class_code] = { 
			            name: r.class_name, 
			            records: {}, 
			            counts: { P: 0, L: 0, A: 0, E: 0, C: 0, H: 0, S: 0, D: 0 } 
			        };
			    }
			    const dStr = DateTime.fromJSDate(r.class_date).toISODate();
			    
			    // Character Mapping Consistency
			    let statusChar = r.attendance_status[0].toUpperCase();
			    if (r.attendance_status === 'HOLIDAY') statusChar = 'H';
			    if (r.attendance_status === 'SUSPENDED') statusChar = 'S';
			    if (r.attendance_status === 'DROPPED') statusChar = 'D';
			
			    subjects[r.class_code].records[dStr] = statusChar;
			    if (subjects[r.class_code].counts[statusChar] !== undefined) {
			        subjects[r.class_code].counts[statusChar]++;
			    }
			});
	
	        const excuses = await pool.query(`SELECT a.class_date, s.class_name, a.reason FROM attendance a JOIN schedules s ON a.class_code = s.class_code WHERE a.student_id = $1 AND a.reason IS NOT NULL AND semester = $2 AND academic_year = $3 ORDER BY a.class_date DESC`, [student_id, semConfig.sem, semConfig.year]);
	
	        await generateStudentMatrixPDF(pdfDoc, studentRes.rows[0], student_id, subjects, semConfig, font, boldFont);
	        await appendExcuseLogPage(pdfDoc, "STUDENT EXCUSE LOG", excuses.rows, font, boldFont, "class_name");
	    }
	
	    const pdfBytes = await pdfDoc.save();
	    return res.json({ ok: true, pdfMain: Buffer.from(pdfBytes).toString('base64'), filename: `Report_${type}.pdf` });
	  }

	  // --- DROPDOWNS (For Officer Reports) ---
      case 'get_dropdowns': {
		const semInfo = await getCurrentSemConfig();
        const classes = await pool.query('SELECT class_code as code, class_name as name FROM schedules WHERE semester = $1 AND academic_year = $2', [semInfo.sem, semInfo.year]);
        const students = await pool.query('SELECT user_id, user_name FROM sys_users WHERE (user_role = \'student\' OR user_role = \'officer\')');
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
	    return res.json({ ok: true, message: "Password reset to password1234" });
	  }

	  case 'bulk_password_reset': {
	    // Only allow Officers or Professors to perform this
		const { role } = payload;
	    if (role === 'student') {
	        return res.status(403).json({ ok: false, error: "Unauthorized access." });
	    }
	
	    const defaultPassword = "password1234"; // You can change this default
	    const hashedDefault = await bcrypt.hash(defaultPassword, 10);
	
	    try {
	        // Reset all students in the sys_users table
	        const result = await pool.query(
	            "UPDATE sys_users SET password_hash = $1 WHERE user_role IN ('student', 'officer')",
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
        try {
		    // 1. Fetch all key-value pairs from the config table
		    const configRes = await pool.query("SELECT config_key, config_value FROM config");
		    const dbConfig = Object.fromEntries(configRes.rows.map(r => [r.config_key, r.config_value]));
		
		    // 2. Determine the active semester's adjustment end date
		    const semInfo = await getCurrentSemConfig(); // Using the helper we created
		    
		    return res.json({
		      ok: true,
		      config: {
		        checkin_window_minutes: parseInt(dbConfig.checkin_window_minutes) || 10,
		        late_window_minutes: parseInt(dbConfig.late_window_minutes) || 5,
		        absent_window_minutes: parseInt(dbConfig.absent_window_minutes) || 10,
		        checkout_window_minutes: parseInt(dbConfig.checkout_window_minutes) || 10,
		        // Dynamically set based on the current semester detected
		        adjustment_end: semInfo.adjEnd ? semInfo.adjEnd.toISODate() : '2099-12-31',
		        current_sem: semInfo.sem
		      }
		    });
		  } catch (err) {
		    return res.status(500).json({ ok: false, error: err.message });
		  }
      }

	  case 'check_holiday': {
		const today = getManilaNow().toISODate();
		const result = await pool.query('SELECT holiday_name, holiday_type FROM holidays WHERE holiday_date = $1::date', [today]);
		
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
		  const { class_code, student_id, type } = payload; // type: 'CREDITED' or 'DROPPED'
		  const now = getManilaNow();
		  const semConfig = await getCurrentSemConfig();
		
		  if (semConfig.sem === "None") return res.json({ ok: false, error: "No active semester." });
		
		  try {
		    // 1. Fetch Class Schedule to find valid meeting days
		    const schedRes = await pool.query("SELECT days FROM schedules WHERE class_code = $1", [class_code]);
		    if (schedRes.rows.length === 0) return res.json({ ok: false, error: "Class not found." });
		    const classDays = schedRes.rows[0].days;
		
		    // 2. Loop from today until the end of the semester
		    let current = now;
		    let datesToUpdate = [];
		
		    while (current <= semConfig.end) {
		      if (classDays.includes(current.toFormat('ccc'))) {
		        datesToUpdate.push(current.toISODate());
		      }
		      current = current.plus({ days: 1 });
		    }
		
		    if (datesToUpdate.length === 0) {
		      return res.json({ ok: false, error: "No future class dates found to update." });
		    }
		
		    // 3. Bulk Upsert the status (D for Dropped, C for Credited)
		    const statusToApply = (type === 'DROPPED') ? 'DROPPED' : 'CREDITED';
		    
		    await pool.query(`
		      INSERT INTO attendance (class_date, class_code, student_id, attendance_status, time_in)
		      SELECT unnest($1::date[]), $2, $3, $4, $5
		      ON CONFLICT (class_date, class_code, student_id) 
		      DO UPDATE SET attendance_status = $4
		    `, [datesToUpdate, class_code, student_id, statusToApply, now.toFormat('HH:mm:ss')]);
		
		    return res.json({ 
		      ok: true, 
		      message: `Marked remaining sessions as ${statusToApply}.` 
		    });
		  } catch (err) {
		    return res.json({ ok: false, error: "Database error: " + err.message });
		  }
	  }

	  case 'submit_excuse': {
	    const { class_code, student_id, reason } = payload;
	    const now = getManilaNow();
	    const today = now.toISODate();
		const timestamp = now.toFormat('hh:mm a'); // e.g., 09:45 AM

		// Existing check for duplicates...
	    const existing = await pool.query(
	        'SELECT attendance_status FROM attendance WHERE class_date = $1::date AND class_code = $2 AND student_id = $3',
	        [today, class_code, student_id]
	    );
	
	    if (existing.rows.length > 0) {
	        return res.json({ ok: false, error: "Already filed for today." });
	    }
	
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
	    `, [today, class_code, student_id, reason.trim(), timestamp]);
	
	    return res.json({ ok: true, message: "Excuse filed successfully.", filedAt: timestamp });
	  }

	  case 'suspend_class': {
	    const { class_code, reason, date, statusType } = payload; // statusType: 'SUSPENDED' or 'CANCELLED'
	    const targetDate = date || getManilaNow().toISODate();
	
	    if (!reason || reason.trim().length < 5) {
	        return res.json({ ok: false, error: "Please provide a specific reason." });
	    }
	
	    try {
	        await pool.query(`
	            INSERT INTO attendance (class_date, class_code, student_id, attendance_status, reason, time_in)
	            SELECT $1, $2, user_id, $4, $3, '00:00:00'
	            FROM sys_users
	            WHERE user_role IN ('student', 'officer')
	            ON CONFLICT (class_date, class_code, student_id) 
	            DO UPDATE SET attendance_status = $4, reason = $3
	        `, [targetDate, class_code, reason.trim(), statusType]);
	
	        return res.json({ ok: true, message: `Class marked as ${statusType.toLowerCase()}.` });
	    } catch (err) {
	        return res.json({ ok: false, error: err.message });
	    }
	  }

	  case 'authorize_makeup': {
		const { class_code, date } = payload;

		// Check if professor is already scheduled for another class on this date/time
	    const conflictCheck = await pool.query(`
	        SELECT s.class_name 
	        FROM schedules s
	        JOIN attendance a ON s.class_code = a.class_code
	        WHERE a.class_date = $1::date AND s.professor_id = (
	            SELECT professor_id FROM schedules WHERE class_code = $2
	        )
	    `, [date, class_code]);
	
	    if (conflictCheck.rows.length > 0) {
	        return res.json({ 
	            ok: false, 
	            error: `Conflict: Professor is already assigned to ${conflictCheck.rows[0].class_name} on this date.` 
	        });
	    }
		  
		// Mark everyone as 'PENDING' for the make-up date
		await pool.query(`
			INSERT INTO attendance (class_date, class_code, student_id, attendance_status, time_in)
			SELECT $1, $2, user_id, 'PENDING', '00:00:00'
			FROM sys_users WHERE user_role IN ('student', 'officer')
			ON CONFLICT DO NOTHING
		`, [date, class_code]);
		return res.json({ ok: true, message: `Make-up session authorized for ${date}` });
	  }

	  case 'get_today_status': {
		  const now = getManilaNow();
		  const dateStr = now.toISODate();
		  
		  // 1. Check for Holiday
		  const holiday = await pool.query('SELECT holiday_name, holiday_type FROM holidays WHERE holiday_date = $1::date', [dateStr]);
		  
		  // 2. Check for Suspensions (Checking if any class today is marked SUSPENDED)
		  const suspensions = await pool.query(
		    'SELECT DISTINCT reason FROM attendance WHERE class_date = $1::date AND attendance_status = \'SUSPENDED\'', [dateStr]
		  );
		
		  return res.json({
		    ok: true,
		    isHoliday: holiday.rows.length > 0,
		    holidayName: holiday.rows[0]?.holiday_name,
		    isSuspended: suspensions.rows.length > 0,
		    suspensionReason: suspensions.rows[0]?.reason
		  });
	  }

	  case 'health_check': {
		try {
			// Perform a simple query to verify DB connection
		    const result = await pool.query('SELECT NOW() as server_time');
			return res.json({ ok: true, status: "Healthy", db: "Connected", db_time: result.rows[0].server_time, uptime: process.uptime().toFixed(2) + " seconds" });
		  } catch (err) {
			return res.status(500).json({ ok: false, status: "Database Connection Error", error: err.message });
		  }
	  }

      default: {
        return res.status(400).json({ ok: false, error: `Action ${action} not implemented` });
	  }
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error: ' + err.message });
  }
});

async function generateClassMatrixPDF(pdfDoc, info, dates, roster, semConfig, font, bold) {
  // Legal Landscape Dimensions
  const page = pdfDoc.addPage([1008, 612]); 
  let y = 575;

  // --- TOP INFO BLOCK (Matches Excel Rows 1-6) ---
  page.drawText(`Class Code:`, { x: 40, y, size: 10, font: bold });
  page.drawText(`${info.class_code}`, { x: 120, y, size: 10, font });
  
  // SYSTEM GENERATED TIMESTAMP (Top Right)
  const timestamp = getManilaNow().toFormat('yyyy-MM-dd HH:mm:ss');
  page.drawText(`Generated: ${timestamp}`, { x: 800, y, size: 9, font: bold, color: rgb(0.3, 0.3, 0.3) });

  y -= 15;
  page.drawText(`Class Name:`, { x: 40, y, size: 10, font: bold });
  page.drawText(`${info.class_name}`, { x: 120, y, size: 10, font });
  
  // SEMESTER INFO
  page.drawText(`Semester:`, { x: 400, y, size: 10, font: bold });
  page.drawText(`${semConfig.name}`, { x: 470, y, size: 10, font });
	
  page.drawText(`Academic Year:`, { x: 600, y, size: 10, font: bold });
  page.drawText(`${semConfig.year}`, { x: 700, y, size: 10, font });

  y -= 15;
  page.drawText(`Professor:`, { x: 40, y, size: 10, font: bold });
  page.drawText(`${info.professor_name || 'N/A'}`, { x: 120, y, size: 10, font });
  
  y -= 15;
  page.drawText(`Schedule:`, { x: 40, y, size: 10, font: bold });
  page.drawText(`${info.days.join('/')} | ${DateTime.fromFormat(info.start_time, 'HH:mm:ss').toFormat('hh:mm a')}-${DateTime.fromFormat(info.end_time, 'HH:mm:ss').toFormat('hh:mm a')}`, { x: 120, y, size: 10, font });
  
  y -= 15;
  page.drawText(`Section:`, { x: 40, y, size: 10, font: bold });
  page.drawText(`BPAOUMN 1-B`, { x: 120, y, size: 10, font });

  y -= 30; // Space before table

  // --- D1, D2, D3 MATRIX HEADERS ---
  let startX = 280;
  const colWidth = 18;
  
  page.drawText('Student ID', { x: 40, y, size: 8, font: bold });
  page.drawText('Student Name', { x: 120, y, size: 8, font: bold });

  dates.slice(0, 35).forEach((d, i) => {
    const xPos = startX + (i * colWidth);
	const isMakeupDay = checkDateIfMakeup(d.toISODate(), info.class_code); // Helper to check attendance table
    page.drawText(`D${i+1}${isMakeupDay ? '*' : ''}`, { x: xPos, y, size: 7, font: bold });
    page.drawText(d.toFormat('MM/dd'), { x: xPos, y: y - 8, size: 5, font });
  });

  // TOTALS HEADER
  const totalX = startX + (35 * colWidth) + 20;
  page.drawText('P', { x: totalX, y, size: 8, font: bold });
  page.drawText('L', { x: totalX + 20, y, size: 8, font: bold });
  page.drawText('A', { x: totalX + 40, y, size: 8, font: bold });
  page.drawText('D', { x: totalX + 60, y, size: 8, font: bold });
  page.drawText('%', { x: totalX + 85, y, size: 8, font: bold });

  y -= 20;
  page.drawLine({ start: { x: 40, y }, end: { x: 970, y }, thickness: 0.5 });
  
  // --- STUDENT ROWS ---
  Object.keys(roster).forEach((sid) => {
    y -= 12;
    if (y < 40) return; // Add page logic if needed for very large classes

    const student = roster[sid];
    page.drawText(sid, { x: 40, y, size: 7, font });
    page.drawText(student.name.substring(0, 25), { x: 100, y, size: 7, font });

    // Draw Status Grid
    dates.slice(0, 35).forEach((d, i) => {
	  const status = student.records[d.toISODate()] || '-';
	  
	  // DEFAULT COLOR (Black)
	  let statusColor = rgb(0, 0, 0); 
	
	  // FIX: Apply conditional coloring
	  if (status === 'P') statusColor = rgb(0, 0.5, 0);       // Green
	  if (status === 'A') statusColor = rgb(0.8, 0, 0);       // Red
	  if (status === 'H') statusColor = rgb(0.2, 0.5, 0.8);   // Blue (Holiday)
	  if (status === 'S') statusColor = rgb(0.5, 0.2, 0.7);   // Purple (Suspended)
	  if (status === 'C') color = rgb(0.4, 0.4, 0.4); // Dark Grey (Cancelled)
	  if (status === 'D') statusColor = rgb(0.5, 0.5, 0.5);   // Gray (Dropped)

	  page.drawText(status, { 
	    x: startX + (i * colWidth), 
	    y, 
	    size: 7, 
	    font, 
	    color: statusColor 
	  });
	});

    // Draw Aggregated Totals
    const c = student.counts;
    const presentTotal = (c.P || 0) + (c.L || 0) + (c.C || 0);
	// EXCLUDE H, S, and D from the total possible days so their % isn't ruined
	const excusedSessions = (c.H || 0) + (c.S || 0) + (c.D || 0);
	// Total sessions that actually required attendance
	const totalPossible = dates.length - excusedSessions;
	const perc = totalPossible > 0 ? Math.round((presentTotal / totalPossible) * 100) : 0;

	// Draw Totals
	page.drawText(`${presentTotal}`, { x: totalX, y, size: 7, font });
	page.drawText(`${c.L}`, { x: totalX + 20, y, size: 7, font });
	page.drawText(`${c.A}`, { x: totalX + 40, y, size: 7, font });
	page.drawText(`${c.D || 0}`, { x: totalX + 60, y, size: 7, font });
	page.drawText(`${perc}%`, { x: totalX + 85, y, size: 7, font: bold });
    
    // Horizontal row line
    page.drawLine({ start: { x: 40, y: y - 2 }, end: { x: 970, y: y - 2 }, thickness: 0.1, color: rgb(0.8, 0.8, 0.8) });
	// Footer Legend
	page.drawText(`* Denotes authorized Make-up Session`, { x: 40, y: 30, size: 6, font });
  });
}

async function generateStudentMatrixPDF(pdfDoc, student, sid, subjects, sem, font, bold) {
    const page = pdfDoc.addPage([1008, 612]);
    let y = 575;

    // Header (Matches Excel StudentReport Tab)
    page.drawText(`STUDENT ATTENDANCE REPORT`, { x: 40, y, size: 16, font: bold });
    const timestamp = getManilaNow().toFormat('yyyy-MM-dd HH:mm:ss');
    page.drawText(`Generated: ${timestamp}`, { x: 800, y, size: 9, font: bold });

    y -= 25;
    page.drawText(`Student ID:`, { x: 40, y, size: 10, font: bold });
    page.drawText(`${sid}`, { x: 130, y, size: 10, font });
    page.drawText(`Semester:`, { x: 400, y, size: 10, font: bold });
    page.drawText(`${sem.name}`, { x: 480, y, size: 10, font });

    y -= 15;
    page.drawText(`Student Name:`, { x: 40, y, size: 10, font: bold });
    page.drawText(`${student.user_name}`, { x: 130, y, size: 10, font });
    page.drawText(`Academic Year:`, { x: 400, y, size: 10, font: bold });
    page.drawText(`${sem.year}`, { x: 480, y, size: 10, font });

    y -= 40;

    // Table Headers
    page.drawText('Subject Code', { x: 40, y, size: 8, font: bold });
    page.drawText('Subject Title', { x: 120, y, size: 8, font: bold });
    
    // We use a generic D1-D35 header because subjects have different days
    let startX = 350;
    const colWidth = 16;
    for(let i=1; i<=35; i++) {
        page.drawText(`D${i}`, { x: startX + ((i-1) * colWidth), y, size: 7, font: bold });
    }
    
    const totalX = startX + (35 * colWidth) + 20;
    page.drawText('Pres', { x: totalX, y, size: 8, font: bold });
    page.drawText('%', { x: totalX + 40, y, size: 8, font: bold });

    y -= 15;
    page.drawLine({ start: { x: 40, y }, end: { x: 970, y }, thickness: 0.5 });

    // Draw Subject Rows
    Object.keys(subjects).forEach(code => {
        y -= 15;
        const sub = subjects[code];
        page.drawText(code, { x: 40, y, size: 7, font });
        page.drawText(sub.name.substring(0, 40), { x: 120, y, size: 7, font });

        // Since subjects have different dates, we list the statuses in order of occurrence
		const sortedDates = Object.keys(sub.records).sort();
		sortedDates.slice(0, 35).forEach((dStr, i) => {
		    const status = sub.records[dStr];

		    let statusColor = rgb(0, 0, 0); // Default Black
		    if (status === 'P') statusColor = rgb(0, 0.5, 0);     // Green
		    if (status === 'A') statusColor = rgb(0.8, 0, 0);     // Red
		    if (status === 'H') statusColor = rgb(0.2, 0.5, 0.8); // Blue (Holiday)
		    if (status === 'S') statusColor = rgb(0.5, 0.2, 0.7); // Purple (Suspension)
		    if (status === 'D') statusColor = rgb(0.5, 0.5, 0.5); // Gray (Dropped)

			page.drawText(status, { x: startX + (i * colWidth), y, size: 7, font, color: statusColor });
		});

        // Totals for this specific subject
		const c = sub.counts;
		const presentTotal = (c.P || 0) + (c.L || 0) + (c.C || 0);
		const excusedSessions = (c.H || 0) + (c.S || 0) + (c.D || 0);

		// Subtracting excused/holiday/dropped days from the denominator
		const totalPossible = sortedDates.length - excused;
		const perc = totalPossible > 0 ? Math.round((presentTotal / totalPossible) * 100) : 0;

		// Draw Totals for the Subject Row
		page.drawText(`${presentTotal}`, { x: totalX, y, size: 7, font });
		page.drawText(`${perc}%`, { x: 920, y, size: 7, font: bold });
        
        page.drawLine({ start: { x: 40, y: y - 2 }, end: { x: 970, y: y - 2 }, thickness: 0.1, color: rgb(0.8, 0.8, 0.8) });
    });
}

async function appendExcuseLogPage(pdfDoc, title, excuses, font, bold, secondaryColName) {
  if (excuses.length === 0) return;

  const page = pdfDoc.addPage([1008, 612]); // Legal Landscape
  let y = 550;

  page.drawText(title, { x: 40, y, size: 16, font: bold });
  y -= 30;

  // Table Headers
  page.drawText('DATE', { x: 40, y, size: 10, font: bold });
  page.drawText(secondaryColName === 'name' ? 'STUDENT NAME' : 'SUBJECT/CLASS', { x: 150, y, size: 10, font: bold });
  page.drawText('REASON / JUSTIFICATION', { x: 450, y, size: 10, font: bold });
  
  y -= 10;
  page.drawLine({ start: { x: 40, y }, end: { x: 970, y }, thickness: 1 });
  y -= 20;

  excuses.forEach(e => {
    if (y < 50) { // New page if near bottom
        page = pdfDoc.addPage([1008, 612]);
        y = 550;
    }

    const dateStr = DateTime.fromJSDate(e.class_date).toFormat('yyyy-MM-dd');
    const secondaryVal = e[secondaryColName] || "N/A";
    
    page.drawText(dateStr, { x: 40, y, size: 9, font });
    page.drawText(secondaryVal.substring(0, 45), { x: 150, y, size: 9, font });
    
    // Auto-wrap or truncate long reasons
    const reasonSnippet = e.reason.substring(0, 100);
    page.drawText(reasonSnippet, { x: 450, y, size: 9, font });

    y -= 15;
    page.drawLine({ start: { x: 40, y: y + 5 }, end: { x: 970, y: y + 5 }, thickness: 0.1, color: rgb(0.8,0.8,0.8) });
  });
}

const getCurrentSemConfig = async () => {
  const now = getManilaNow();
  const currentYear = now.year;
  const res = await pool.query("SELECT config_key, config_value FROM config");
  const config = Object.fromEntries(res.rows.map(r => [r.config_key, r.config_value]));

  // Convert config dates to Luxon objects
  const s1Start = DateTime.fromISO(config.sem1_start).setZone(TIMEZONE);
  const s1End = DateTime.fromISO(config.sem1_end).setZone(TIMEZONE);
  const s2Start = DateTime.fromISO(config.sem2_start).setZone(TIMEZONE);
  const s2End = DateTime.fromISO(config.sem2_end).setZone(TIMEZONE);

  // Logic to determine school year (e.g., 2025-2026)
  const schoolYear = now.month >= 8 
    ? `${currentYear}-${currentYear + 1}` 
    : `${currentYear - 1}-${currentYear}`;

  if (now >= s1Start && now <= s1End) {
    return { 
      sem: "1", 
      start: s1Start, 
      end: s1End, 
      adjEnd: DateTime.fromISO(config.sem1_adjustment_end).setZone(TIMEZONE),
	  name: "First Semester", 
	  year: schoolYear
    };
  } else if (now >= s2Start && now <= s2End) {
    return { 
      sem: "2", 
      start: s2Start, 
      end: s2End, 
      adjEnd: DateTime.fromISO(config.sem2_adjustment_end).setZone(TIMEZONE),
	  name: "Second Semester", 
	  year: schoolYear
    };
  } else {
    // Default to nearest sem or "Out of Semester"
    return { sem: "None", start: null, end: null, adjEnd: null, name: "None", year: "None" };
  }
};

const checkDateIfMakeup = async (date, classCode) => {
    try {
        // We look for 'PENDING' because that is the status we use 
        // to "pre-authorize" students to check in on a non-regular day.
        const result = await pool.query(`
            SELECT 1 FROM attendance 
            WHERE class_date = $1::date 
            AND class_code = $2 
            AND attendance_status = 'PENDING'
            LIMIT 1
        `, [date, classCode]);

        return result.rows.length > 0;
    } catch (err) {
        console.error("Error checking makeup status:", err);
        return false;
    }
};

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
      semester TEXT,
      academic_year TEXT,
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
	const semInfo = await getCurrentSemConfig();

    if (semInfo.sem === 'None') {
      return;
    }

    // 1. Check if today is a holiday
    const holidayCheck = await pool.query(
      `SELECT holiday_name FROM holidays WHERE holiday_date = $1::date`, [dateStr]
    );

    const isHoliday = holidayCheck.rows.length > 0;
    const holidayReason = isHoliday ? holidayCheck.rows[0].holiday_name : null;

    // 2. Find all classes scheduled for today + Authorized Make-up sessions
    const schedules = await pool.query(`
      SELECT * FROM schedules s
	  WHERE ($1 = ANY(days) AND semester = $2 AND academic_year = $3) 
	  OR EXISTS (SELECT 1 FROM attendance a 
	  WHERE a.class_code = s.class_code AND a.class_date = $4::date AND a.attendance_status = 'PENDING')`, [dayName, semInfo.sem, semInfo.year, dateStr]
    );

    for (const sched of schedules.rows) {
      const [endHH, endMM] = sched.end_time.split(':');
      const classEnd = now.set({ hour: endHH, minute: endMM, second: 0 });

      // A. AUTOMATIC HOLIDAY TAGGING
      if (isHoliday) {
        // Tag everyone as HOLIDAY for this class if not already tagged
        await pool.query(`
          INSERT INTO attendance (class_date, class_code, student_id, attendance_status, reason, time_in)
          SELECT $1, $2, u.user_id, 'HOLIDAY', $3, '00:00:00'
          FROM sys_users u
          WHERE u.user_role IN ('student', 'officer')
          AND NOT EXISTS (
            SELECT 1 FROM attendance a 
            WHERE a.class_date = $1::date AND a.class_code = $2 AND a.student_id = u.user_id
          )
        `, [dateStr, sched.class_code, holidayReason]);
        
        continue; // Skip the rest of the logic for this class if it's a holiday
      }

      // B. REGULAR MAINTENANCE (Only if not a holiday)
      if (now > classEnd.plus({ minutes: 30 })) {
        // Mark missing students as ABSENT
        await pool.query(`
          INSERT INTO attendance (class_date, class_code, student_id, attendance_status, time_in)
          SELECT $1, $2, u.user_id, 'ABSENT', '00:00:00'
          FROM sys_users u
          WHERE u.user_role IN ('student', 'officer')
          AND NOT EXISTS (
            SELECT 1 FROM attendance a 
            WHERE a.class_date = $1::date AND a.class_code = $2 AND a.student_id = u.user_id
          )
        `, [dateStr, sched.class_code]);

        // Mark forgetful students as INCOMPLETE
        await pool.query(`
          UPDATE attendance 
          SET attendance_status = 'INCOMPLETE'
          WHERE class_date = $1::date AND class_code = $2 
          AND time_out IS NULL AND attendance_status IN ('PRESENT', 'LATE')
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
