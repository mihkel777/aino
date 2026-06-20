// Aino backend + restaurant manager dashboard.
// Exposes the tools the voice agent (Claude via Vapi) calls during a live call:
//   POST /tools/check-availability
//   POST /tools/book-table
// Plus the manager console at GET / (configure the bot, test-call it, watch
// bookings) and a small JSON API (GET/POST /api/config, GET /api/bookings).
//
// Booking store: in-memory (resets on restart). Config persists to config.json.

import express from "express";
import {
  restaurant,
  openingHoursFor,
  slotIsWithinHours,
  validateConfig,
  updateConfig,
  TONES,
} from "./config.js";
import { hoursSummary, buildSystemPrompt, buildFirstMessage } from "./vapi-assistant.js";
import { store } from "./store.js";
import { callStore } from "./calls.js";
import { initPersistence } from "./persist.js";
import { sendBookingSms } from "./sms.js";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "2mb" })); // transcripts in webhook payloads can be largish
app.use(express.urlencoded({ extended: false })); // login form

// ---- auth gate (opt-in via DASHBOARD_PASSWORD) ---------------------------
// Protects the dashboard + data APIs (caller PII). Endpoints Vapi calls
// (/tools/*, /vapi/webhook) stay open. If no password is set, the gate is off.

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

function authToken() {
  return crypto.createHmac("sha256", "aino-auth").update(DASHBOARD_PASSWORD || "").digest("hex");
}

function isAuthed(req) {
  if (!DASHBOARD_PASSWORD) return true; // gate disabled
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)aino_auth=([a-f0-9]+)/);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(authToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const OPEN_PATHS = new Set(["/vapi/webhook", "/login", "/logout", "/demo"]);

app.use((req, res, next) => {
  if (req.path.startsWith("/tools/") || OPEN_PATHS.has(req.path)) return next();
  if (isAuthed(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ ok: false, error: "Sisselogimine nõutav." });
  return res.redirect("/login");
});

// ---- login / logout ------------------------------------------------------

app.get("/login", (req, res) => {
  if (isAuthed(req)) return res.redirect("/");
  const err = req.query.e ? `<p class="err">Vale parool.</p>` : "";
  res.send(`<!doctype html><html lang="et"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><title>Aino — logi sisse</title>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400&family=Inter:wght@400;500&display=swap" rel="stylesheet">
  <style>
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0c0d0b;color:#ece7db;font-family:'Inter',system-ui,sans-serif;}
    .box{width:320px;max-width:90vw;text-align:center;}
    h1{font-family:'Fraunces',serif;font-weight:400;font-size:2.2rem;margin:0 0 1.4rem;}
    input{width:100%;background:#121310;border:1px solid rgba(236,231,219,.12);color:#ece7db;border-radius:10px;padding:.7rem .8rem;font:inherit;font-size:1rem;margin-bottom:.7rem;}
    input:focus{outline:none;border-color:#c9a96a;}
    button{width:100%;background:#c9a96a;color:#1a1407;border:0;border-radius:10px;padding:.75rem;font:inherit;font-weight:600;cursor:pointer;}
    .err{color:#e6a07f;font-size:.9rem;margin:0 0 .7rem;}
  </style></head><body>
  <form class="box" method="POST" action="/login">
    <h1>Aino</h1>${err}
    <input type="password" name="password" placeholder="Parool" autofocus autocomplete="current-password">
    <button type="submit">Logi sisse</button>
  </form></body></html>`);
});

app.post("/login", (req, res) => {
  if (!DASHBOARD_PASSWORD) return res.redirect("/");
  const given = Buffer.from(String(req.body?.password || ""));
  const real = Buffer.from(DASHBOARD_PASSWORD);
  const ok = given.length === real.length && crypto.timingSafeEqual(given, real);
  if (!ok) return res.redirect("/login?e=1");
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.cookie("aino_auth", authToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  res.redirect("/");
});

app.get("/logout", (_req, res) => {
  res.clearCookie("aino_auth");
  res.redirect("/login");
});

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

// Escape user-supplied text (e.g. a spoken name) before putting it in HTML.
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
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
  // Prefer a phone the assistant captured; fall back to the live caller's number.
  const phone = (args.phone || req.body?.message?.call?.customer?.number || "").toString().trim();

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
  // Fire-and-forget SMS confirmation (never blocks the agent's reply).
  sendBookingSms(booking, restaurant)
    .then((r) => console.log(r.sent ? `[sms] sent to ${phone}` : `[sms] skipped: ${r.reason}`))
    .catch(() => {});
  return ok(res, id, {
    booked: true,
    confirmation: booking.id,
    date,
    time,
    partySize,
    name,
  });
});

// ---- bookings feed (powers the live panel on the demo page) -------------

app.get("/api/bookings", (_req, res) => {
  res.json({ bookings: store.allBookings() });
});

// ---- Vapi end-of-call webhook (feeds Conversations) ---------------------
// Configure this URL as the assistant's Server URL in Vapi, with a secret.
// We verify the secret (NOT the account key) -> zero-key posture preserved.

function parseEndOfCall(msg) {
  const call = msg.call || {};
  const analysis = msg.analysis || {};
  const artifact = msg.artifact || {};
  let durationSec = 0;
  if (typeof msg.durationSeconds === "number") durationSec = Math.round(msg.durationSeconds);
  else if (typeof msg.durationMs === "number") durationSec = Math.round(msg.durationMs / 1000);
  const transcript = msg.transcript || artifact.transcript || "";
  const caller =
    (msg.customer && msg.customer.number) || (call.customer && call.customer.number) || "Tundmatu";
  const sd = analysis.structuredData || {};
  return {
    id: call.id || msg.callId,
    createdAt: msg.startedAt || call.startedAt || new Date().toISOString(),
    caller,
    durationSec,
    summary: msg.summary || analysis.summary || "",
    transcript: typeof transcript === "string" ? transcript : JSON.stringify(transcript),
    outcome: sd.outcome || sd.topic || "",
    success: analysis.successEvaluation ?? null,
    endedReason: msg.endedReason || "",
    recordingUrl: msg.recordingUrl || artifact.recordingUrl || "",
  };
}

