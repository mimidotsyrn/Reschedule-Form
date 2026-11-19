const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json());

// Database: a single file. On Railway, mount a volume at /data so it survives
// redeploys; locally it just lives next to the code.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    location TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    class_id INTEGER NOT NULL REFERENCES classes(id),
    class_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS rsvps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL REFERENCES bookings(id),
    attending INTEGER NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS reschedule_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL REFERENCES bookings(id),
    new_date TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    decided_at TEXT
  );
`);

// Seed example data (Malaysian training provider) so the app is never empty.
const classCount = db.prepare('SELECT COUNT(*) AS n FROM classes').get().n;
if (classCount === 0) {
  const seed = db.transaction(() => {
    const insClass = db.prepare('INSERT INTO classes (name, location) VALUES (?, ?)');
    const c1 = insClass.run('HRD Corp Claimable Course — Effective Workplace Communication (2 Days)', 'Menara ILMU Training Centre, Jalan Sultan Ismail, Kuala Lumpur').lastInsertRowid;
    const c2 = insClass.run('OSHA 1994 Awareness & Safe Work Practices (1 Day)', 'Wisma Training Penang, Jalan Burma, George Town, Pulau Pinang').lastInsertRowid;
    const c3 = insClass.run('Financial Reporting & SST Compliance Update (2 Days)', 'Menara ILMU Training Centre, Jalan Sultan Ismail, Kuala Lumpur').lastInsertRowid;

    const insCust = db.prepare('INSERT OR IGNORE INTO customers (name, email) VALUES (?, ?)');
    const insBooking = db.prepare('INSERT INTO bookings (customer_id, class_id, class_date) VALUES (?, ?, ?)');
    insBooking.run(insCust.run('Nurul Aisyah binti Roslan', 'nurul.aisyah@example.my').lastInsertRowid, c1, '2026-12-07');
    insBooking.run(insCust.run('Muhammad Faiz bin Kamaruddin', 'faiz.kamaruddin@example.my').lastInsertRowid, c2, '2026-11-30');
    insBooking.run(insCust.run('Siti Halimah binti Ahmad Sabri', 'siti.halimah@example.my').lastInsertRowid, c3, '2026-12-03');
  });
  seed();
}

// ---- API ----

// All bookings joined with customer + class info
app.get('/api/bookings', (req, res) => {
  const rows = db.prepare(`
    SELECT b.id, b.class_date, b.status,
           cu.name AS customer_name, cu.email AS customer_email,
           cl.name AS class_name, cl.location
    FROM bookings b
    JOIN customers cu ON cu.id = b.customer_id
    JOIN classes cl ON cl.id = b.class_id
    ORDER BY b.class_date
  `).all();
  res.json(rows);
});

// Record an RSVP (attending yes/no + note) for a booking
app.post('/api/bookings/:id/rsvp', (req, res) => {
  const booking = db.prepare('SELECT id FROM bookings WHERE id = ?').get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const attending = req.body.attending ? 1 : 0;
  const note = (req.body.note || '').slice(0, 500);
  const info = db.prepare('INSERT INTO rsvps (booking_id, attending, note) VALUES (?, ?, ?)')
    .run(booking.id, attending, note);
  res.json({ ok: true, rsvp_id: info.lastInsertRowid });
});

// Request a reschedule for a booking
app.post('/api/bookings/:id/reschedule', (req, res) => {
  const booking = db.prepare('SELECT id FROM bookings WHERE id = ?').get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (!req.body.new_date) return res.status(400).json({ error: 'new_date is required' });
  const info = db.prepare(
    'INSERT INTO reschedule_requests (booking_id, new_date, reason) VALUES (?, ?, ?)'
  ).run(booking.id, req.body.new_date, (req.body.reason || '').slice(0, 500));
  res.json({ ok: true, request_id: info.lastInsertRowid });
});

// Admin: list reschedule requests with context
app.get('/api/reschedule-requests', (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.new_date, r.reason, r.status, r.created_at,
           b.class_date AS original_date,
           cu.name AS customer_name, cu.email AS customer_email,
           cl.name AS class_name
    FROM reschedule_requests r
    JOIN bookings b ON b.id = r.booking_id
    JOIN customers cu ON cu.id = b.customer_id
    JOIN classes cl ON cl.id = b.class_id
    ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC
  `).all();
  res.json(rows);
});

// Admin: approve / reject a reschedule request; approval moves the booking date
app.post('/api/reschedule-requests/:id/decide', (req, res) => {
  const row = db.prepare('SELECT id, booking_id, status FROM reschedule_requests WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Request not found' });
  if (row.status !== 'pending') return res.status(400).json({ error: 'Already decided' });
  const decision = req.body.decision === 'approve' ? 'approved' : 'rejected';
  const tx = db.transaction(() => {
    db.prepare("UPDATE reschedule_requests SET status = ?, decided_at = datetime('now') WHERE id = ?")
      .run(decision, row.id);
    if (decision === 'approved') {
      db.prepare('UPDATE bookings SET class_date = ?, status = ? WHERE id = ?')
        .run(req.body.new_date, 'rescheduled', row.booking_id);
    }
  });
  tx();
  res.json({ ok: true, status: decision });
});

// Latest RSVP per booking (for the admin list)
app.get('/api/rsvps', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, b.id AS booking_id, cu.name AS customer_name
    FROM rsvps r
    JOIN bookings b ON b.id = r.booking_id
    JOIN customers cu ON cu.id = b.customer_id
    ORDER BY r.created_at DESC
  `).all();
  res.json(rows);
});

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Reschedule app listening on port ' + PORT));
