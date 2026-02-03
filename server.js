const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const cors = require('cors');
const path = require('path');
const { DateTime } = require('luxon'); // Better timezone handling

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

// --- ROUTES ---

// 1. Get Today's Schedule
app.post('/api/today_schedule', async (req, res) => {
  try {
    const now = getManilaNow();
    const dayName = now.toFormat('ccc'); // Mon, Tue, etc.

    const query = `
      SELECT s.*, u.name as professor_name 
      FROM schedules s
      LEFT JOIN users u ON s.professor_id = u.id
      WHERE $1 = ANY(s.days)
    `;
    const result = await pool.query(query, [dayName]);
    
    // Format times for frontend
    const schedule = result.rows.map(row => ({
      ...row,
      start_time: row.start_time.slice(0, 5), // HH:mm
      end_time: row.end_time.slice(0, 5)
    }));

    res.json({ ok: true, schedule });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// 2. Check-in Logic
app.post('/api/checkin', async (req, res) => {
  const { class_code, student_id } = req.body;
  const now = getManilaNow();
  const dateStr = now.toISODate();

  try {
    // A. Check for existing attendance (Duplicate Prevention)
    const existing = await pool.query(
      'SELECT status FROM attendance WHERE date = $1 AND class_code = $2 AND student_id = $3',
      [dateStr, class_code, student_id]
    );

    if (existing.rows.length > 0) {
      return res.json({ ok: true, status: existing.rows[0].status, message: 'Already checked in' });
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
      'INSERT INTO attendance (date, class_code, student_id, status, time_in) VALUES ($1, $2, $3, $4, $5)',
      [dateStr, class_code, student_id, status, now.toFormat('HH:mm:ss')]
    );

    res.json({ ok: true, status, timestamp: now.toFormat('HH:mm:ss') });

  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// 3. Simple Router for all other actions
app.post('/api', async (req, res) => {
    const { action } = req.body;
    // Map other actions (signup, signin, etc.) here
    // Example: if (action === 'getConfig') return res.json(...)
});

const initDb = async () => {
  const queryText = `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, 
      name TEXT, 
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
      date DATE, 
      class_code TEXT REFERENCES schedules(class_code), 
      student_id TEXT REFERENCES users(id), 
      status TEXT, 
      time_in TIME, 
	  professor_id TEXT,
	  reason TEXT
      PRIMARY KEY (date, class_code, student_id)
    );
	
	CREATE TABLE IF NOT EXISTS roster (
      student_id TEXT PRIMARY KEY, 
      name TEXT
    );
	
	CREATE TABLE IF NOT EXISTS professors (
      professor_id TEXT PRIMARY KEY, 
      name TEXT
    );
	
	CREATE TABLE IF NOT EXISTS config (
      config_key TEXT PRIMARY KEY, 
      config_value TEXT,
	  description TEXT
    );
	
	INSERT INTO config (key, value, description) VALUES ('sem1_start', '2025-09-01', 'Start date of 1st semester');
	INSERT INTO config (key, value, description) VALUES ('sem1_end', '2026-01-17', 'End date of 1st semester');
	INSERT INTO config (key, value, description) VALUES ('sem1_adjustment_start', '2025-09-01', 'Adjustment period start (Sem 1)');
	INSERT INTO config (key, value, description) VALUES ('sem1_adjustment_end', '2025-11-30', 'Adjustment period end (Sem 1)');
	INSERT INTO config (key, value, description) VALUES ('sem2_start', '2026-02-09', 'Start date of 2nd semester');
	INSERT INTO config (key, value, description) VALUES ('sem2_end', '2026-06-21', 'End date of 2nd semester');
	INSERT INTO config (key, value, description) VALUES ('sem2_adjustment_start', '2026-02-09', 'Adjustment period start (Sem 2)');
	INSERT INTO config (key, value, description) VALUES ('sem2_adjustment_end', '2026-03-06', 'Adjustment period end (Sem 2)');
	INSERT INTO config (key, value, description) VALUES ('checkin_window_minutes', '10', 'Minutes before class check-in opens');
	INSERT INTO config (key, value, description) VALUES ('late_window_minutes', '5', 'Minutes after class start considered “late”');
	INSERT INTO config (key, value, description) VALUES ('absent_window_minutes', '20', 'Minutes after class start considered “absent”');
	INSERT INTO config (key, value, description) VALUES ('current_sem', 'auto', 'Use “auto” for automatic semester detection');
	INSERT INTO config (key, value, description) VALUES ('checkout_window_minutes', '10', 'Minutes before end of class, check-out opens');
	
	CREATE TABLE IF NOT EXISTS holidays (
      holiday_date DATE,
      holiday_name TEXT,
	  holiday_type TEXT
    );
	
	INSERT INTO config (holiday_date, holiday_name, holiday_type) VALUES ('2026-01-01', 'New Year's Day', 'Regular Holiday');
	INSERT INTO config (holiday_date, holiday_name, holiday_type) VALUES ('2026-04-02', 'Maundy Thursday', 'Regular Holiday');
	INSERT INTO config (holiday_date, holiday_name, holiday_type) VALUES ('2026-04-03', 'Good Friday', 'Regular Holiday');
	INSERT INTO config (holiday_date, holiday_name, holiday_type) VALUES ('2026-04-09', 'Araw ng Kagitingan', 'Regular Holiday');
	INSERT INTO config (holiday_date, holiday_name, holiday_type) VALUES ('2026-05-01', 'Labor Day', 'Regular Holiday');
	INSERT INTO config (holiday_date, holiday_name, holiday_type) VALUES ('2026-06-12', 'Independence Day', 'Regular Holiday');
	INSERT INTO config (holiday_date, holiday_name, holiday_type) VALUES ('2026-08-31', 'National Heroes Day', 'Regular Holiday');
	INSERT INTO config (holiday_date, holiday_name, holiday_type) VALUES ('2026-11-30', 'Bonifacio Day', 'Regular Holiday');
	INSERT INTO config (holiday_date, holiday_name, holiday_type) VALUES ('2026-12-25', 'Christmas Day', 'Regular Holiday');
	INSERT INTO config (holiday_date, holiday_name, holiday_type) VALUES ('2026-12-30', 'Rizal Day', 'Regular Holiday');
	INSERT INTO config (holiday_date, holiday_name, holiday_type) VALUES ('2026-08-21', 'Ninoy Aquino Day', 'Special Non-Working Holiday');
	INSERT INTO config (holiday_date, holiday_name, holiday_type) VALUES ('2026-11-01', 'All Saints' Day', 'Special Non-Working Holiday');
	INSERT INTO config (holiday_date, holiday_name, holiday_type) VALUES ('2026-12-08', 'Feast of the Immaculate Conception of Mary', 'Special Non-Working Holiday');
	INSERT INTO config (holiday_date, holiday_name, holiday_type) VALUES ('2026-12-31', 'Last Day of the Year', 'Special Non-Working Holiday');
	INSERT INTO config (holiday_date, holiday_name, holiday_type) VALUES ('2026-02-17', 'Chinese New Year', 'Special Non-Working Holiday');
	INSERT INTO config (holiday_date, holiday_name, holiday_type) VALUES ('2026-04-04', 'Black Saturday', 'Special Non-Working Holiday');
	INSERT INTO config (holiday_date, holiday_name, holiday_type) VALUES ('2026-11-02', 'All Souls' Day', 'Special Non-Working Holiday');
	INSERT INTO config (holiday_date, holiday_name, holiday_type) VALUES ('2026-12-24', 'Christmas Eve', 'Special Non-Working Holiday');
  `;
  try {
    await pool.query(queryText);
    console.log("✅ Database tables initialized successfully");
  } catch (err) {
    console.error("❌ Error initializing database:", err);
  }
};

// Call the migration script
initDb();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
