# Attendance Checker

Attendance Checker is a full-stack web app for monitoring class attendance with role-based access for **students**, **professors**, and **officers**.

- **Frontend:** static app in `public/` (HTML/CSS/JS)
- **Backend:** Node.js + Express API in `server.js`
- **Database:** PostgreSQL

## Features

- Sign in / sign up flow by user ID + role
- Attendance status classification (on-time, late, absent)
- Student self-service attendance PDF export
- Professor live attendance dashboard + quick search
- Officer reporting tools + administrative actions
- Health and ping endpoints for monitoring

## Project Structure

```text
attendance-checker/
├── public/
│   ├── index.html
│   └── script.js
├── server.js
├── package.json
└── README.md
```

## Prerequisites

- Node.js 18+
- PostgreSQL database
- `DATABASE_URL` connection string

## Local Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Set environment variable:

   ```bash
   export DATABASE_URL="postgres://USER:PASSWORD@HOST:PORT/DBNAME"
   ```

3. Start the app:

   ```bash
   npm start
   ```

4. Open in browser:

   ```text
   http://localhost:3000
   ```

## Runtime Behavior

- Static frontend is served from `public/`.
- API requests are sent as `POST /api` with an `action` field.
- Readiness checks:
  - `GET /ping` → simple wake-up response
  - `GET /health` → checks DB connectivity

## Scripts

- `npm start` — run the server (`node server.js`)

## Notes

- The backend expects existing DB tables and seeded data.
- CORS is enabled in the Express server.
- SSL is enabled for PostgreSQL connections (configured in `server.js`).
