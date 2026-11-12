import Anthropic from "@anthropic-ai/sdk";
import type { getStore } from "@netlify/blobs";

// Shared by the tutor, the question-paper reader and the mock-exam jobs.
// Claude is reached through Netlify AI Gateway (no API key stored here).

type Store = ReturnType<typeof getStore>;
export const istDay = (off = 0) => new Date(Date.now() + 5.5 * 3600_000 + off * 86400_000).toISOString().slice(0, 10);

// Estimated cost at Anthropic list prices, US dollars per million tokens (cache writes 1.25x input,
// web search $10 per 1,000). The real bill comes from Netlify AI Gateway and can differ.
const PRICES: Record<string, { in: number; out: number; cr: number }> = {
  "claude-opus-5-5": { in: 4, out: 20, cr: 0.2 },
  "claude-sonnet-5-5": { in: 2, out: 10, cr: 0.2 },
};
export function costOf(model: string, u: any): number {
  if (!u) return 0;
  const p = PRICES[model] || PRICES["claude-opus-5-5"];
  const web = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
  return ((u.input_tokens || 0) * p.in + (u.cache_creation_input_tokens || 0) * p.in * 1.25 + (u.cache_read_input_tokens || 0) * p.cr + (u.output_tokens || 0) * p.out) / 1e6 + web * 0.01;
}

// Spend that is not a Study Buddy question (reading scanned papers, writing and marking mock exams)
// goes into the same daily and running totals, so Papa's spend card stays complete.
export async function addCost(store: Store, who: "student" | "teacher", usd: number, kind: "ocr" | "exam" | "hwmark") {
  if (!usd) return;
  const day = istDay();
  for (const key of ["usage/day/" + day, "usage/total"]) {
    const u: any = (await store.get(key, { type: "json" })) || {};
    if (key === "usage/total" && !u.since) u.since = Date.now();
    const t = (u[who] = Object.assign({ q: 0, photos: 0, usd: 0, photoUsd: 0, textUsd: 0 }, u[who] || {}));
    t.usd += usd;
    t[kind + "Usd"] = (t[kind + "Usd"] || 0) + usd;
    t[kind + "N"] = (t[kind + "N"] || 0) + 1;
    await store.setJSON(key, u);
  }
}

// One request to Claude, streamed (long answers), falling back to the next model if the gateway does not offer one.
export async function ask(opts: { system: string; content: Anthropic.ContentBlockParam[] | string; maxTokens: number; models?: string[]; effort?: "low" | "medium" | "high" }) {
  const client = new Anthropic();
  const models = opts.models || [Netlify.env.get("TUTOR_MODEL") || "claude-opus-5-5", "claude-sonnet-5-5"];
  let last: unknown = null;
  for (const model of models) {
    try {
      const s = client.messages.stream({
        model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        output_config: { effort: opts.effort || "medium" },
        messages: [{ role: "user", content: opts.content }],
      });
      const final = await s.finalMessage();
      const text = final.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      return { text, usd: costOf(model, final.usage), model, stop: final.stop_reason };
    } catch (e) {
      last = e;
      if (e instanceof Anthropic.NotFoundError) continue;
      throw e;
    }
  }
  throw last;
}

// The model is asked for JSON only; take the outermost object even if it added a fence or a sentence.
export function parseJson(text: string): any {
  const t = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON in the answer");
  return JSON.parse(t.slice(a, b + 1));
}
