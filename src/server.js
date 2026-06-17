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
} from "./config.js";
import { hoursSummary, buildSystemPrompt, buildFirstMessage } from "./vapi-assistant.js";
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

// ---- bookings feed (powers the live panel on the demo page) -------------

app.get("/api/bookings", (_req, res) => {
  res.json({ bookings: store.allBookings() });
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

  const DAYS = [[1, "Esmaspäev"], [2, "Teisipäev"], [3, "Kolmapäev"], [4, "Neljapäev"], [5, "Reede"], [6, "Laupäev"], [0, "Pühapäev"]];
  const dayRows = DAYS.map(([d, label]) => {
    const h = restaurant.hours[d];
    const open = !!h;
    return `<div class="dayrow" data-day="${d}"><span class="dayname">${label}</span><label class="sw"><input type="checkbox" class="open-toggle" ${open ? "checked" : ""}> Avatud</label><input type="time" class="open" value="${open ? h.open : "12:00"}" ${open ? "" : "disabled"}><span class="dash">–</span><input type="time" class="close" value="${open ? h.close : "22:00"}" ${open ? "" : "disabled"}></div>`;
  }).join("");
  const slotOpts = [15, 30, 60].map((m) => `<option value="${m}"${restaurant.slotMinutes === m ? " selected" : ""}>${m} min</option>`).join("");
  const assistantText = esc(`${buildSystemPrompt(restaurant)}\n\n--- Esimene lause (First Message) ---\n${buildFirstMessage(restaurant)}`);

  const testInner = ready
    ? `<p class="lead">Proovi assistenti ise: vajuta paremas all nurgas <b>kõnenupule</b>, luba mikrofon ja räägi eesti keeles — näiteks <i>"Sooviksin broneerida laua neljale reedeks kella seitsmeks."</i> Broneering ilmub jaotisesse "Broneeringud".</p>`
    : `<div class="notice">Testimiseks määra serveris <code>VAPI_PUBLIC_KEY</code> ja <code>VAPI_ASSISTANT_ID</code>.</div>`;

  const widget = ready
    ? `<script src="https://unpkg.com/@vapi-ai/client-sdk-react/dist/embed/widget.umd.js"></script><vapi-widget public-key="${esc(publicKey)}" assistant-id="${esc(assistantId)}" mode="voice" theme="dark" accent-color="#c9a96a" title="${name}" start-button-text="Räägi assistendiga"></vapi-widget>`
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
    .miccard{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:1.4rem;margin-top:1.6rem;}
    .mic-viz{display:flex;align-items:flex-end;gap:4px;height:64px;margin:1.1rem 0 .4rem;}
    .mic-viz .bar{flex:1;background:var(--gold);border-radius:3px;height:100%;transform:scaleY(.06);transform-origin:bottom;transition:transform .08s linear;}
    .mic-on{color:#7fcf9f;}
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
        <button data-sec="bookings">Broneeringud</button>
      </nav>
      <div class="status"><span class="dot"></span>${ready ? "Assistent ühendatud" : "Assistent seadistamata"}</div>
    </aside>
    <main class="main">
      <section class="sec active" id="sec-overview">
        <h1>Ülevaade</h1>
        <p class="lead"><span class="brand-rest">${name}</span> broneerimisassistent.</p>
        <div class="cards">
          <div class="statc"><div class="v" id="stat-today">${todayCount}</div><div class="l">Broneeringut täna</div></div>
          <div class="statc"><div class="v" id="stat-total">${bookings.length}</div><div class="l">Broneeringut kokku</div></div>
          <div class="statc"><div class="v">${restaurant.capacity}</div><div class="l">Kohti korraga</div></div>
          <div class="statc"><div class="v status-v"><span class="sdot"></span>${ready ? "Ühendatud" : "Seadistamata"}</div><div class="l">Assistent</div></div>
        </div>
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
        <div class="miccard">
          <label class="lbl">Sinu hääl</label>
          <p class="hint" style="margin:0 0 .2rem">Kontrolli, kas mikrofon töötab — ribad peaksid rääkimisel liikuma.</p>
          <div class="mic-viz" id="mic-viz" hidden>${Array.from({ length: 18 }).map(() => '<span class="bar"></span>').join("")}</div>
          <p class="hint" id="mic-status"></p>
          <button class="btn" id="mic-toggle" style="background:none;border:1px solid var(--line);color:var(--text)">Kontrolli mikrofoni</button>
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
  ${widget}
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
      if(btn.dataset.sec!=='test'){stopMic();}
    });});
    document.querySelectorAll('.open-toggle').forEach(function(t){t.addEventListener('change',function(){
      var row=t.closest('.dayrow');var on=t.checked;
      row.querySelector('.open').disabled=!on;row.querySelector('.close').disabled=!on;
    });});
    var toastEl=document.getElementById('toast');var tt;
    function toast(msg,ok){toastEl.textContent=msg;toastEl.className='toast show'+(ok?'':' err');clearTimeout(tt);tt=setTimeout(function(){toastEl.className='toast'+(ok?'':' err');},6000);}
    function collect(){
      var hours={};
      document.querySelectorAll('.dayrow').forEach(function(row){
        var d=row.dataset.day;
        if(!row.querySelector('.open-toggle').checked){hours[d]=null;}
        else{hours[d]={open:row.querySelector('.open').value,close:row.querySelector('.close').value};}
      });
      return {name:document.getElementById('f-name').value,capacity:parseInt(document.getElementById('f-capacity').value,10),maxPartySize:parseInt(document.getElementById('f-maxparty').value,10),slotMinutes:parseInt(document.getElementById('f-slot').value,10),hours:hours};
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
    var micStream=null,micCtx=null,micRAF=null;
    function stopMic(){
      if(micRAF){cancelAnimationFrame(micRAF);micRAF=null;}
      if(micStream){micStream.getTracks().forEach(function(t){t.stop();});micStream=null;}
      if(micCtx){micCtx.close();micCtx=null;}
      var viz=document.getElementById('mic-viz');if(viz){viz.hidden=true;}
      var mt=document.getElementById('mic-toggle');if(mt){mt.textContent='Kontrolli mikrofoni';mt.classList.remove('mic-on');}
      var ms=document.getElementById('mic-status');if(ms){ms.textContent='';}
    }
    var micToggle=document.getElementById('mic-toggle');
    if(micToggle){micToggle.addEventListener('click',function(){
      if(micStream){stopMic();return;}
      var ms=document.getElementById('mic-status');
      if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){if(ms){ms.textContent='Brauser ei toeta mikrofoni.';}return;}
      navigator.mediaDevices.getUserMedia({audio:true}).then(function(s){
        micStream=s;micToggle.textContent='Peata kontroll';micToggle.classList.add('mic-on');
        if(ms){ms.textContent='Räägi — ribad liiguvad, kui hääl jõuab kohale.';}
        var AC=window.AudioContext||window.webkitAudioContext;
        micCtx=new AC();
        var src=micCtx.createMediaStreamSource(s);
        var an=micCtx.createAnalyser();an.fftSize=64;an.smoothingTimeConstant=0.7;src.connect(an);
        var data=new Uint8Array(an.frequencyBinCount);
        var viz=document.getElementById('mic-viz');if(viz){viz.hidden=false;}
        var bars=document.querySelectorAll('#mic-viz .bar');
        function tick(){
          an.getByteFrequencyData(data);
          for(var i=0;i<bars.length;i++){
            var v=data[i]/255;
            bars[i].style.transform='scaleY('+Math.max(0.06,Math.min(1,v*1.4)).toFixed(3)+')';
          }
          micRAF=requestAnimationFrame(tick);
        }
        tick();
      }).catch(function(e){if(ms){ms.textContent='Mikrofoni ei saanud kasutada: '+e.message;}});
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
  })();
  </script>
  </body></html>`);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Aino booking backend on :${PORT}`));
