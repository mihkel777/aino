// Conversation store, populated by Vapi's end-of-call webhook. Newest first.
// Persisted via persist.js when DATABASE_URL is set (else in-memory).

import { markDirty } from "./persist.js";

let calls = [];
let counter = 0;

export const callStore = {
  add(record) {
    counter += 1;
    const call = {
      id: record.id || `c-${Date.now()}-${counter}`,
      createdAt: record.createdAt || new Date().toISOString(),
      caller: record.caller || "Tundmatu",
      durationSec: record.durationSec || 0,
      summary: record.summary || "",
      transcript: record.transcript || "",
      outcome: record.outcome || "",
      endedReason: record.endedReason || "",
      recordingUrl: record.recordingUrl || "",
      success: record.success ?? null,
      notes: [],
    };
    // Replace if we already have this call id (Vapi may resend); else prepend.
    calls = calls.filter((c) => c.id !== call.id);
    calls.unshift(call);
    if (calls.length > 500) calls.pop();
    markDirty();
    return call;
  },
  all() {
    return calls;
  },
  get(id) {
    return calls.find((c) => c.id === id) || null;
  },
  addNote(id, text) {
    const c = calls.find((x) => x.id === id);
    if (!c) return null;
    const note = { text, at: new Date().toISOString() };
    c.notes.push(note);
    markDirty();
    return note;
  },

  // Persistence hooks (used by persist.js).
  dump() {
    return { calls, counter };
  },
  load(d) {
    if (d && Array.isArray(d.calls)) calls = d.calls;
    if (d && typeof d.counter === "number") counter = d.counter;
  },
};
