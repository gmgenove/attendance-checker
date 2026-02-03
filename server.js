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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
