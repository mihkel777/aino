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

// ---- shareable demo page (talk to Aino in the browser) ------------------
// One URL to hand an organiser: tap to talk in Estonian, watch the booking
// land on the live dashboard (embedded below). Uses Vapi's web widget, which
// needs the assistant's public key + id (both safe client-side) from env.

app.get("/demo", (_req, res) => {
  const publicKey = process.env.VAPI_PUBLIC_KEY;
  const assistantId = process.env.VAPI_ASSISTANT_ID;

  const head = `<!doctype html><html lang="et"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${restaurant.name} — broneeri laud</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;1,9..144,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root{--bg:#0c0d0b;--text:#ece7db;--muted:#9c968a;--gold:#c9a96a;--line:rgba(236,231,219,.10);--card:rgba(255,255,255,.035);}
    *{box-sizing:border-box;}
    html{scroll-behavior:smooth;}
    body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);margin:0;line-height:1.6;-webkit-font-smoothing:antialiased;overflow-x:hidden;}
    .glow{position:fixed;top:-32vh;left:50%;transform:translateX(-50%);width:120vw;height:80vh;background:radial-gradient(closest-side,rgba(201,169,106,.16),transparent 70%);pointer-events:none;z-index:0;}
    .page{position:relative;z-index:1;max-width:860px;margin:0 auto;padding:clamp(3rem,8vw,6rem) 1.5rem 4rem;}
    .badge{display:inline-flex;align-items:center;gap:.5rem;background:rgba(201,169,106,.10);color:var(--gold);border:1px solid rgba(201,169,106,.35);border-radius:999px;padding:.32rem .85rem;font-size:.72rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;}
    .badge .d,.cta-hint .d,.live .d{width:.5rem;height:.5rem;border-radius:50%;background:var(--gold);animation:pulse 2.2s infinite;}
    h1{font-family:'Fraunces',serif;font-weight:400;font-size:clamp(3.4rem,13vw,6rem);line-height:.95;letter-spacing:-.02em;margin:1.3rem 0 0;}
    .kicker{color:var(--gold);text-transform:uppercase;letter-spacing:.24em;font-size:.78rem;font-weight:600;margin:1rem 0 0;}
    .lede{color:var(--muted);font-size:clamp(1.05rem,2.4vw,1.32rem);max-width:38ch;margin:1.1rem 0 0;}
    .cta-hint{margin-top:1.8rem;font-size:.95rem;display:inline-flex;align-items:center;gap:.55rem;}
    h2{font-family:'Fraunces',serif;font-weight:400;font-size:clamp(1.6rem,4vw,2rem);letter-spacing:-.01em;margin:0 0 1.4rem;}
    section{margin-top:clamp(3rem,7vw,4.5rem);}
    .steps{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;}
    .step{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:1.4rem;transition:transform .25s ease,border-color .25s ease;}
    .step:hover{transform:translateY(-4px);border-color:rgba(201,169,106,.4);}
    .step .n{font-family:'Fraunces',serif;font-size:2rem;color:var(--gold);line-height:1;}
    .step p{margin:.6rem 0 0;font-size:.98rem;}
    .example{font-family:'Fraunces',serif;font-style:italic;font-size:clamp(1.5rem,4.2vw,2.2rem);line-height:1.32;text-align:center;border:0;margin:clamp(3rem,7vw,4.5rem) auto 0;max-width:24ch;padding:0 1rem;}
    .example cite{display:block;font-family:'Inter',sans-serif;font-style:normal;font-size:.76rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-top:1.1rem;}
    .rezv-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:1.4rem;}
    .rezv-head h2{margin:0;}
    .live{display:inline-flex;align-items:center;gap:.45rem;color:var(--gold);font-size:.72rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;}
    .rezv{display:flex;flex-direction:column;gap:.6rem;}
    .rez{display:flex;align-items:center;justify-content:space-between;gap:1rem;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1rem 1.25rem;animation:rise .4s ease both;}
    .rez-name{font-family:'Fraunces',serif;font-size:1.2rem;}
    .rez-meta{color:var(--muted);font-size:.92rem;margin-top:.15rem;}
    .rez-id{font-size:.7rem;color:var(--gold);border:1px solid rgba(201,169,106,.35);border-radius:999px;padding:.18rem .6rem;letter-spacing:.05em;white-space:nowrap;}
    .empty{color:var(--muted);text-align:center;padding:2.5rem 1rem;border:1px dashed var(--line);border-radius:14px;font-style:italic;}
    footer{margin-top:clamp(3rem,7vw,4.5rem);padding-top:1.5rem;border-top:1px solid var(--line);color:var(--muted);font-size:.8rem;display:flex;flex-wrap:wrap;gap:.4rem 1.5rem;}
    .notice{background:rgba(201,120,90,.08);color:#e8c4b4;border:1px solid rgba(201,120,90,.35);border-radius:16px;padding:1.25rem 1.4rem;margin-top:1.5rem;}
    code{background:rgba(255,255,255,.06);padding:.12rem .45rem;border-radius:6px;color:var(--gold);}
    .reveal{opacity:0;transform:translateY(16px);animation:rise .7s cubic-bezier(.2,.7,.2,1) forwards;}
    @keyframes rise{to{opacity:1;transform:none;}}
    @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(201,169,106,.5);}70%{box-shadow:0 0 0 8px rgba(201,169,106,0);}100%{box-shadow:0 0 0 0 rgba(201,169,106,0);}}
    @media(max-width:600px){.steps{grid-template-columns:1fr;}footer{flex-direction:column;}}
    @media(prefers-reduced-motion:reduce){.reveal,.rez{animation:none;opacity:1;transform:none;}.badge .d,.cta-hint .d,.live .d{animation:none;}}
  </style></head><body>
  <div class="glow"></div>
  <main class="page">
    <span class="badge reveal"><span class="d"></span>Tehisintellekti assistent</span>
    <h1 class="reveal" style="animation-delay:.05s">${restaurant.name}</h1>`;

  if (!publicKey || !assistantId) {
    return res.send(`${head}
      <p class="lede reveal" style="animation-delay:.1s">Broneeri laud meie virtuaalse assistendiga.</p>
      <div class="notice reveal" style="animation-delay:.15s">
        Demo pole veel seadistatud. Määra serveris keskkonnamuutujad
        <code>VAPI_PUBLIC_KEY</code> ja <code>VAPI_ASSISTANT_ID</code>
        (Vapi → Assistant → Public Key ja Assistant ID) ning käivita uuesti.
      </div></main></body></html>`);
  }

  res.send(`${head}
    <p class="kicker reveal" style="animation-delay:.1s">Laudade broneerimine · häälega</p>
    <p class="lede reveal" style="animation-delay:.15s">Broneeri laud meie virtuaalse assistendiga — räägi lihtsalt eesti keeles, nagu helistaksid restorani.</p>
    <div class="cta-hint reveal" style="animation-delay:.2s"><span class="d"></span>Vajuta kõnenupule, et alustada</div>

    <section class="reveal" style="animation-delay:.1s">
      <h2>Kuidas broneerida</h2>
      <div class="steps">
        <div class="step"><div class="n">1</div><p>Vajuta kõnenupule ja luba mikrofon.</p></div>
        <div class="step"><div class="n">2</div><p>Räägi eesti keeles, mida soovid broneerida.</p></div>
        <div class="step"><div class="n">3</div><p>Vaata, kuidas broneering ilmub kohe nimekirja.</p></div>
      </div>
    </section>

    <blockquote class="example reveal">"Sooviksin broneerida laua neljale reedeks kella seitsmeks."<cite>Proovi seda öelda</cite></blockquote>

    <section class="reveal">
      <div class="rezv-head"><h2>Broneeringud</h2><span class="live"><span class="d"></span>Reaalajas</span></div>
      <div id="rezv" class="rezv"><div class="empty">Laen broneeringuid…</div></div>
    </section>

    <footer>
      <span>Toimib telefonis ja arvutis</span>
      <span>See on tehisintellekti assistent</span>
      <span>Ehitatud Vapi + Claude peal</span>
    </footer>
  </main>
  <script src="https://unpkg.com/@vapi-ai/client-sdk-react/dist/embed/widget.umd.js"></script>
  <vapi-widget public-key="${publicKey}" assistant-id="${assistantId}" mode="voice" theme="dark" accent-color="#c9a96a" title="${restaurant.name}" start-button-text="Räägi assistendiga"></vapi-widget>
  <script>
    function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
    async function loadRezv(){
      try{
        const r = await fetch('/api/bookings',{cache:'no-store'});
        const d = await r.json();
        const el = document.getElementById('rezv');
        if(!el) return;
        if(!d.bookings || !d.bookings.length){el.innerHTML='<div class="empty">Veel broneeringuid pole — tee esimene!</div>';return;}
        el.innerHTML = d.bookings.map(function(b){
          return '<div class="rez"><div><div class="rez-name">'+esc(b.name)+'</div><div class="rez-meta">'+esc(b.date)+' · '+esc(b.time)+' · '+esc(b.partySize)+' inimest</div></div><span class="rez-id">'+esc(b.id)+'</span></div>';
        }).join('');
      }catch(e){}
    }
    loadRezv(); setInterval(loadRezv,4000);
  </script>
  </body></html>`);
});

