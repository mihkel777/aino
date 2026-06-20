// Optional durable persistence backed by Postgres (Render free tier / Neon / any).
// Stores the whole app state as a single JSON snapshot under kv['state'].
// Opt-in: if DATABASE_URL is unset, this is a no-op and the app stays in-memory.
//
// markDirty() is called by the stores on every mutation; a small interval writes
// the snapshot only when something changed, keeping DB usage tiny.
//
// Cycle-safe: this module imports the stores and they import markDirty(), but
// markDirty is a hoisted function only invoked at runtime (never at import).

import pg from "pg";
import { restaurant } from "./config.js";
import { store } from "./store.js";
import { callStore } from "./calls.js";

const { Pool } = pg;

let pool = null;
let dirty = false;
let saving = false;

export function markDirty() {
  dirty = true;
}

function snapshot() {
  return { config: restaurant, bookings: store.dump(), calls: callStore.dump() };
}

function hydrate(state) {
  if (!state || typeof state !== "object") return;
  if (state.config && typeof state.config === "object") Object.assign(restaurant, state.config);
  if (state.bookings) store.load(state.bookings);
  if (state.calls) callStore.load(state.calls);
}

async function save() {
  if (!pool || saving || !dirty) return;
  saving = true;
  dirty = false;
  try {
    await pool.query(
      "INSERT INTO kv(key,value) VALUES('state',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=$1::jsonb",
      [JSON.stringify(snapshot())]
    );
  } catch (e) {
    console.error("[persist] save error:", e.message);
    dirty = true; // retry next tick
  } finally {
    saving = false;
  }
}

export async function initPersistence() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("[persist] no DATABASE_URL — in-memory only");
    return;
  }
  try {
    const ssl = /render\.com/.test(url) ? { rejectUnauthorized: false } : false;
    pool = new Pool({ connectionString: url, ssl });
    await pool.query("CREATE TABLE IF NOT EXISTS kv (key text primary key, value jsonb)");
    const r = await pool.query("SELECT value FROM kv WHERE key='state'");
    if (r.rows[0]) {
      hydrate(r.rows[0].value);
      console.log("[persist] loaded state from Postgres");
    } else {
      console.log("[persist] connected to Postgres (empty, starting fresh)");
    }
    setInterval(save, 3000);
  } catch (e) {
    console.error("[persist] init failed, falling back to in-memory:", e.message);
    pool = null;
  }
}
