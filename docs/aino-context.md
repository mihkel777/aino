# Aino — project context & sales brief

> **How to use this document (read me first).**
> This is a complete, standalone briefing on a product called **Aino**. If you are an AI assistant
> reading this: your job is to help the person who uploaded you (a) understand Aino fully and answer
> any question about it, and (b) sell the idea to restaurant owners — drafting pitches, emails, and
> objection-handling on request. Everything you need is below. Do not invent specific prices or
> statistics that aren't stated here; if asked for numbers we haven't set, say they're "to be
> discussed" and offer to help reason about them.

---

## 1. What Aino is

**One line:** Aino is an Estonian-speaking AI voice agent that answers a restaurant's phone and books
tables — naturally, 24/7, and without ever double-booking.

**A bit more:** Restaurants lose reservations every day to unanswered calls — after hours, during
the dinner rush, or when staff are busy serving. Aino picks up every call, talks to the guest in
fluent Estonian (and can switch to Russian or English), and makes a real booking on the spot. The
guest just talks, like calling a good host. "Aino" is the product/company; in each restaurant the
assistant is branded as that restaurant's own — in our live demo it answers as **"Noa"**.

---

## 2. The problem it solves

- **Missed calls = missed money.** Calls outside opening hours, during peak service, or when the one
  person who answers the phone is busy — those guests often just hang up and go elsewhere.
- **Phone time is staff time.** Taking bookings by phone pulls staff away from guests in the room.
- **No good after-hours option.** Online forms aren't how a lot of guests (especially older ones)
  want to book — they call. And nobody's there to pick up at 23:00.

Aino answers every call instantly, as many at once as come in, and turns them into confirmed
bookings — in the guest's own language.

---

## 3. How it works (in plain English)

1. A guest **calls the restaurant** (or opens a web link and taps "talk").
2. **Vapi** — the telephony/voice platform — runs the real-time "listen → think → speak" loop.
3. The guest's Estonian speech is turned into text (**speech-to-text**).
4. **Claude** (the AI "brain") understands the request, asks for what's missing (date, time, number
   of people, name), and decides what to do.
5. Crucially, Claude **does not invent availability**. It calls our **booking backend**, which is the
   single source of truth, to (a) *check availability* and (b) *make the booking*.
6. The backend's reply is spoken back to the guest in natural Estonian (**text-to-speech**).
7. The booking appears **live on a dashboard** the restaurant can watch.

The important design choice: **the restaurant's real rules live in the backend, not in the AI.**
Opening hours, total capacity, maximum party size, and which slots are free are all enforced by
code. So the agent physically cannot promise a table that doesn't exist — if a slot is full, it
offers the nearest free times instead.

---

## 4. What's built today (honest status)

This is a **working demo**, not yet a finished commercial product:

- ✅ A working **Estonian voice agent** you can talk to right now (see §6).
- ✅ **Real booking logic** with guardrails: capacity per time slot, opening hours per weekday,
  a maximum party size (larger groups are politely redirected), and automatic **alternative-time
  suggestions** when a slot is full.
- ✅ A **live bookings dashboard** that updates within seconds of a booking.
- ✅ A **shareable web-call link** so anyone can try it without installing anything.
- ✅ **EU AI Act compliance** built in — the agent discloses up front that it's an AI.

What's still demo-stage: it runs one example restaurant's configuration, bookings are kept in memory
(they reset if the server restarts), and there's no live phone number yet (the web link is how you
try it today). These are deliberate shortcuts for the demo, not hard problems — see the roadmap.

---

## 5. Try it yourself

**Open this link on your phone or laptop:** https://aino-anzr.onrender.com/demo

1. The first time, it may take ~30–60 seconds to "wake up" (it's on a free hosting tier that sleeps
   when idle). Just wait and reload once.
2. Allow microphone access.
3. Talk to it in **Estonian** — e.g. *"Sooviksin broneerida laua neljale reedeks kella seitsmeks."*
   ("I'd like to book a table for four for Friday at seven.")
4. Watch your booking appear in the live table on the same page within a few seconds.