// GET is just a reachability check (open it in a browser to confirm it's live).
app.get("/vapi/webhook", (_req, res) => {
  res.json({
    ok: true,
    hint: "Vapi peab siia POSTima 'end-of-call-report' sõnumi.",
    secretRequired: !!process.env.VAPI_WEBHOOK_SECRET,
  });
});

app.post("/vapi/webhook", (req, res) => {
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  const got = req.get("x-vapi-secret");
  const msg = req.body?.message || req.body || {};
  if (secret && got !== secret) {
    console.warn(`[vapi/webhook] 401 secret mismatch (header present: ${got ? "yes" : "no"}), type=${msg.type}`);
    return res.status(401).json({ ok: false });
  }
  console.log(`[vapi/webhook] received type=${msg.type || "(none)"}`);
  if (msg.type === "end-of-call-report") {
    try {
      const c = callStore.add(parseEndOfCall(msg));
      console.log(`[vapi/webhook] stored call ${c.id} from ${c.caller}`);
    } catch (e) {
      console.error("[vapi/webhook] parse error:", e.message);
    }
  }
  res.json({ ok: true }); // Vapi ignores non-200
});

// ---- conversations API (powers the Vestlused screen) --------------------

app.get("/api/calls", (_req, res) => {
  res.json({
    calls: callStore.all().map((c) => ({
      id: c.id,
      createdAt: c.createdAt,
      caller: c.caller,
      durationSec: c.durationSec,
      summary: c.summary,
      outcome: c.outcome,
      success: c.success,
      noteCount: c.notes.length,
    })),
  });
});

app.get("/api/calls/:id", (req, res) => {
  const c = callStore.get(req.params.id);
  if (!c) return res.status(404).json({ ok: false });
  res.json(c);
});

app.post("/api/calls/:id/notes", (req, res) => {
  const text = (req.body?.text || "").toString().trim();
  if (!text) return res.status(400).json({ ok: false, error: "Märkus on tühi." });
  const note = callStore.addNote(req.params.id, text);
  if (!note) return res.status(404).json({ ok: false });
  res.json({ ok: true, note });
});

// ---- config API (manager dashboard reads/writes restaurant settings) ----

app.get("/api/config", (_req, res) => {
  res.json(restaurant);
});

