// Guest SMS confirmation after a booking, via Twilio. Opt-in: only sends when
// the Twilio env vars are set AND the manager has SMS confirmations enabled AND
// we have a phone number. Never throws into the caller; returns {sent, reason}.
//
// Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER (E.164, e.g. +372...).

// Best-effort normalise to E.164. Estonian local numbers (7-8 digits) -> +372.
function toE164(num) {
  if (!num) return null;
  let s = String(num).replace(/[^\d+]/g, "");
  if (!s) return null;
  if (s.startsWith("+")) return s;
  if (s.startsWith("372")) return "+" + s;
  if (s.length === 7 || s.length === 8) return "+372" + s;
  return "+" + s;
}

export async function sendBookingSms(booking, restaurant) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) return { sent: false, reason: "Twilio seadistamata" };
  if (restaurant.smsConfirmations === false) return { sent: false, reason: "SMS välja lülitatud" };
  const to = toE164(booking.phone);
  if (!to) return { sent: false, reason: "Telefoninumber puudub" };

  const body = `Tere${booking.name ? ", " + booking.name : ""}! Teie laud restoranis ${restaurant.name} on kinnitatud: ${booking.date} kell ${booking.time}, ${booking.partySize} inimest. Ootame teid!`;

  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { sent: false, reason: `Twilio ${res.status} ${t.slice(0, 140)}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}
