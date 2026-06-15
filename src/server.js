// Aino voice agent backend, restaurant table booking.
// Exposes the tools the voice agent (Claude via Vapi) calls during a live call:
//   POST /tools/check-availability
//   POST /tools/book-table
// Plus a tiny dashboard at GET / to watch bookings land live during the demo.
//
// Booking store: in-memory by default (zero setup), with a clean seam to swap in
// Google Calendar (see calendar.js) so the organiser can watch an event appear.

import express from "express";
import { restaurant, openingHoursFor, slotIsWithinHours } from "./config.js";
import { store } from "./store.js";

const app = express();
app.use(express.json());

// ---- helpers -------------------------------------------------------------

// Normalise a spoken/loose time into HH:MM 24h. Accepts "19:30", "19.30", "7", "19".
function normaliseTime(t) {
  if (!t) return null;
  const cleaned = String(t).trim().replace(".", ":");
  const m = cleaned.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

// Accept YYYY-MM-DD, or pass through if already a date the model resolved.
function normaliseDate(d) {
  if (!d) return null;
  const s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null; // force the model to send ISO dates; we tell it to in the prompt
}

// The id Vapi assigns to a tool call; we must echo it back so Vapi can match the
// result to the call. Vapi sends it on both toolCalls[] and the flattened
// toolCallList[]. Absent on the bare-body local curl tests -> null.
function toolCallId(req) {
  return (
    req.body?.message?.toolCalls?.[0]?.id ??
    req.body?.message?.toolCallList?.[0]?.id ??
    null
  );
}

function ok(res, id, payload) {
  // Vapi requires { results: [{ toolCallId, result }] } and ignores anything else.
  // For the local curl tests (no tool call id) keep a readable { result } body.
  if (id) return res.json({ results: [{ toolCallId: id, result: payload }] });
  return res.json({ result: payload });
}

// Extract the tool arguments regardless of shape. Vapi sends both toolCalls[]
// (OpenAI-style; `function.arguments` may be a JSON-encoded string) and the
// flattened toolCallList[] (`arguments` already a parsed object); we also accept
// a bare body for the local curl tests. Handle all of them.
function toolArgs(req) {
  let raw =
    req.body?.message?.toolCalls?.[0]?.function?.arguments ??
    req.body?.message?.toolCallList?.[0]?.arguments ??
    req.body ??
    {};
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" ? raw : {};
}

// ---- tool: check availability -------------------------------------------

app.post("/tools/check-availability", (req, res) => {
  const id = toolCallId(req);
  const args = toolArgs(req);
  const date = normaliseDate(args.date);
  const time = normaliseTime(args.time);
  const partySize = parseInt(args.partySize ?? args.party_size, 10);

  if (!date || !time || !Number.isFinite(partySize)) {
    return ok(res, id, "Vajan broneeringuks kuupäeva (YYYY-MM-DD), kellaaega ja inimeste arvu.");
  }

  if (partySize > restaurant.maxPartySize) {
    return ok(
      res,
      id,
      `Suuremate seltskondade jaoks kui ${restaurant.maxPartySize} inimest palun broneerige meie kodulehel. Kas saan aidata väiksema lauaga?`
    );
  }

  if (!slotIsWithinHours(date, time)) {
    const hrs = openingHoursFor(date);
    return ok(
      res,
      id,
      hrs
        ? `Sel ajal oleme suletud. Sel päeval oleme avatud ${hrs.open} kuni ${hrs.close}.`
        : `Sel päeval oleme suletud.`
    );
  }

  const taken = store.countSeatsAt(date, time);
  const free = restaurant.capacity - taken;
  if (free >= partySize) {
    return ok(res, id, { available: true, date, time, partySize });
  }

  // Offer the nearest alternatives so the agent can keep the conversation moving.
  const alts = store.nearbyFreeSlots(date, time, partySize, restaurant);
  return ok(res, id, {
    available: false,
    date,
    time,
    alternatives: alts, // e.g. ["18:30","20:30"]
  });
});

// ---- tool: book table ----------------------------------------------------

app.post("/tools/book-table", (req, res) => {
  const id = toolCallId(req);
  const args = toolArgs(req);
  const date = normaliseDate(args.date);
  const time = normaliseTime(args.time);
  const partySize = parseInt(args.partySize ?? args.party_size, 10);
  const name = (args.name || "").toString().trim();
  const phone = (args.phone || "").toString().trim();

  if (!date || !time || !Number.isFinite(partySize) || !name) {
    return ok(res, id, "Broneeringuks vajan kuupäeva, kellaaega, inimeste arvu ja nime.");
  }

  // Re-check capacity at write time (the slot may have filled mid-call).
  const taken = store.countSeatsAt(date, time);
  if (restaurant.capacity - taken < partySize) {
    const alts = store.nearbyFreeSlots(date, time, partySize, restaurant);
    return ok(res, id, { booked: false, reason: "full", alternatives: alts });
  }

  const booking = store.addBooking({ date, time, partySize, name, phone });
  return ok(res, id, {
    booked: true,
    confirmation: booking.id,
    date,
    time,
    partySize,
    name,
  });
});

// ---- live dashboard (for the demo) --------------------------------------

app.get("/", (_req, res) => {
  const bookings = store.allBookings();
  res.send(`<!doctype html><html lang="et"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${restaurant.name} broneeringud</title>
  <style>
    body{font-family:system-ui,sans-serif;background:#0f1f33;color:#eaf0f7;margin:0;padding:2rem;}
    h1{font-weight:700;margin:0 0 .25rem;} .sub{color:#9fb3cc;margin:0 0 1.5rem;}
    table{width:100%;border-collapse:collapse;background:#17304d;border-radius:10px;overflow:hidden;}
    th,td{padding:.75rem 1rem;text-align:left;border-bottom:1px solid #21456e;font-size:.95rem;}
    th{background:#1d4e89;font-weight:600;} tr:last-child td{border-bottom:none;}
    .empty{color:#9fb3cc;padding:2rem;text-align:center;}
    .pill{background:#2a9d8f;color:#fff;border-radius:999px;padding:.1rem .5rem;font-size:.8rem;}
  </style></head><body>
  <h1>${restaurant.name}</h1>
  <p class="sub">Broneeringud reaalajas · ${bookings.length} kokku · värskendab automaatselt</p>
  ${
    bookings.length === 0
      ? `<div class="empty">Veel broneeringuid pole. Helista ja broneeri laud!</div>`
      : `<table><tr><th>Kinnitus</th><th>Nimi</th><th>Kuupäev</th><th>Kell</th><th>Inimesi</th></tr>${bookings
          .map(
            (b) =>
              `<tr><td><span class="pill">${b.id}</span></td><td>${b.name}</td><td>${b.date}</td><td>${b.time}</td><td>${b.partySize}</td></tr>`
          )
          .join("")}</table>`
  }
  <script>setTimeout(()=>location.reload(),4000)</script>
  </body></html>`);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Aino booking backend on :${PORT}`));
