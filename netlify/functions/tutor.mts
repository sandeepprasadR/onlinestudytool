import Anthropic from "@anthropic-ai/sdk";
import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

// AI tutor for Tanish (Class 10, CBSE/NCERT). Called through Netlify AI Gateway,
// which injects the Anthropic credentials, so no API key is stored here.
// Protected by the same class code as homework. Every question and answer is kept
// so Papa can read them (the student is told this on screen).

const DAILY_LIMIT = 60;
const MODELS = [Netlify.env.get("TUTOR_MODEL") || "claude-opus-5-5", "claude-sonnet-5-5"];

const SYSTEM = `You are "Study Buddy", a friendly, patient tutor for Tanish, a Class 10 student in India (CBSE board, NCERT textbooks). His father teaches him Maths and Science and has set you up to help between classes. Tanish finds Maths and Science hard, so your job is to make difficult ideas click and feel interesting.

How to explain:
- Start from what he already knows, then build up in small steps. Keep each reply short enough to read on a laptop screen without much scrolling.
- Use vivid everyday examples from Indian life: cricket, kites, trains, cooking, festivals, monsoon, mobile phones, bikes, shops and money in rupees.
- Add one surprising fact, short story or real-world use when it helps the idea stick.
- Use plain words. When a term is needed, say what it means.
- Stick to the NCERT Class 10 syllabus and methods, so his answers match what the board expects. Mention the NCERT chapter when it helps.
- Write maths in plain text that reads well without special rendering: x², √3, 1/2, sin 30° = 1/2, θ, π, ≤, ≥. Do not use LaTeX or $ signs.
- Use **bold** for key words, and short numbered steps for working. No tables.

When he asks you to solve a homework or exercise question:
- Do not hand over the full final answer straight away. Give a hint or the first step, ask him to try the next step, and check his attempt. If he is still stuck after trying, show the full working and explain each step.
- If he sends a photo of his working, find the first mistake, explain it kindly, and let him fix it.

End most replies with one quick question to check understanding, or a small practice question.

Boundaries:
- You help with school learning: Maths, Science and other Class 10 subjects, study skills, exam preparation and doubts. If asked about something unrelated, answer very briefly if it is harmless, then steer back to studies.
- Keep everything age-appropriate for a 15-year-old. Do not help with anything harmful, unsafe, or dishonest (for example, cheating in a test).
- If he seems stressed, upset, or mentions anything worrying about his safety or wellbeing, respond warmly, encourage him to talk to Papa, his mother, or a trusted teacher or warden, and do not try to handle it alone.
- You are an AI. If you are not sure of something, say so and suggest he checks with Papa or the NCERT book.`;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (status: number, error: string) => json({ error }, status);

function same(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10); // India date

type InMsg = { role: "user" | "assistant"; text: string; image?: { type: string; data: string } };

export default async (req: Request, context: Context) => {
  const classCode = Netlify.env.get("CLASS_CODE") || "";
  const teacherPin = Netlify.env.get("TEACHER_PIN") || "";
  if (!classCode || !same(req.headers.get("x-class-code") || "", classCode)) return fail(401, "Wrong class code.");
  const teacher = same(req.headers.get("x-teacher-pin") || "", teacherPin);
  const store = getStore({ name: "homework", consistency: "strong" });
  const action = new URL(req.url).pathname.replace(/^\/api\/tutor\/?/, "");

  // Papa can read what was asked and answered
  if (req.method === "GET" && action === "log") {
    if (!teacher) return fail(403, "Only the teacher can read the tutor log.");
    const { blobs } = await store.list({ prefix: "tutor/" });
    const keys = blobs.map((b) => b.key).sort().slice(-200);
    const items = (await Promise.all(keys.map((k) => store.get(k, { type: "json" })))).filter(Boolean);
    return json({ items: items.reverse() });
  }

  if (req.method !== "POST") return fail(404, "Unknown request.");
  if (!process.env.ANTHROPIC_BASE_URL && !process.env.ANTHROPIC_API_KEY) {
    return fail(503, "The AI tutor is not switched on yet. In Netlify, AI Gateway needs to be enabled for this site.");
  }

  let body: { messages?: InMsg[] };
  try { body = await req.json(); } catch { return fail(400, "Bad request."); }
  const incoming = (body.messages || []).slice(-16);
  if (!incoming.length || incoming[incoming.length - 1].role !== "user") return fail(400, "Type a question first.");

  const day = today();
  const { blobs: todays } = await store.list({ prefix: "tutor/" + day + "/" });
  if (todays.length >= DAILY_LIMIT) return fail(429, "That is enough questions with the tutor for today. Write the rest down and ask Papa in tomorrow's class.");

  const messages: Anthropic.MessageParam[] = [];
  for (let i = 0; i < incoming.length; i++) {
    const m = incoming[i];
    const role = m.role === "assistant" ? "assistant" : "user";
    const text = String(m.text || "").slice(0, 4000);
    const isLast = i === incoming.length - 1;
    if (role === "user" && isLast && m.image && /^image\/(jpeg|png|webp)$/.test(m.image.type) && m.image.data.length < 2_000_000) {
      messages.push({ role, content: [
        { type: "image", source: { type: "base64", media_type: m.image.type as "image/jpeg" | "image/png" | "image/webp", data: m.image.data } },
        { type: "text", text: text || "Please look at this and help me understand it." },
      ] });
    } else if (text) {
      messages.push({ role, content: text });
    }
  }
  if (!messages.length || messages[0].role !== "user") return fail(400, "Type a question first.");

  const client = new Anthropic();
  const question = incoming[incoming.length - 1];
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let answer = "";
      let used = "";
      for (const model of MODELS) {
        try {
          const s = client.messages.stream({
            model,
            max_tokens: 4000,
            system: SYSTEM,
            output_config: { effort: "medium" },
            messages,
          });
          for await (const ev of s) {
            if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
              answer += ev.delta.text;
              controller.enqueue(enc.encode(ev.delta.text));
            }
          }
          const final = await s.finalMessage();
          used = model;
          if (final.stop_reason === "refusal" && !answer) {
            answer = "I can't help with that one. Let's get back to your studies. What topic are you working on?";
            controller.enqueue(enc.encode(answer));
          }
          break;
        } catch (e) {
          // a model the gateway does not offer: try the next one, but only before any text was sent
          if (!answer && e instanceof Anthropic.NotFoundError) continue;
          console.error("tutor error", e);
          const msg = e instanceof Anthropic.RateLimitError
            ? "\n\nThe tutor is busy right now. Try again in a minute."
            : "\n\nSorry, something went wrong. Try asking again.";
          controller.enqueue(enc.encode(msg));
          answer += msg;
          break;
        }
      }
      controller.close();
      const at = Date.now();
      context.waitUntil(store.setJSON("tutor/" + day + "/" + at + "-" + Math.random().toString(36).slice(2, 6), {
        at, question: String(question.text || "").slice(0, 4000), hadImage: !!question.image, answer, model: used,
      }));
    },
  });
  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
};

export const config: Config = { path: "/api/tutor/*" };