// ---- live dashboard (for the demo) --------------------------------------

app.get("/", (_req, res) => {
  const bookings = store.allBookings();
  const rows = bookings
    .map(
      (b) =>
        `<div class="rez"><div><div class="rez-name">${esc(b.name)}</div><div class="rez-meta">${esc(b.date)} · ${esc(b.time)} · ${esc(b.partySize)} inimest</div></div><span class="rez-id">${esc(b.id)}</span></div>`
    )
    .join("");
  res.send(`<!doctype html><html lang="et"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${restaurant.name} — broneeringud</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root{--bg:#0c0d0b;--text:#ece7db;--muted:#9c968a;--gold:#c9a96a;--line:rgba(236,231,219,.10);--card:rgba(255,255,255,.035);}
    *{box-sizing:border-box;}
    body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);margin:0;padding:clamp(2rem,6vw,4rem) 1.5rem;-webkit-font-smoothing:antialiased;}
    .wrap{max-width:680px;margin:0 auto;}
    h1{font-family:'Fraunces',serif;font-weight:400;font-size:clamp(2.2rem,7vw,3rem);margin:0 0 .35rem;letter-spacing:-.01em;}
    .sub{color:var(--muted);font-size:.9rem;margin:0 0 2rem;display:flex;align-items:center;gap:.5rem;}
    .sub .d{width:.5rem;height:.5rem;border-radius:50%;background:var(--gold);animation:pulse 1.8s infinite;}
    .rezv{display:flex;flex-direction:column;gap:.6rem;}
    .rez{display:flex;align-items:center;justify-content:space-between;gap:1rem;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1rem 1.25rem;}
    .rez-name{font-family:'Fraunces',serif;font-size:1.2rem;}
    .rez-meta{color:var(--muted);font-size:.92rem;margin-top:.15rem;}
    .rez-id{font-size:.7rem;color:var(--gold);border:1px solid rgba(201,169,106,.35);border-radius:999px;padding:.18rem .6rem;white-space:nowrap;}
    .empty{color:var(--muted);text-align:center;padding:3rem 1rem;border:1px dashed var(--line);border-radius:14px;font-style:italic;}
    @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(201,169,106,.5);}70%{box-shadow:0 0 0 8px rgba(201,169,106,0);}100%{box-shadow:0 0 0 0 rgba(201,169,106,0);}}
  </style></head><body><div class="wrap">
    <h1>${restaurant.name}</h1>
    <p class="sub"><span class="d"></span>Broneeringud reaalajas · ${bookings.length} kokku</p>
    ${
      bookings.length === 0
        ? `<div class="empty">Veel broneeringuid pole. Helista ja broneeri laud!</div>`
        : `<div class="rezv">${rows}</div>`
    }
  </div>
  <script>setTimeout(function(){location.reload();},4000)</script>
  </body></html>`);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Aino booking backend on :${PORT}`));
