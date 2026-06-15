# Aino weekend build runbook (deadline: Sunday night)

**Goal by Sunday:** a phone number an organiser can call, speak Estonian to, and walk away having booked a table that appears live on the dashboard. That single thing proves the technical core they doubted. Nothing else matters this weekend.

You (Mihkel) own the product/build. Mart + Erik own demand validation. This runbook is yours.

---

## What's already built (in this repo)
- `src/server.js` — booking backend. Two tools the agent calls (`check-availability`, `book-table`) with real capacity logic + out-of-hours + party-size guardrails, plus a live dashboard at `/`.
- `src/config.js` — the one hardcoded restaurant (hours, capacity, max party). This is where "configuration" lives for now.
- `src/store.js` — in-memory bookings + nearby-slot suggestions. Swap for Google Calendar later (seam is clean).
- `src/vapi-assistant.js` — the Estonian system prompt, the two tool definitions, and the greeting. This is what you paste into Vapi.

All booking logic is tested and working. The unproven part is the **voice layer**, which is the whole point of the weekend.

---

## Saturday morning: prove Estonian voice works (the kill test) — DO THIS FIRST
Before integrating anything, answer the one question: is Estonian STT good enough over a phone line?

1. Make a free Vapi account. Create a blank assistant in their dashboard.
2. Set the LLM to Claude (Vapi supports Anthropic; add your Anthropic key).
3. Set STT to Azure, language Estonian (`et-EE`). Set TTS to an Estonian voice (Azure `et-EE-AnuNeural`). If Vapi's Azure Estonian path is awkward, try their other providers and pick the best Estonian.
4. Paste the `systemPrompt` and `firstMessage` from `vapi-assistant.js`. Skip tools for now.
5. Get a phone number from Vapi and **call it. Speak Estonian.** Say a name, a date, a time.

**Judge with your ears against the bar:**
- Latency caller-stops-to-agent-starts under ~1.5s
- It understood an Estonian name and a spoken time correctly
- The voice sounds like a person, not a robot

If yes → proceed to integration, you've de-risked the project. If Estonian STT mangles names/times → that's your signal: pivot the demo to the **text/WhatsApp** booking fallback (same backend, same tools, no live voice). Either way you have a real answer and a real demo.

## Saturday afternoon: deploy the backend
1. Push this repo to GitHub.
2. Deploy to Railway, Render, or Fly (any gives you a public HTTPS URL fast). `npm install` then `node src/server.js`; it listens on `$PORT`.
3. Confirm `https://YOUR_BACKEND/` shows the dashboard and the tool endpoints respond (see test commands below).

## Saturday evening: wire the tools into Vapi
1. In `vapi-assistant.js`, replace both `https://YOUR_BACKEND/...` URLs with your deployed URL.
2. Register the two tools in your Vapi assistant (function calling), pointing at those endpoints.
3. Call the number again and run a full booking. Watch the dashboard at `/` — the booking should appear within seconds.

## Sunday: make the call experience excellent
Iterate on the system prompt against real calls. Test the hard cases from the kill-test script:
- Estonian name spoken aloud ("Jüri Õunapuu", "Kärt Müür")
- Spoken time ("pool kaheksa", "veerand üheksa")
- Fully booked slot → does it offer the alternatives the tool returns?
- Party of 12 → does it redirect politely?
- Caller switches to Russian/English mid-call → does the agent follow?
- Off-topic question → does it decline and steer back?

Record 2–3 clean calls (screen + audio) as backup in case live calling fails at the workshop.

---

## Local test commands (verify backend any time)
```bash
PORT=8080 node src/server.js &
# next Friday date:
D=$(node -e "const d=new Date();d.setDate(d.getDate()+((5-d.getDay()+7)%7||7));console.log(d.toISOString().slice(0,10))")
curl -s -X POST localhost:8080/tools/check-availability -H 'content-type: application/json' -d "{\"date\":\"$D\",\"time\":\"19:30\",\"partySize\":4}"
curl -s -X POST localhost:8080/tools/book-table -H 'content-type: application/json' -d "{\"date\":\"$D\",\"time\":\"19:30\",\"partySize\":4,\"name\":\"Jüri Õunapuu\"}"
# open http://localhost:8080/ to see it on the dashboard
```

## Stretch goals (only if the core works and time remains)
- Swap `store.js` for Google Calendar so bookings appear in a real calendar live (great demo moment).
- Add an SMS confirmation via Twilio after `book_table` succeeds.
- Add a second restaurant config to show multi-tenant readiness.
Do NOT build: a config UI, accounts/billing, a mobile app. None of it earns you anything by Sunday.

---

## What to tell the organisers
"You doubted the demand and the depth, fair. On depth: here's a live number, call it and book a table in Estonian right now. The voice tech is built on proven infrastructure (Vapi) so we spent our time on the hard part: Estonian quality and real booking logic that can't hallucinate a table. On demand: Mart and Erik have been talking to [N] restaurant owners this week, here's what they found." Then hand them the phone.
