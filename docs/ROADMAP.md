# Aino roadmap — toward Bonnie-parity

Goal: make Aino functionally similar to bonnie.ai (an Estonian-first AI phone host for
restaurants). Source of this plan: Bonnie's marketing site, product tour video, and support hub.

## Strategic stance
- **Aino owns the booking logic** (our backend is the source of truth). Bonnie is an *integration
  layer* that writes into the venue's existing reservation system. Lean into our difference: Aino
  works **standalone, zero integrations** on day one. External reservation-system sync (Google
  Calendar first) is an *optional, late* phase — never a prerequisite.
- **Zero-key** for now: prompt/config changes reach the live assistant via the **copy-to-Vapi** box;
  booking *rules* apply instantly (the tools read live config). Call *data* comes from **Vapi
  webhooks** (pushed to us, verified by a shared secret) — no account API key held. We only revisit
  holding the Vapi private key (for auto-sync) once there's auth (Phase 6).

## Bonnie reference structure
- Left nav: **Dashboard** (analytics) · **Conversations** (transcripts/summaries) · **Assistants** ·
  **Notes**.
- Assistant = **7 tabs**: Business information · Personality · **Tasks** (do-this-when-that, incl.
  transfers) · FAQ (knowledge) · Telephony · Integrations · Notifications.
- Conversation detail: transcript · summary (topic + outcome) · duration · reservation
  made/changed/cancelled · transferred + to whom · **call-ID** · notes.
- Personality: language + extra languages (keypad), 30+ voices w/ preview, pronunciation dict,
  **dynamic greeting** + tone presets, auto-detect caller language (country code, English fallback),
  personalized greeting, custom persona name.
- Satisfaction KPI = assistant **asks the caller** "did I help?"; captured per call.
- Onboarding: concierge-assisted 6-step (business info from Google → reservation system → phone
  number → payment/trial → assistant → languages); in-app support chat.

## Phases (in order)

### Phase 1 — Assistant config depth (prompt-driven, no new infra) ← IN PROGRESS
Restructure **Seaded** toward Bonnie's tabs and add config that flows into the generated prompt
(applied via copy-to-Vapi):
- **FAQ** (knowledge): list of Q→A. ← started here.
- **Tasks** (actions): list of "when X, do Y" instructions (e.g. share Maps link via WhatsApp;
  transfer event enquiries). Distinct from FAQ.
- **Greeting tone** presets (otsekohene / soe / ametlik / hõivatud) + dynamic greeting.
- Small Business-info/Personality fields later: email, timezone, persona name, personalized vs
  dynamic greeting, auto-detect language.
- Files: [src/config.js](src/config.js) (fields + validation), [src/vapi-assistant.js](src/vapi-assistant.js)
  (`buildSystemPrompt` injection), [src/server.js](src/server.js) (Seaded editors + client JS).

### Phase 2 — Conversations via Vapi webhook (backbone)
`POST /vapi/webhook` (verify shared secret) ingests `end-of-call-report`: transcript, summary,
topic, outcome, duration, caller, reservation action, transfer info, call-ID. Store + show a
**Conversations** section (list + detail) and per-call **Notes**. Have the assistant ask "kas sain
aidata?" so we capture satisfaction. One-time manual setup in Vapi (server URL + secret).

### Phase 3 — Analytics dashboard
Upgrade **Ülevaade** to Bonnie-style: KPI cards (calls, call time, reservations, satisfaction,
transfer rate), Call Volume Over Time chart, peak times — from Phase 2 data + bookings.

### Phase 4 — Guest follow-ups
SMS confirmation after booking (Twilio), then WhatsApp. *(Introduces Twilio credential.)*

### Phase 5 — Call handling + summaries
Smart **transfer-to-human** (fallback number + transfer task in prompt/Vapi); **daily summary
email** digest. *(Email sender + cron.)*

### Phase 6 — Productization
Multi-restaurant / **multiple assistants**, **auth/accounts**, **Revisions** (config history),
**Customers** (caller CRM), **Integrations** (Google Calendar sync first), onboarding wizard,
billing/trial, in-app support chat. Optionally re-enable Vapi auto-sync behind auth.

## Credentials introduced per phase
P1 none · P2 Vapi webhook secret (low risk) · P4 Twilio · P5 email · P6 Vapi private key + auth.
