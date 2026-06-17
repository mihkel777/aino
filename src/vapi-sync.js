// Best-effort sync of the live Vapi assistant from our restaurant config.
// On save we push the regenerated system prompt + first message to Vapi.
//
// IMPORTANT: PATCH /assistant/{id} replaces the whole `model` object if you send
// a partial one — which would wipe the assistant's tools. So we GET the assistant
// first, change ONLY model.messages (the system message) and firstMessage, and
// PATCH the full model back, preserving provider/model/tools/etc.
//
// This never throws into the request path: if the key is missing or Vapi errors,
// it returns { synced:false, reason } and the config save still succeeds.

import { buildSystemPrompt, buildFirstMessage } from "./vapi-assistant.js";

const API = "https://api.vapi.ai";

export async function syncAssistant(restaurant) {
  const key = process.env.VAPI_PRIVATE_KEY;
  const id = process.env.VAPI_ASSISTANT_ID;
  if (!key) return { synced: false, reason: "VAPI_PRIVATE_KEY puudub" };
  if (!id) return { synced: false, reason: "VAPI_ASSISTANT_ID puudub" };

  const auth = { Authorization: `Bearer ${key}` };

  try {
    // 1. Fetch the current assistant so we don't clobber tools/voice/model.
    const getRes = await fetch(`${API}/assistant/${id}`, { headers: auth });
    if (!getRes.ok) {
      return { synced: false, reason: `Vapi GET ${getRes.status}` };
    }
    const assistant = await getRes.json();

    // 2. Replace only the system message inside the existing model object.
    const model = assistant.model || {};
    const messages = Array.isArray(model.messages) ? [...model.messages] : [];
    const systemContent = buildSystemPrompt(restaurant);
    const sysIdx = messages.findIndex((m) => m.role === "system");
    if (sysIdx >= 0) messages[sysIdx] = { ...messages[sysIdx], content: systemContent };
    else messages.unshift({ role: "system", content: systemContent });

    // 3. PATCH back the full model (tools preserved) + the new first message.
    const patchRes = await fetch(`${API}/assistant/${id}`, {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        model: { ...model, messages },
        firstMessage: buildFirstMessage(restaurant),
      }),
    });
    if (!patchRes.ok) {
      const body = await patchRes.text().catch(() => "");
      return { synced: false, reason: `Vapi PATCH ${patchRes.status} ${body.slice(0, 120)}` };
    }
    return { synced: true };
  } catch (e) {
    return { synced: false, reason: e.message };
  }
}
