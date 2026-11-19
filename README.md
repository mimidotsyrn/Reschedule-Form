# Reschedule App — Training Provider

Customer-facing RSVP + reschedule requests, with a provider admin page.
Node/Express backend with SQLite storage, ready to deploy on Railway.

## Pages

- `/` — Customer page: pick your booking, RSVP (attending / not attending + note), and submit a reschedule request with a new date.
- `/admin.html` — Provider admin: all bookings, latest RSVPs, and pending reschedule requests you can approve (moves the booking to the new date) or reject.

## Local run

```bash
npm install
npm start
# open http://localhost:3000
```

The database is `data.db` next to `server.js` (created and seeded automatically with 3 example Malaysian bookings).

## Deploy to Railway

1. Push this folder to a GitHub repo (or use `railway init` inside the folder with the Railway CLI).
2. In Railway, create a project from the repo — it detects Node and runs `npm start`.
3. Add a **Volume** mounted at `/data`, and set the variable `DB_PATH=/data/data.db` so bookings survive redeploys. (Without a volume, the database resets on each deploy.)
4. Open the deployed URL — customers use `/`, you use `/admin.html`.

> Note: the admin page has no login yet. Anyone with the URL can approve requests.
> Add authentication before using it with real customer data.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/bookings` | All bookings with customer + class info |
| POST | `/api/bookings/:id/rsvp` | Record RSVP `{ attending, note }` |
| POST | `/api/bookings/:id/reschedule` | Create reschedule request `{ new_date, reason }` |
| GET | `/api/reschedule-requests` | All requests (admin) |
| POST | `/api/reschedule-requests/:id/decide` | Approve/reject `{ decision }` |
| GET | `/api/rsvps` | Latest RSVPs (admin) |

All data is sample/seed data until real bookings are added.
