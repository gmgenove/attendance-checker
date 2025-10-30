# Attendance Checker Web App
A single-page attendance checker for one block section, integrated with Google Sheets via Apps Script backend.


---


## 📦 Repository Structure
```
attendance-checker/
│
├── index.html # Frontend SPA (HTML + JS + CSS)
├── README.md # Deployment & usage guide
└── backend/ # Optional folder for Google Apps Script source code
└── Code.gs
```


---


## 🚀 Features
- Student login via **Student ID + password** (no email)
- Daily schedule view for the block section
- Check-in button:
- Enabled 10 minutes before class start
- Within first 5 mins → **On-time**
- Between 5–10 mins → **Late**
- After 10 mins → **Absent** & button disabled
- Students can only check themselves in
- Professors can download class attendance by date
- Officers can generate attendance reports (class/date/person/week/semester)
- Students can view their own attendance
- Google Sheets used as data source


---


## 🧱 Google Sheet Structure


### 1. `Users`
| id | name | password_hash | role |
|-------------|------|----------------|------|
| 2023001 | Juan Dela Cruz | 9b74c9897bac770ffc029102a200c5de | student |
| prof001 | Prof. Reyes | 5e884898da28047151d0e56f8dc62927 | professor |
| officer01 | Ana Santos | e99a18c428cb38d5f260853678922e03 | officer |


### 2. `Schedule`
| class_code | class_name | day | start_time | end_time | professor_id |
|-------------|-------------|-----|-------------|-----------|---------------|
| IT101 | Intro to IT | Monday | 09:00 | 10:30 | prof001 |
| IT101 | Intro to IT | Thursday | 09:00 | 10:30 | prof001 |


### 3. `Roster`
| student_id | name |
|-------------|------|
| 2023001 | Juan Dela Cruz |
| 2023002 | Maria Santos |


### 4. `Attendance`
| date | class_code | student_id | status | time_in |
|------|-------------|-------------|---------|----------|
| 2025-10-25 | IT101 | 2023001 | On Time | 09:02 |


## 📤 Deployment Steps
1. Create Google Sheet with `Users`, `Schedule`, `Roster`, `Attendance` tabs.
2. Open Apps Script editor → paste `Code.gs`.
3. Deploy as Web App (`Execute as Me`, `Anyone` access).
4. From the Script Editor menu:
    - Select function → createDailyTriggerForScheduling
    - Click ▶️ Run (Authorize if needed)
5. Check your triggers:
    - Go to Triggers (clock icon) → You should see:
      - scheduleAutoTagTriggersForToday → daily, 6:00 AM
6. Copy the Web App URL and paste it in `index.html` under `API_BASE`.
7. Upload the `index.html` & `backend/Code.gs` to your GitHub repo.
8. Enable GitHub Pages (or connect to Render).
