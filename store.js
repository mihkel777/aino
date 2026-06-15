// In-memory booking store. Zero setup, resets on restart, perfect for the demo.
// To make bookings appear in a real Google Calendar, implement the same three
// methods against the Calendar API in a calendar.js and swap `store` for it.

import { slotIsWithinHours } from "./config.js";

let bookings = [];
let counter = 1000;

function seatsAt(date, time) {
  return bookings
    .filter((b) => b.date === date && b.time === time)
    .reduce((sum, b) => sum + b.partySize, 0);
}

export const store = {
  countSeatsAt(date, time) {
    return seatsAt(date, time);
  },

  addBooking({ date, time, partySize, name, phone }) {
    counter += 1;
    const id = `K${counter}`;
    const booking = { id, date, time, partySize, name, phone, createdAt: new Date().toISOString() };
    bookings.push(booking);
    return booking;
  },

  allBookings() {
    return [...bookings].sort((a, b) =>
      a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date)
    );
  },

  // Suggest up to 2 nearby free slots (same day) so the agent can offer alternatives.
  nearbyFreeSlots(date, time, partySize, restaurant) {
    const [h, m] = time.split(":").map(Number);
    const base = h * 60 + m;
    const step = restaurant.slotMinutes;
    const out = [];
    for (let delta = step; delta <= 120 && out.length < 2; delta += step) {
      for (const cand of [base - delta, base + delta]) {
        if (cand < 0 || cand >= 24 * 60) continue;
        const hh = String(Math.floor(cand / 60)).padStart(2, "0");
        const mm = String(cand % 60).padStart(2, "0");
        const t = `${hh}:${mm}`;
        if (!slotIsWithinHours(date, t)) continue;
        if (restaurant.capacity - seatsAt(date, t) >= partySize && !out.includes(t)) {
          out.push(t);
        }
      }
    }
    return out.sort();
  },
};