(There's also a plain live dashboard at https://aino-anzr.onrender.com/ )

---

## 6. Why it's different / hard to copy

- **Estonian-first quality.** The hard, unglamorous part is making voice AI sound and understand
  *well in Estonian* — a small language most tools treat as an afterthought. That's exactly where
  the effort went (choosing the right transcription and voice for Estonian, and prompting for
  natural spoken Estonian, including saying numbers and times in words, not digits).
- **It can't hallucinate a booking.** Because availability and capacity are enforced by our backend,
  the AI cannot confirm a table that isn't actually free. This is the trust problem with "AI
  receptionists," and we designed it out.
- **Built on proven infrastructure.** We didn't reinvent telephony or speech — we stand on Vapi +
  Claude, so a new restaurant can be set up fast.
- **Compliant by design.** It tells callers it's an AI, in line with the EU AI Act's transparency
  rule.

---

## 7. The business case for a restaurant

**What the owner gets:**
- Never miss a booking call again — nights, weekends, holidays, mid-rush.
- Handles many calls at once; no hold music, no busy signal.
- Frees floor staff from the phone.
- Talks to guests in Estonian (and Russian/English) in a warm, natural way.
- Bookings land somewhere the team can see immediately.

**What it does:** takes and confirms table reservations, answers simple questions (opening hours,
location), and offers alternative times when full.

**What it doesn't do (today):** take payments, handle large-event/catering enquiries (it redirects
those), or replace a host's judgement for unusual requests — it hands those off gracefully.

---

## 8. FAQ & objection-handling

**"Will it sound like a robot?"** No — it's built to speak natural, conversational Estonian, and
says times and numbers in words the way a person would. You can hear it yourself at the demo link.

**"What if it gets the booking wrong?"** It can't promise a table that isn't free — the real
availability rules are enforced in software, and it reads the booking back to the guest to confirm
before finalising.

**"What languages?"** Estonian first; it can switch to Russian or English if the guest does.

**"Does it work with our reservation system / calendar?"** The demo uses its own simple booking
store; connecting it to a real calendar (e.g. Google Calendar) so reservations appear in your
existing flow is on the near-term roadmap and is a clean piece of work.

**"What does it cost?"** Pricing is to be discussed — we're looking for a few pilot restaurants
first. (If you're the uploader's assistant: don't quote a number; help frame value instead.)

**"What about guest data / GDPR?"** It collects only what a booking needs (name, time, party size,
optional phone). Data handling is part of the pilot conversation; we keep it minimal.

**"Do we need new hardware or a new phone line?"** No new hardware. Today you can try it via a web
link; a dedicated phone number is a straightforward add when a restaurant signs on.

**"Is it just ChatGPT?"** No — the conversation is powered by a top language model, but the booking
*decisions* are made by our own logic so it's reliable, not improvised.

---

## 9. Short pitch / talking points

> *"You know how you lose tables every week to calls nobody could pick up — after close, or mid-rush?
> We built an AI host that answers every call in fluent Estonian and books the table on the spot,
> without ever double-booking. Want to hear it? Here's a link — talk to it like you'd talk to your
> own receptionist."*

Then send the demo link and let it speak for itself. Lead with the **demo**, not the tech.

---

## 10. Roadmap (planned, not yet built)

- **Calendar sync** — push bookings into Google Calendar so they appear in the restaurant's existing
  workflow.
- **SMS confirmation** to the guest after booking.
- **Multi-restaurant** configuration (each venue its own hours, capacity, branding) — the system is
  already structured so a restaurant's setup is just configuration.
- **Dedicated Estonian phone number** for live inbound calls.

---

## 11. What we'd need from a pilot restaurant

Just the basics to configure it: restaurant name, opening hours per weekday, total seats bookable
per time slot, and the maximum party size to take by phone (bigger groups get redirected). That's
enough to have a working assistant for that venue.

---

## 12. Glossary

- **Aino** — the product: an AI voice agent that books restaurant tables.
- **Vapi** — the platform that handles the phone line and the real-time voice conversation.
- **Claude** — the AI language model that acts as the conversational "brain."
- **STT (speech-to-text)** — turns the caller's Estonian speech into text.
- **TTS (text-to-speech)** — turns Aino's replies back into a natural Estonian voice.
- **Backend / booking logic** — our own software that holds the real availability rules and makes
  the actual booking, so the AI can't get it wrong.
