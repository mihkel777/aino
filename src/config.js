// Restaurant configuration. In the demo there is one restaurant; in the real
// product each business has its own stored config. The manager edits these
// values in the dashboard (POST /api/config), which persists them to a JSON
// file and (best-effort) syncs the Vapi assistant.
//
// `restaurant` is a mutable object exported as a live binding: updateConfig()
// mutates it in place with Object.assign, so every importer (server.js, the
// restaurant passed into store.js) sees changes without re-importing.

import fs from "fs";
import path from "path";
import { markDirty } from "./persist.js";

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(process.cwd(), "config.json");

const defaults = {
  name: "Noa",
  capacity: 24, // total seats bookable per time slot
  maxPartySize: 8, // larger groups -> redirect to web form
  // Opening hours per weekday (0 = Sunday ... 6 = Saturday). null = closed.
  hours: {
    0: { open: "12:00", close: "21:00" },
    1: null, // Monday closed
    2: { open: "12:00", close: "22:00" },
    3: { open: "12:00", close: "22:00" },
    4: { open: "12:00", close: "22:00" },
    5: { open: "12:00", close: "23:00" },
    6: { open: "12:00", close: "23:00" },
  },
  slotMinutes: 30, // booking granularity
  greetingTone: "soe", // otsekohene | soe | ametlik | hõivatud
  faqs: [], // [{ q, a }] knowledge the assistant can answer
  tasks: [], // ["kui X, siis tee Y"] action instructions
};

export const TONES = ["otsekohene", "soe", "ametlik", "hõivatud"];

export const restaurant = structuredClone(defaults);

// ---- persistence ---------------------------------------------------------

function loadFromDisk() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const saved = JSON.parse(raw);
    Object.assign(restaurant, saved);
  } catch {
    // no saved config yet (first run) -> keep defaults
  }
}
loadFromDisk();

function persist() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(restaurant, null, 2));
  } catch (e) {
    console.error("Could not write config.json:", e.message);
  }
}

// ---- validation ----------------------------------------------------------

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function isPosInt(n) {
  return Number.isInteger(n) && n > 0;
}

// Validate a partial config patch. Throws Error(message) on the first problem.
export function validateConfig(patch) {
  if (patch.name !== undefined && (typeof patch.name !== "string" || !patch.name.trim())) {
    throw new Error("Restorani nimi ei tohi olla tühi.");
  }
  if (patch.capacity !== undefined && !isPosInt(patch.capacity)) {
    throw new Error("Kohtade arv peab olema positiivne täisarv.");
  }
  if (patch.maxPartySize !== undefined && !isPosInt(patch.maxPartySize)) {
    throw new Error("Maksimaalne seltskonna suurus peab olema positiivne täisarv.");
  }
  if (patch.slotMinutes !== undefined && ![15, 30, 60].includes(patch.slotMinutes)) {
    throw new Error("Broneeringu samm peab olema 15, 30 või 60 minutit.");
  }
  if (patch.hours !== undefined) {
    if (typeof patch.hours !== "object" || patch.hours === null) {
      throw new Error("Lahtiolekuajad on vigased.");
    }
    for (const [day, h] of Object.entries(patch.hours)) {
      if (h === null) continue; // closed that day
      if (typeof h !== "object" || !HHMM.test(h.open || "") || !HHMM.test(h.close || "")) {
        throw new Error(`Vigane kellaaeg (päev ${day}). Kasuta kuju HH:MM.`);
      }
      if (toMinutes(h.open) >= toMinutes(h.close)) {
        throw new Error(`Avamisaeg peab olema enne sulgemisaega (päev ${day}).`);
      }
    }
  }
  if (patch.greetingTone !== undefined && !TONES.includes(patch.greetingTone)) {
    throw new Error("Tundmatu tervituse toon.");
  }
  if (patch.faqs !== undefined) {
    if (!Array.isArray(patch.faqs)) throw new Error("KKK on vigane.");
    if (patch.faqs.length > 50) throw new Error("Liiga palju küsimusi (max 50).");
    for (const f of patch.faqs) {
      if (!f || typeof f.q !== "string" || typeof f.a !== "string" || !f.q.trim() || !f.a.trim()) {
        throw new Error("Iga KKK kirje vajab nii küsimust kui vastust.");
      }
      if (f.q.length > 300 || f.a.length > 1000) {
        throw new Error("KKK küsimus või vastus on liiga pikk.");
      }
    }
  }
  if (patch.tasks !== undefined) {
    if (!Array.isArray(patch.tasks)) throw new Error("Ülesanded on vigased.");
    if (patch.tasks.length > 50) throw new Error("Liiga palju ülesandeid (max 50).");
    for (const t of patch.tasks) {
      if (typeof t !== "string" || !t.trim()) throw new Error("Ülesanne ei tohi olla tühi.");
      if (t.length > 500) throw new Error("Ülesanne on liiga pikk.");
    }
  }
  return true;
}

// Validate, merge into the live `restaurant`, persist. Returns the new config.
export function updateConfig(patch) {
  validateConfig(patch);
  // Merge hours per-day rather than wholesale, so a patch can set one weekday.
  const next = { ...patch };
  if (patch.hours) {
    next.hours = { ...restaurant.hours, ...patch.hours };
  }
  Object.assign(restaurant, next);
  persist();
  markDirty();
  return restaurant;
}

// ---- helpers (read from the live `restaurant`) ---------------------------

export function openingHoursFor(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay();
  return restaurant.hours[day] || null;
}

export function slotIsWithinHours(dateStr, time) {
  const hrs = openingHoursFor(dateStr);
  if (!hrs) return false;
  const t = toMinutes(time);
  // last seating must be before close
  return t >= toMinutes(hrs.open) && t <= toMinutes(hrs.close) - restaurant.slotMinutes;
}