app.post("/api/config", (req, res) => {
  try {
    validateConfig(req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  const config = updateConfig(req.body);
  // Booking rules apply immediately (the tools read this config). The assistant's
  // spoken prompt lives in Vapi; return the regenerated text for the manager to
  // copy/paste there when they change the name — no API key held server-side.
  res.json({
    ok: true,
    config,
    assistant: {
      systemPrompt: buildSystemPrompt(config),
      firstMessage: buildFirstMessage(config),
    },
  });
});

// The earlier shareable demo link now lives inside the dashboard; keep it working.
app.get("/demo", (_req, res) => res.redirect(302, "/"));

// ---- manager dashboard (the product: configure, test, watch bookings) ---

app.get("/", (_req, res) => {
  const bookings = store.allBookings();
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = bookings.filter((b) => b.date === today).length;
  const publicKey = process.env.VAPI_PUBLIC_KEY;
  const assistantId = process.env.VAPI_ASSISTANT_ID;
  const ready = !!(publicKey && assistantId);
  const name = esc(restaurant.name);

  // ---- analytics (Phase 3) ----
  const allCalls = callStore.all();
  const totalCallSec = allCalls.reduce((a, c) => a + (c.durationSec || 0), 0);
  const fmtCallTime = (sec) => {
    const m = Math.round(sec / 60);
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)} h ${m % 60} min`;
  };
  const evaluated = allCalls.filter((c) => c.success === true || c.success === false);
  const satPct = evaluated.length
    ? `${Math.round((100 * evaluated.filter((c) => c.success === true).length) / evaluated.length)}%`
    : "—";
  // 14-day call volume (bars)
  const days14 = [...Array(14)].map((_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - i));
    return d.toISOString().slice(0, 10);
  });
  const byDay = {};
  allCalls.forEach((c) => {
    const d = (c.createdAt || "").slice(0, 10);
    byDay[d] = (byDay[d] || 0) + 1;
  });
  const counts = days14.map((d) => byDay[d] || 0);
  const maxC = Math.max(1, ...counts);
  const CW = 640, CH = 150, GAP = 6, BW = (CW - GAP * 13) / 14;
  const chartBars = counts
    .map((c, i) => {
      const h = Math.round((c / maxC) * (CH - 28));
      const x = i * (BW + GAP);
      const y = CH - h - 18;
      const label = i % 2 === 0 ? `<text x="${(x + BW / 2).toFixed(1)}" y="${CH - 4}" text-anchor="middle" font-size="9" fill="#6f6a60">${days14[i].slice(8, 10)}.${days14[i].slice(5, 7)}</text>` : "";
      const val = c > 0 ? `<text x="${(x + BW / 2).toFixed(1)}" y="${y - 3}" text-anchor="middle" font-size="10" fill="#9c968a">${c}</text>` : "";
      return `<rect x="${x.toFixed(1)}" y="${y}" width="${BW.toFixed(1)}" height="${h}" rx="3" fill="#c9a96a" opacity="0.9"></rect>${val}${label}`;
    })
    .join("");
  const chartSvg = `<svg viewBox="0 0 ${CW} ${CH}" width="100%" style="max-width:100%;display:block">${chartBars}</svg>`;

  const DAYS = [[1, "Esmaspäev"], [2, "Teisipäev"], [3, "Kolmapäev"], [4, "Neljapäev"], [5, "Reede"], [6, "Laupäev"], [0, "Pühapäev"]];
  const dayRows = DAYS.map(([d, label]) => {
    const h = restaurant.hours[d];
    const open = !!h;
    return `<div class="dayrow" data-day="${d}"><span class="dayname">${label}</span><label class="sw"><input type="checkbox" class="open-toggle" ${open ? "checked" : ""}> Avatud</label><input type="time" class="open" value="${open ? h.open : "12:00"}" ${open ? "" : "disabled"}><span class="dash">–</span><input type="time" class="close" value="${open ? h.close : "22:00"}" ${open ? "" : "disabled"}></div>`;
  }).join("");
  const slotOpts = [15, 30, 60].map((m) => `<option value="${m}"${restaurant.slotMinutes === m ? " selected" : ""}>${m} min</option>`).join("");
  const TONE_LABELS = { otsekohene: "Otsekohene", soe: "Soe ja sõbralik", ametlik: "Ametlik", hõivatud: "Hõivatud, abivalmis" };
  const toneBtns = TONES.map((t) => `<button type="button" class="toneb${restaurant.greetingTone === t ? " active" : ""}" data-tone="${t}">${TONE_LABELS[t] || t}</button>`).join("");
  const faqRows = (restaurant.faqs || []).map((f) => `<div class="faqrow"><input type="text" class="faq-q" placeholder="Küsimus" value="${esc(f.q)}"><input type="text" class="faq-a" placeholder="Vastus" value="${esc(f.a)}"><button type="button" class="rmrow" aria-label="Eemalda">×</button></div>`).join("");
  const taskRows = (restaurant.tasks || []).map((t) => `<div class="taskrow"><input type="text" class="task-t" placeholder="Nt: kui klient küsib parkimist, paku Google Mapsi linki" value="${esc(t)}"><button type="button" class="rmrow" aria-label="Eemalda">×</button></div>`).join("");
  const assistantText = esc(`${buildSystemPrompt(restaurant)}\n\n--- Esimene lause (First Message) ---\n${buildFirstMessage(restaurant)}`);

  const bars = Array.from({ length: 22 }).map(() => '<span class="bar"></span>').join("");
  const testInner = ready
    ? `<p class="lead">Proovi assistenti ise: vajuta <b>Alusta kõnet</b>, luba mikrofon ja räägi eesti keeles — näiteks <i>"Sooviksin broneerida laua neljale reedeks kella seitsmeks."</i> Broneering ilmub jaotisesse "Broneeringud".</p>
        <div class="callpanel">
          <div class="callhead"><span class="calltitle">${name}</span><span class="callstatus" id="call-status">Valmis</span></div>
          <div class="vizrow"><span class="vizlbl">${name} hääl</span><div class="viz" id="asst-viz">${bars}</div></div>
          <div class="vizrow"><span class="vizlbl">Sinu hääl</span><div class="viz user" id="user-viz">${bars}</div></div>
          <button class="btn callbtn" id="call-btn">Alusta kõnet</button>
          <p class="hint" id="call-msg"></p>
        </div>`
    : `<div class="notice">Testimiseks määra serveris <code>VAPI_PUBLIC_KEY</code> ja <code>VAPI_ASSISTANT_ID</code>.</div>`;

  // Custom in-tab call UI on the Vapi Web SDK, so we can render both the
  // assistant's and the caller's live waveforms (the floating widget can't).
  const callScript = ready
    ? `<script type="module">
import Vapi from 'https://esm.sh/@vapi-ai/web';
(function(){
  var PUBLIC_KEY=${JSON.stringify(publicKey)},ASSIST=${JSON.stringify(assistantId)};
  var vapi=null,active=false,starting=false,asstLevel=0,asstRAF=null;
  var micStream=null,micCtx=null,micRAF=null;
  var btn=document.getElementById('call-btn'),statusEl=document.getElementById('call-status'),msgEl=document.getElementById('call-msg');
  var userBars=document.querySelectorAll('#user-viz .bar'),asstBars=document.querySelectorAll('#asst-viz .bar');
  function setStatus(t,live){if(statusEl){statusEl.textContent=t;statusEl.className='callstatus'+(live?' live':'');}}
  function resetBars(list){for(var i=0;i<list.length;i++){list[i].style.transform='scaleY(0.05)';}}
  function startUserMeter(){
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)return;
    navigator.mediaDevices.getUserMedia({audio:true}).then(function(s){
      micStream=s;var AC=window.AudioContext||window.webkitAudioContext;micCtx=new AC();
      var src=micCtx.createMediaStreamSource(s),an=micCtx.createAnalyser();an.fftSize=64;an.smoothingTimeConstant=0.7;src.connect(an);
      var data=new Uint8Array(an.frequencyBinCount);
      function tick(){an.getByteFrequencyData(data);for(var i=0;i<userBars.length;i++){var v=data[i]/255;userBars[i].style.transform='scaleY('+Math.max(0.05,Math.min(1,v*1.5)).toFixed(3)+')';}micRAF=requestAnimationFrame(tick);}
      tick();
    }).catch(function(e){if(msgEl){msgEl.textContent='Mikrofoni ei saanud: '+e.message;}});
  }
  function stopUserMeter(){if(micRAF){cancelAnimationFrame(micRAF);micRAF=null;}if(micStream){micStream.getTracks().forEach(function(t){t.stop();});micStream=null;}if(micCtx){micCtx.close();micCtx=null;}resetBars(userBars);}
  function animateAsst(){var t=performance.now()/180;for(var i=0;i<asstBars.length;i++){var v=asstLevel*(0.45+0.55*Math.abs(Math.sin(t+i*0.5)));asstBars[i].style.transform='scaleY('+Math.max(0.05,Math.min(1,v)).toFixed(3)+')';}asstRAF=requestAnimationFrame(animateAsst);}
  function cleanup(){active=false;starting=false;asstLevel=0;if(asstRAF){cancelAnimationFrame(asstRAF);asstRAF=null;}resetBars(asstBars);stopUserMeter();btn.textContent='Alusta kõnet';btn.classList.remove('ending');setStatus('Valmis',false);}
  function ensureVapi(){
    if(vapi)return;
    vapi=new Vapi(PUBLIC_KEY);
    vapi.on('call-start',function(){active=true;starting=false;setStatus('Kuulan sind',true);});
    vapi.on('speech-start',function(){setStatus(${JSON.stringify(restaurant.name)}+' räägib',true);});
    vapi.on('speech-end',function(){setStatus('Kuulan sind',true);});
    vapi.on('volume-level',function(l){asstLevel=typeof l==='number'?l:0;});
    vapi.on('call-end',function(){cleanup();});
    vapi.on('error',function(e){if(msgEl){msgEl.textContent='Viga kõnes. Proovi uuesti.';}cleanup();});
  }
  function start(){
    if(active||starting)return;
    if(msgEl){msgEl.textContent='';}
    starting=true;btn.textContent='Lõpeta kõne';btn.classList.add('ending');setStatus('Ühendan...',false);
    try{ensureVapi();asstRAF=requestAnimationFrame(animateAsst);startUserMeter();var p=vapi.start(ASSIST);if(p&&p.catch){p.catch(function(e){if(msgEl){msgEl.textContent='Kõnet ei saanud alustada.';}cleanup();});}}
    catch(e){if(msgEl){msgEl.textContent='Kõnet ei saanud alustada: '+e.message;}cleanup();}
  }
  function end(){if(vapi&&(active||starting)){try{vapi.stop();}catch(e){}}cleanup();}
  if(btn){btn.addEventListener('click',function(){if(active||starting){end();}else{start();}});}
  document.querySelectorAll('.nav button').forEach(function(b){b.addEventListener('click',function(){if(b.dataset.sec!=='test'){end();}});});
})();
</script>`
    : "";

  res.send(`<!doctype html><html lang="et"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${name} — juhtpaneel</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root{--bg:#0c0d0b;--panel:#121310;--text:#ece7db;--muted:#9c968a;--gold:#c9a96a;--line:rgba(236,231,219,.10);--card:rgba(255,255,255,.035);--err:#e6a07f;}
    *{box-sizing:border-box;}
    body{margin:0;font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;}
    .app{display:grid;grid-template-columns:248px 1fr;min-height:100vh;}
    .side{background:var(--panel);border-right:1px solid var(--line);padding:1.6rem 1rem;display:flex;flex-direction:column;}
    .brand{font-family:'Fraunces',serif;font-size:1.55rem;margin:.2rem .6rem .2rem;}
    .brand-sub{font-size:.68rem;letter-spacing:.2em;text-transform:uppercase;color:var(--gold);margin:0 .7rem 1.4rem;}
    .nav{display:flex;flex-direction:column;gap:.2rem;}
    .nav button{display:block;width:100%;background:none;border:0;color:var(--muted);font:inherit;font-size:.96rem;text-align:left;padding:.62rem .8rem;border-radius:10px;cursor:pointer;transition:.15s;}
    .nav button:hover{color:var(--text);background:var(--card);}
    .nav button.active{color:var(--text);background:rgba(201,169,106,.13);}
    .side .status{margin-top:auto;font-size:.76rem;color:var(--muted);padding:.7rem .7rem 0;border-top:1px solid var(--line);}
    .status .dot{display:inline-block;width:.5rem;height:.5rem;border-radius:50%;background:${ready ? "#7fcf9f" : "var(--err)"};margin-right:.4rem;}
    .main{padding:clamp(1.6rem,4vw,3rem);max-width:860px;}
    h1{font-family:'Fraunces',serif;font-weight:400;font-size:clamp(1.7rem,4vw,2.1rem);margin:0 0 .4rem;}
    .lead{color:var(--muted);margin:0 0 1.8rem;line-height:1.6;}
    .sec{display:none;}
    .sec.active{display:block;animation:fade .35s ease;}
    @keyframes fade{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1rem;margin-bottom:1.8rem;}
    .statc{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1.1rem 1.25rem;}
    .statc .v{font-family:'Fraunces',serif;font-size:1.9rem;line-height:1;}
    .statc .v.status-v{font-family:'Inter',sans-serif;font-size:1.05rem;font-weight:500;display:flex;align-items:center;gap:.5rem;padding:.35rem 0;}
    .statc .sdot{width:.6rem;height:.6rem;border-radius:50%;flex:none;background:${ready ? "#7fcf9f" : "var(--muted)"};box-shadow:${ready ? "0 0 0 4px rgba(127,207,159,.15)" : "none"};}
    .statc .l{color:var(--muted);font-size:.82rem;margin-top:.45rem;}
    .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:.4rem 1.25rem;}
    .card-title{font-size:.82rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin:1.1rem 0 .2rem;}
    .hours-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:0 1.5rem;}
    .hrow{display:flex;justify-content:space-between;gap:1rem;padding:.6rem 0;border-bottom:1px solid var(--line);}
    .hrow .hday{color:var(--muted);}
    .hrow .hval{color:var(--text);font-variant-numeric:tabular-nums;}
    .hrow .hval.closed{color:var(--muted);font-style:italic;}
    .hint{color:var(--muted);font-size:.8rem;margin:.4rem 0 0;}
    .callpanel{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:1.6rem;margin-top:1.4rem;max-width:560px;}
    .callhead{display:flex;align-items:center;justify-content:space-between;margin-bottom:1.2rem;}
    .calltitle{font-family:'Fraunces',serif;font-size:1.4rem;}
    .callstatus{font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;}
    .callstatus.live{color:#7fcf9f;}
    .vizrow{display:flex;align-items:center;gap:1rem;margin:.6rem 0;}
    .vizlbl{width:5.5rem;flex:none;font-size:.8rem;color:var(--muted);}
    .viz{flex:1;display:flex;align-items:center;gap:3px;height:48px;}
    .viz .bar{flex:1;background:var(--gold);border-radius:3px;height:100%;transform:scaleY(.05);transform-origin:center;transition:transform .07s linear;opacity:.9;}
    .viz.user .bar{background:#8fcaff;}
    .callbtn{margin-top:1.2rem;}
    .callbtn.ending{background:var(--err);color:#2a0f0a;}
    .field{margin-bottom:1.2rem;}
    .lbl{display:block;font-size:.85rem;color:var(--muted);margin-bottom:.45rem;}
    input[type=text],input[type=number],input[type=time],select{background:#0c0d0b;border:1px solid var(--line);color:var(--text);border-radius:10px;padding:.6rem .75rem;font:inherit;font-size:.95rem;max-width:100%;}
    input:focus,select:focus{outline:none;border-color:var(--gold);}
    input:disabled{opacity:.4;}
    .row2{display:flex;gap:1rem;flex-wrap:wrap;}
    .row2 .field{flex:1;min-width:140px;}
    .dayrow{display:flex;align-items:center;gap:.75rem;padding:.55rem 0;border-bottom:1px solid var(--line);flex-wrap:wrap;}
    .dayrow .dayname{width:7rem;}
    .dayrow .sw{display:inline-flex;align-items:center;gap:.4rem;color:var(--muted);font-size:.85rem;width:6.5rem;}
    .dayrow .dash{color:var(--muted);}
    .btn{background:var(--gold);color:#1a1407;border:0;border-radius:10px;padding:.75rem 1.5rem;font:inherit;font-weight:600;cursor:pointer;margin-top:.6rem;}
    .btn:hover{filter:brightness(1.07);}
    .btn:disabled{opacity:.6;cursor:default;}
    .btn.ghost{background:none;border:1px solid var(--line);color:var(--text);font-weight:500;padding:.5rem 1rem;margin-top:.6rem;}
    .tones{display:flex;flex-wrap:wrap;gap:.5rem;}
    .toneb{background:none;border:1px solid var(--line);color:var(--muted);font:inherit;font-size:.9rem;padding:.45rem .9rem;border-radius:999px;cursor:pointer;}
    .toneb:hover{color:var(--text);}
    .toneb.active{background:rgba(201,169,106,.15);border-color:rgba(201,169,106,.5);color:var(--text);}
    .faqrow,.taskrow{display:flex;gap:.5rem;margin-bottom:.5rem;align-items:center;}
    .faqrow .faq-q{flex:0 0 38%;}
    .faqrow .faq-a,.taskrow .task-t{flex:1;}
    .faqrow input,.taskrow input{width:100%;}
    .rmrow{flex:none;width:2rem;height:2rem;border-radius:8px;border:1px solid var(--line);background:none;color:var(--muted);font-size:1.1rem;line-height:1;cursor:pointer;}
    .rmrow:hover{color:var(--err);border-color:var(--err);}
    .callwrap{display:grid;grid-template-columns:300px 1fr;gap:1rem;align-items:start;}
    .call-list{display:flex;flex-direction:column;gap:.5rem;max-height:70vh;overflow:auto;}
    .callitem{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.8rem 1rem;cursor:pointer;}
    .callitem:hover{border-color:rgba(201,169,106,.4);}
    .callitem.active{border-color:var(--gold);background:rgba(201,169,106,.08);}
    .callitem .ci-top{display:flex;justify-content:space-between;gap:.5rem;font-size:.9rem;}
    .callitem .ci-caller{font-weight:500;}
    .callitem .ci-sum{color:var(--muted);font-size:.85rem;margin-top:.25rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .call-detail{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1.4rem;min-height:200px;}
    .cd-head{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;margin-bottom:1rem;}
    .cd-caller{font-family:'Fraunces',serif;font-size:1.3rem;}
    .cd-meta{color:var(--muted);font-size:.85rem;margin-top:.2rem;}
    .cd-rec{color:var(--gold);font-size:.85rem;border:1px solid rgba(201,169,106,.4);border-radius:999px;padding:.2rem .7rem;text-decoration:none;white-space:nowrap;}
    .cd-section{font-size:.78rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:1.1rem 0 .35rem;}
    .cd-text{font-size:.95rem;line-height:1.6;white-space:pre-wrap;}
    .cd-pill{display:inline-block;background:rgba(201,169,106,.15);color:var(--gold);border-radius:999px;padding:.15rem .6rem;font-size:.8rem;}
    .note{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:.55rem .8rem;margin-bottom:.4rem;font-size:.9rem;}
    .note .note-at{color:var(--muted);font-size:.75rem;margin-top:.2rem;}
    .noteadd{display:flex;gap:.5rem;margin-top:.6rem;}
    .noteadd input{flex:1;}
    .muted{color:var(--muted);}
    @media(max-width:720px){.callwrap{grid-template-columns:1fr;}}
    .rezv{display:flex;flex-direction:column;gap:.6rem;}
    .rez{display:flex;align-items:center;justify-content:space-between;gap:1rem;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1rem 1.25rem;}
    .rez-name{font-family:'Fraunces',serif;font-size:1.2rem;}
    .rez-meta{color:var(--muted);font-size:.92rem;margin-top:.15rem;}
    .rez-id{font-size:.7rem;color:var(--gold);border:1px solid rgba(201,169,106,.35);border-radius:999px;padding:.18rem .6rem;white-space:nowrap;}
    .empty{color:var(--muted);text-align:center;padding:2.5rem 1rem;border:1px dashed var(--line);border-radius:14px;font-style:italic;}
    .notice{background:rgba(201,120,90,.08);color:#e8c4b4;border:1px solid rgba(201,120,90,.35);border-radius:12px;padding:1rem 1.25rem;}
    code{background:rgba(255,255,255,.06);padding:.1rem .4rem;border-radius:5px;color:var(--gold);}
    .toast{position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%) translateY(160%);background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--gold);padding:.85rem 1.25rem;border-radius:10px;transition:transform .3s ease;max-width:92vw;z-index:50;}
    .toast.show{transform:translateX(-50%) translateY(0);}
    .toast.err{border-left-color:var(--err);}
    @media(max-width:720px){.app{grid-template-columns:1fr;}.side{flex-direction:column;}.nav{flex-direction:row;flex-wrap:wrap;}.side .status{display:none;}}
  </style></head><body>
  <div class="app">
    <aside class="side">
      <div class="brand brand-rest">${name}</div>
      <div class="brand-sub">Aino · juhtpaneel</div>
      <nav class="nav">
        <button class="active" data-sec="overview">Ülevaade</button>
        <button data-sec="settings">Seaded</button>
        <button data-sec="test">Testi assistenti</button>
        <button data-sec="calls">Vestlused</button>
        <button data-sec="bookings">Broneeringud</button>
      </nav>
      <div class="status"><span class="dot"></span>${ready ? "Assistent ühendatud" : "Assistent seadistamata"}${DASHBOARD_PASSWORD ? ` · <a href="/logout" style="color:var(--gold)">Logi välja</a>` : ""}</div>
    </aside>
    <main class="main">
      <section class="sec active" id="sec-overview">
        <h1>Ülevaade</h1>
        <p class="lead"><span class="brand-rest">${name}</span> broneerimisassistent.</p>
        <div class="cards">
          <div class="statc"><div class="v" id="kpi-calls">${allCalls.length}</div><div class="l">Kõnesid kokku</div></div>
          <div class="statc"><div class="v" id="kpi-calltime">${fmtCallTime(totalCallSec)}</div><div class="l">Kõneaeg kokku</div></div>
          <div class="statc"><div class="v" id="stat-total">${bookings.length}</div><div class="l">Broneeringut kokku</div></div>
          <div class="statc"><div class="v" id="kpi-sat">${satPct}</div><div class="l">Rahulolu</div></div>
        </div>
        <div class="cards">
          <div class="statc"><div class="v" id="stat-today">${todayCount}</div><div class="l">Broneeringut täna</div></div>
          <div class="statc"><div class="v">${restaurant.capacity}</div><div class="l">Kohti korraga</div></div>
          <div class="statc"><div class="v status-v"><span class="sdot"></span>${ready ? "Ühendatud" : "Seadistamata"}</div><div class="l">Assistent</div></div>
        </div>
        <p class="card-title">Kõnede maht (14 päeva)</p>
        <div class="card" style="padding:1rem 1.25rem">${chartSvg}</div>
        <p class="card-title">Lahtiolekuajad</p>
        <div class="card hours-list">
          ${DAYS.map(([d, label]) => {
            const h = restaurant.hours[d];
            return `<div class="hrow"><span class="hday">${label}</span><span class="hval${h ? "" : " closed"}">${h ? `${h.open}–${h.close}` : "Suletud"}</span></div>`;
          }).join("")}
        </div>
      </section>

      <section class="sec" id="sec-settings">
        <h1>Seaded</h1>
        <p class="lead">Muuda restorani andmeid ja lahtiolekuaegu. Broneerimisreeglid rakenduvad kohe.</p>
        <div class="field"><label class="lbl">Restorani nimi</label><input type="text" id="f-name" value="${name}"></div>
        <div class="row2">
          <div class="field"><label class="lbl">Kohti korraga</label><input type="number" id="f-capacity" min="1" value="${restaurant.capacity}"><p class="hint">Mitu kohta saab ühe ajavahemiku jooksul broneerida.</p></div>
          <div class="field"><label class="lbl">Maks. seltskond</label><input type="number" id="f-maxparty" min="1" value="${restaurant.maxPartySize}"><p class="hint">Suuremad seltskonnad suunatakse kodulehele.</p></div>
          <div class="field"><label class="lbl">Broneeringu samm</label><select id="f-slot">${slotOpts}</select><p class="hint">Ajavahemike pikkus.</p></div>
        </div>
        <div class="field"><label class="lbl">Lahtiolekuajad</label>${dayRows}</div>
        <div class="field">
          <label class="lbl">Tervituse toon</label>
          <div class="tones" id="tones">${toneBtns}</div>
        </div>
        <div class="field">
          <label class="lbl">Korduma kippuvad küsimused</label>
          <p class="hint" style="margin:0 0 .6rem">Assistent vastab nende põhjal, kui klient küsib.</p>
          <div id="faqs">${faqRows}</div>
          <button type="button" class="btn ghost" id="add-faq">+ Lisa küsimus</button>
        </div>
        <div class="field">
          <label class="lbl">Ülesanded</label>
          <p class="hint" style="margin:0 0 .6rem">Juhised tegevusteks, nt "kui klient küsib sündmuse kohta, ütle et keegi võtab ühendust".</p>
          <div id="tasks">${taskRows}</div>
          <button type="button" class="btn ghost" id="add-task">+ Lisa ülesanne</button>
        </div>
        <div class="field">
          <label class="lbl">Teavitused</label>
          <label class="sw" style="width:auto"><input type="checkbox" id="f-sms"${restaurant.smsConfirmations ? " checked" : ""}> Saada külalisele broneeringu kinnitus SMS-iga</label>
          <p class="hint">Vajab Twilio seadistust serveris (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER).</p>
        </div>
        <button class="btn" id="save">Salvesta</button>

        <div class="field" style="margin-top:2.2rem">
          <label class="lbl">Assistendi tekst (kleebi Vapisse)</label>
          <p class="lead" style="margin:0 0 .6rem">Lahtiolekuajad ja kohad rakenduvad kohe. Kui muudad nime või tervitust, kopeeri allolev tekst ja kleebi see Vapi assistendi seadetesse (System Prompt + First Message).</p>
          <textarea id="assistant-text" readonly rows="10" style="width:100%;background:#0c0d0b;border:1px solid var(--line);color:var(--muted);border-radius:10px;padding:.75rem;font-family:ui-monospace,monospace;font-size:.82rem;line-height:1.5;">${assistantText}</textarea>
          <button class="btn" id="copy-assistant" style="background:none;border:1px solid var(--line);color:var(--text)">Kopeeri tekst</button>
        </div>
      </section>

      <section class="sec" id="sec-test">
        <h1>Testi assistenti</h1>
        ${testInner}
      </section>

      <section class="sec" id="sec-calls">
        <h1>Vestlused</h1>
        <p class="lead">Kõik Aino kõned — kokkuvõte, transkriptsioon ja tulemus. Uueneb automaatselt.</p>
        <div class="callwrap">
          <div id="call-list" class="call-list"><div class="empty">Laen…</div></div>
          <div id="call-detail" class="call-detail"><div class="empty">Vali vestlus vasakult.</div></div>
        </div>
      </section>

      <section class="sec" id="sec-bookings">
        <h1>Broneeringud</h1>
        <p class="lead">Reaalajas — uueneb automaatselt.</p>
        <div id="rezv" class="rezv"><div class="empty">Laen…</div></div>
      </section>
    </main>
  </div>
  <div class="toast" id="toast"></div>
  <script>
  (function(){
    function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
    var navs=document.querySelectorAll('.nav button');
    var secs=document.querySelectorAll('.sec');
    navs.forEach(function(btn){btn.addEventListener('click',function(){
      navs.forEach(function(b){b.classList.remove('active');});
      secs.forEach(function(s){s.classList.remove('active');});
      btn.classList.add('active');
      document.getElementById('sec-'+btn.dataset.sec).classList.add('active');
    });});
    document.querySelectorAll('.open-toggle').forEach(function(t){t.addEventListener('change',function(){
      var row=t.closest('.dayrow');var on=t.checked;
      row.querySelector('.open').disabled=!on;row.querySelector('.close').disabled=!on;
    });});
    var tones=document.getElementById('tones');
    if(tones){tones.addEventListener('click',function(e){if(e.target.classList.contains('toneb')){tones.querySelectorAll('.toneb').forEach(function(b){b.classList.remove('active');});e.target.classList.add('active');}});}
    function faqRowEl(){var d=document.createElement('div');d.className='faqrow';d.innerHTML='<input type="text" class="faq-q" placeholder="Küsimus"><input type="text" class="faq-a" placeholder="Vastus"><button type="button" class="rmrow" aria-label="Eemalda">×</button>';return d;}
    function taskRowEl(){var d=document.createElement('div');d.className='taskrow';d.innerHTML='<input type="text" class="task-t" placeholder="Nt: kui klient küsib parkimist, paku Google Mapsi linki"><button type="button" class="rmrow" aria-label="Eemalda">×</button>';return d;}
    var addFaq=document.getElementById('add-faq');if(addFaq){addFaq.addEventListener('click',function(){document.getElementById('faqs').appendChild(faqRowEl());});}
    var addTask=document.getElementById('add-task');if(addTask){addTask.addEventListener('click',function(){document.getElementById('tasks').appendChild(taskRowEl());});}
    var faqsBox=document.getElementById('faqs');if(faqsBox){faqsBox.addEventListener('click',function(e){if(e.target.classList.contains('rmrow')){e.target.closest('.faqrow').remove();}});}
    var tasksBox=document.getElementById('tasks');if(tasksBox){tasksBox.addEventListener('click',function(e){if(e.target.classList.contains('rmrow')){e.target.closest('.taskrow').remove();}});}
    var toastEl=document.getElementById('toast');var tt;
    function toast(msg,ok){toastEl.textContent=msg;toastEl.className='toast show'+(ok?'':' err');clearTimeout(tt);tt=setTimeout(function(){toastEl.className='toast'+(ok?'':' err');},6000);}
    function collect(){
      var hours={};
      document.querySelectorAll('.dayrow').forEach(function(row){
        var d=row.dataset.day;
        if(!row.querySelector('.open-toggle').checked){hours[d]=null;}
        else{hours[d]={open:row.querySelector('.open').value,close:row.querySelector('.close').value};}
      });
      var faqs=[];
      document.querySelectorAll('#faqs .faqrow').forEach(function(r){var q=r.querySelector('.faq-q').value.trim();var a=r.querySelector('.faq-a').value.trim();if(q&&a){faqs.push({q:q,a:a});}});
      var tasks=[];
      document.querySelectorAll('#tasks .taskrow').forEach(function(r){var v=r.querySelector('.task-t').value.trim();if(v){tasks.push(v);}});
      var tb=document.querySelector('#tones .toneb.active');
      var smsEl=document.getElementById('f-sms');
      return {name:document.getElementById('f-name').value,capacity:parseInt(document.getElementById('f-capacity').value,10),maxPartySize:parseInt(document.getElementById('f-maxparty').value,10),slotMinutes:parseInt(document.getElementById('f-slot').value,10),hours:hours,greetingTone:tb?tb.dataset.tone:'soe',faqs:faqs,tasks:tasks,smsConfirmations:smsEl?smsEl.checked:true};
    }
    var saveBtn=document.getElementById('save');
    saveBtn.addEventListener('click',function(){
      saveBtn.disabled=true;
      fetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(collect())})
      .then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d};});})
      .then(function(res){
        if(!res.ok){toast(res.d.error||'Salvestamine ebaõnnestus',false);return;}
        toast('Salvestatud. Broneerimisreeglid kehtivad kohe.',true);
        document.querySelectorAll('.brand-rest').forEach(function(e){e.textContent=res.d.config.name;});
        if(res.d.assistant){
          var ta=document.getElementById('assistant-text');
          if(ta){ta.value=res.d.assistant.systemPrompt+'\\n\\n--- Esimene lause (First Message) ---\\n'+res.d.assistant.firstMessage;}
        }
      })
      .catch(function(e){toast('Viga: '+e.message,false);})
      .then(function(){saveBtn.disabled=false;});
    });
    var copyBtn=document.getElementById('copy-assistant');
    if(copyBtn){copyBtn.addEventListener('click',function(){
      var ta=document.getElementById('assistant-text');
      navigator.clipboard.writeText(ta.value).then(function(){toast('Tekst kopeeritud. Kleebi see Vapisse.',true);},function(){ta.select();toast('Vajuta Ctrl/Cmd+C, et kopeerida.',true);});
    });}
    var today=new Date().toISOString().slice(0,10);
    function loadRezv(){
      fetch('/api/bookings',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
        var list=d.bookings||[];
        var el=document.getElementById('rezv');
        if(el){
          if(!list.length){el.innerHTML='<div class="empty">Veel broneeringuid pole.</div>';}
          else{el.innerHTML=list.map(function(b){return '<div class="rez"><div><div class="rez-name">'+esc(b.name)+'</div><div class="rez-meta">'+esc(b.date)+' · '+esc(b.time)+' · '+esc(b.partySize)+' inimest</div></div><span class="rez-id">'+esc(b.id)+'</span></div>';}).join('');}
        }
        var st=document.getElementById('stat-total');if(st){st.textContent=list.length;}
        var sd=document.getElementById('stat-today');if(sd){sd.textContent=list.filter(function(b){return b.date===today;}).length;}
      }).catch(function(){});
    }
    loadRezv();setInterval(loadRezv,4000);

    var selectedCall=null;
    function fmtDur(s){s=s||0;var m=Math.floor(s/60);var ss=s%60;return m+' min '+(ss<10?'0':'')+ss+' s';}
    function fmtDate(iso){try{return new Date(iso).toLocaleString('et-EE');}catch(e){return iso;}}
    function notesHtml(notes){if(!notes||!notes.length){return '<div class="muted" style="font-size:.85rem">Märkmeid pole.</div>';}return notes.map(function(n){return '<div class="note">'+esc(n.text)+'<div class="note-at">'+fmtDate(n.at)+'</div></div>';}).join('');}
    function renderCallDetail(c){
      var el=document.getElementById('call-detail');if(!el)return;
      var rec=c.recordingUrl?'<a class="cd-rec" href="'+esc(c.recordingUrl)+'" target="_blank" rel="noopener">Salvestus</a>':'';
      var outcome=c.outcome?'<div class="cd-section">Tulemus</div><div><span class="cd-pill">'+esc(c.outcome)+'</span></div>':'';
      el.innerHTML='<div class="cd-head"><div><div class="cd-caller">'+esc(c.caller)+'</div><div class="cd-meta">'+fmtDate(c.createdAt)+' · '+fmtDur(c.durationSec)+'</div></div>'+rec+'</div>'+outcome+'<div class="cd-section">Kokkuvõte</div><div class="cd-text">'+(c.summary?esc(c.summary):'<span class="muted">—</span>')+'</div><div class="cd-section">Transkriptsioon</div><div class="cd-text">'+(c.transcript?esc(c.transcript):'<span class="muted">—</span>')+'</div><div class="cd-section">Märkmed</div><div id="notes">'+notesHtml(c.notes)+'</div><div class="noteadd"><input type="text" id="note-input" placeholder="Lisa märkus..."><button class="btn" id="note-add">Lisa</button></div>';
      var addBtn=document.getElementById('note-add');
      addBtn.addEventListener('click',function(){
        var inp=document.getElementById('note-input');var t=inp.value.trim();if(!t){return;}addBtn.disabled=true;
        fetch('/api/calls/'+encodeURIComponent(c.id)+'/notes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:t})})
        .then(function(r){return r.json();}).then(function(d){if(d.ok){openCall(c.id);}}).catch(function(){}).then(function(){addBtn.disabled=false;});
      });
    }
    function openCall(id){
      selectedCall=id;
      document.querySelectorAll('.callitem').forEach(function(it){it.classList.toggle('active',it.dataset.id===id);});
      fetch('/api/calls/'+encodeURIComponent(id)).then(function(r){return r.json();}).then(renderCallDetail).catch(function(){});
    }
    function fmtCallTimeJS(sec){var m=Math.round(sec/60);if(m<60){return m+' min';}return Math.floor(m/60)+' h '+(m%60)+' min';}
    function loadCalls(){
      fetch('/api/calls',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
        var list=d.calls||[];
        var kc=document.getElementById('kpi-calls');if(kc){kc.textContent=list.length;}
        var totalSec=list.reduce(function(a,c){return a+(c.durationSec||0);},0);
        var kt=document.getElementById('kpi-calltime');if(kt){kt.textContent=fmtCallTimeJS(totalSec);}
        var ev=list.filter(function(c){return c.success===true||c.success===false;});
        var ks=document.getElementById('kpi-sat');if(ks){ks.textContent=ev.length?Math.round(100*ev.filter(function(c){return c.success===true;}).length/ev.length)+'%':'—';}
        var el=document.getElementById('call-list');if(!el){return;}
        if(!list.length){el.innerHTML='<div class="empty">Veel vestlusi pole.</div>';return;}
        el.innerHTML=list.map(function(c){return '<div class="callitem'+(c.id===selectedCall?' active':'')+'" data-id="'+esc(c.id)+'"><div class="ci-top"><span class="ci-caller">'+esc(c.caller)+'</span><span class="muted">'+fmtDur(c.durationSec)+'</span></div><div class="ci-sum">'+esc(c.summary||'—')+'</div></div>';}).join('');
        el.querySelectorAll('.callitem').forEach(function(it){it.addEventListener('click',function(){openCall(it.dataset.id);});});
      }).catch(function(){});
    }
    loadCalls();setInterval(loadCalls,8000);
  })();
  </script>
  ${callScript}
  </body></html>`);
});

const PORT = process.env.PORT || 8080;
await initPersistence(); // loads + hydrates from Postgres if DATABASE_URL is set
app.listen(PORT, () => console.log(`Aino booking backend on :${PORT}`));
