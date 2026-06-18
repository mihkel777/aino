// Vapi assistant configuration for Aino, restaurant table booking, Estonian-first.
// Paste the systemPrompt into your Vapi assistant, and register the two tools
// pointing at your deployed backend's /tools/* endpoints.
//
// HOW THE PIECES FIT (say this to the organisers):
//   Vapi owns the phone number + the real-time listen/think/speak loop.
//   STT: Estonian (Azure et-EE primary; test ElevenLabs/Deepgram Estonian too).
//   LLM: Claude, with the two tools below.
//   TTS: Estonian neural voice (Azure Anu or ElevenLabs Estonian).
//   Booking truth lives in OUR backend, not in the model. The model gathers
//   info and calls tools; the backend decides what is actually bookable.

// Human-readable opening-hours summary (Monday-first) for the prompt.
const DAY_ET = { 0: "P", 1: "E", 2: "T", 3: "K", 4: "N", 5: "R", 6: "L" };
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function hoursSummary(restaurant) {
  return DAY_ORDER.map((d) => {
    const h = restaurant.hours[d];
    return `${DAY_ET[d]} ${h ? `${h.open}–${h.close}` : "suletud"}`;
  }).join(", ");
}

// Greeting/conversation tone, chosen in the dashboard, mapped to a prompt line.
const TONE_INSTRUCTIONS = {
  otsekohene: "Ole otsekohene ja napisõnaline.",
  soe: "Ole soe, sõbralik ja külalislahke.",
  ametlik: "Ole viisakas ja ametlik.",
  hõivatud: "Ole kiire ja abivalmis, nagu kiirel õhtul saalis.",
};

function faqBlock(restaurant) {
  const faqs = restaurant.faqs || [];
  if (!faqs.length) return "";
  return (
    "\n\nKORDUMA KIPPUVAD KÜSIMUSED (vasta nende põhjal, kui klient küsib):\n" +
    faqs.map((f) => `- K: ${f.q}\n  V: ${f.a}`).join("\n")
  );
}

function taskBlock(restaurant) {
  const tasks = restaurant.tasks || [];
  if (!tasks.length) return "";
  return (
    "\n\nÜLESANDED (täida, kui olukord sobib):\n" + tasks.map((t) => `- ${t}`).join("\n")
  );
}

// Build the system prompt from the current restaurant config. The manager's
// dashboard settings (name, hours, max party size) flow into the live bot here.
export function buildSystemPrompt(restaurant) {
  return `Sa oled restorani "${restaurant.name}" virtuaalne assistent telefonis. Sa vastad klientide kõnedele ja aitad lauda broneerida.

TERVITUS (KOHUSTUSLIK):
- Alusta iga kõnet ühe lühikese lausega, milles ütled selgelt, et oled tehisintellekt. Näide: "Tere, siin ${restaurant.name} tehisintellekti-assistent — kuidas saan teid aidata?" (EL tehisintellekti määruse läbipaistvusnõue.)

ROLL JA TOON:
- Räägi loomulikus, sõbralikus eesti keeles. Ole lühike ja selge, nagu hea administraator telefonis.
- ${TONE_INSTRUCTIONS[restaurant.greetingTone] || TONE_INSTRUCTIONS.soe}
- Vasta võimalikult lühidalt: tavaliselt üks lause. Küsi korraga ainult üht asja. Ära korda üle seda, mida pole vaja. (Lühike vastus = kiirem kõne.)

SINU AINUS ÜLESANNE on lauabroneeringud ja restorani kohta käivad lihtsad küsimused (lahtiolekuajad, asukoht). Kõige muu puhul ütle viisakalt, et see ei kuulu sinu pädevusse, ja paku, et keegi võtab kliendiga ühendust.

LAHTIOLEKUAJAD: ${hoursSummary(restaurant)}.

BRONEERIMISE REEGLID:
- Broneeringuks on sul vaja: kuupäev, kellaaeg, inimeste arv ja nimi.
- Küsi need rahulikult, ükshaaval, mitte kõiki korraga.
- ÄRA KUNAGI kinnita vaba lauda ise. Kontrolli alati saadavust tööriistaga "check_availability" enne kui ütled, et aeg on vaba.
- Alles siis kui klient on aja kinnitanud JA sul on nimi, kutsu tööriist "book_table".
- Ütle broneering kinnitatuks alles siis, kui "book_table" tagastab booked: true. Loe kliendile lõpuks broneering üle (nimi, kuupäev, kellaaeg, inimeste arv).

KELLAAEG JA KUUPÄEV:
- Kuupäeva pead tööriistale andma kujul YYYY-MM-DD. Arvuta suhtelised kuupäevad ("reedel", "homme") ise välja tänase kuupäeva põhjal.
- Kellaaja anna kujul HH:MM 24-tunni formaadis (näiteks "pool kaheksa õhtul" = "19:30").

ARVUDE HÄÄLDAMINE (TÄHTIS):
- Kliendile rääkides ütle KÕIK arvud, kellaajad ja kuupäevad sõnadega eesti keeles (näiteks "neli inimest", "pool kaheksa", "kell üheksateist", "reedel, kuueteistkümnendal juunil"). ÄRA kasuta kõnes numbreid (mitte "4", "19:30").
- Tööriistadele (check_availability, book_table) anna arvud siiski numbritena: kuupäev kujul YYYY-MM-DD, kellaaeg kujul HH:MM, inimeste arv täisarvuna.

KUI AEG POLE VABA:
- Tööriist annab sulle lähimad vabad ajad. Paku need kliendile.

KUI SELTSKOND ON SUUR:
- Üle ${restaurant.maxPartySize} inimese: ütle, et suuremad seltskonnad palun broneerigu kodulehel, ja paku abi väiksema lauaga.${faqBlock(restaurant)}${taskBlock(restaurant)}

Ära leiuta infot, mida sul pole. Kui sa midagi ei tea, ütle seda ausalt.`;
}

// First message the agent speaks when it picks up.
// Discloses up front that the caller is talking to an AI (EU AI Act, Art. 50 transparency).
export function buildFirstMessage(restaurant) {
  return `Tere, siin ${restaurant.name} tehisintellekti-assistent — kuidas saan teid aidata?`;
}

// Tool definitions to register in Vapi (function calling).
export const tools = [
  {
    type: "function",
    function: {
      name: "check_availability",
      description:
        "Kontrolli, kas restoranis on vaba laud antud kuupäeval, kellaajal ja inimeste arvule. Kutsu see ALATI enne kui kinnitad kliendile vaba aega.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "Kuupäev kujul YYYY-MM-DD" },
          time: { type: "string", description: "Kellaaeg kujul HH:MM (24h)" },
          partySize: { type: "integer", description: "Inimeste arv" },
        },
        required: ["date", "time", "partySize"],
      },
    },
    server: { url: "https://YOUR_BACKEND/tools/check-availability" },
  },
  {
    type: "function",
    function: {
      name: "book_table",
      description:
        "Tee tegelik lauabroneering. Kutsu alles siis, kui klient on aja kinnitanud ja sul on nimi.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "Kuupäev kujul YYYY-MM-DD" },
          time: { type: "string", description: "Kellaaeg kujul HH:MM (24h)" },
          partySize: { type: "integer", description: "Inimeste arv" },
          name: { type: "string", description: "Broneeringu nimi" },
          phone: { type: "string", description: "Telefoninumber (valikuline)" },
        },
        required: ["date", "time", "partySize", "name"],
      },
    },
    server: { url: "https://YOUR_BACKEND/tools/book-table" },
  },
];
