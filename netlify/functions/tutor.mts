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
- You are an AI. If you are not sure of something, say so and suggest he checks with Papa or the NCERT book.

His NCERT books:
- With most questions you are given excerpts from his own NCERT Class 10 Maths and Science books, each labelled with chapter and page. These are your first and main source. Explain using the book's words, definitions, notation and methods, so his answers match the textbook.
- When you use the excerpts, end with one short line naming the chapters and pages you actually used, for example: "📖 From your NCERT book: Maths Ch 8 (page 3 of the chapter)". Page numbers count from the start of each chapter, not the printed page number. Never invent chapter or page numbers.
- The excerpts are text taken out of PDFs, so fractions, powers and symbols may be jumbled and figures are missing. Read them sensibly, and if a figure matters, tell him which figure to look at in his book.
- If the excerpts do not cover the question, say so in one short line ("This is not in your NCERT chapters, so here is a general explanation."), then help from your own knowledge. Use web search only for facts that need checking or are recent, and say when an answer comes from the web.`;

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

/* ---------- his NCERT books: stored as page text, searched with BM25 for each question ---------- */
type Chunk = { key: string; label: string; p: number; t: string };
type Book = { key: string; subject: string; ch: number; name: string; libAt?: number; at: number; pages: number; chunks: { p: number; t: string }[] };
let BOOKS: { at: number; chunks: Chunk[]; df: Map<string, number>; toks: string[][]; avg: number } | null = null;
const STOP = new Set("a an and are as at be by for from has have how i in is it its of on or that the this to was were what when where which who why will with you your me my do does did can could should would we they them there their then than so if not no yes also into about over under use using find give show explain tell".split(" "));
function words(text: string): string[] {
  return String(text).toLowerCase().replace(/[^a-z0-9θπ°²³√]+/g, " ").split(" ")
    .filter((w) => w && !STOP.has(w))
    .map((w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w));
}
function bookLabel(b: { subject: string; ch: number }) { return (b.subject === "science" ? "Science" : "Maths") + " Ch " + b.ch; }
async function loadBooks(store: ReturnType<typeof getStore>) {
  if (BOOKS && Date.now() - BOOKS.at < 5 * 60_000) return BOOKS;
  const { blobs } = await store.list({ prefix: "book/" });
  const books = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean) as Book[];
  const chunks: Chunk[] = [];
  for (const b of books) for (const c of b.chunks || []) chunks.push({ key: b.key, label: bookLabel(b), p: c.p, t: c.t });
  const toks = chunks.map((c) => words(c.t));
  const df = new Map<string, number>();
  for (const tk of toks) for (const w of new Set(tk)) df.set(w, (df.get(w) || 0) + 1);
  const avg = toks.reduce((a, t) => a + t.length, 0) / Math.max(1, toks.length);
  BOOKS = { at: Date.now(), chunks, df, toks, avg };
  return BOOKS;
}
function search(idx: NonNullable<typeof BOOKS>, query: string, k = 6): Chunk[] {
  const q = [...new Set(words(query))];
  if (!q.length || !idx.chunks.length) return [];
  const N = idx.chunks.length;
  const chMatch = /\b(?:ch(?:apter)?\.?\s*)(\d{1,2})\b/i.exec(query);
  const subj = /\b(maths?|mathematics|trigonometr|algebra|geometr)/i.test(query) ? "Maths" : /\b(science|physics|chemistry|biology)/i.test(query) ? "Science" : "";
  const scored = idx.toks.map((tk, i) => {
    let sc = 0;
    const tf = new Map<string, number>();
    for (const w of tk) tf.set(w, (tf.get(w) || 0) + 1);
    for (const w of q) {
      const f = tf.get(w); if (!f) continue;
      const n = idx.df.get(w) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      sc += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * tk.length / idx.avg));
    }
    const c = idx.chunks[i];
    if (sc && chMatch && c.label.endsWith("Ch " + chMatch[1]) && (!subj || c.label.startsWith(subj))) sc *= 1.6;
    return { i, sc };
  }).filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc);
  if (!scored.length || scored[0].sc < 2) return [];
  return scored.slice(0, k).filter((x) => x.sc >= scored[0].sc * 0.5).map((x) => idx.chunks[x.i]);
}
function chunkPages(pages: { p: number; text: string }[]) { // ~900-character pieces with a little overlap
  const out: { p: number; t: string }[] = [];
  for (const pg of pages) {
    const t = String(pg.text || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (!t) continue;
    for (let i = 0; i < t.length; i += 800) out.push({ p: pg.p, t: t.slice(i, i + 950) });
  }
  return out;
}
let WEB_OK = true; // switched off for this instance if the gateway refuses the web search tool

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

  // which chapters Study Buddy has read
  if (req.method === "GET" && action === "book") {
    const { blobs } = await store.list({ prefix: "book/" });
    const items = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean)
      .map((b: any) => ({ key: b.key, subject: b.subject, ch: b.ch, name: b.name, pages: b.pages, chunks: (b.chunks || []).length, libAt: b.libAt || 0, at: b.at }));
    items.sort((a, b) => (a.subject + String(a.ch).padStart(2, "0")).localeCompare(b.subject + String(b.ch).padStart(2, "0")));
    return json({ items });
  }
  // Papa's iPad sends the text of one chapter, page by page
  if (req.method === "POST" && action === "book") {
    if (!teacher) return fail(403, "Only the teacher can add books.");
    let b: any;
    try { b = await req.json(); } catch { return fail(400, "Bad request."); }
    const subject = String(b.subject || ""), ch = Math.round(Number(b.ch));
    if (!/^(maths|science)$/.test(subject) || !(ch >= 1 && ch <= 20) || !Array.isArray(b.pages)) return fail(400, "Unknown chapter.");
    const pages = b.pages.slice(0, 120).map((x: any) => ({ p: Math.max(1, Math.round(Number(x.p) || 1)), text: String(x.text || "").slice(0, 20000) }));
    const book: Book = { key: subject + "-" + ch, subject, ch, name: String(b.name || "").slice(0, 120), libAt: Number(b.libAt) || 0, at: Date.now(), pages: pages.length, chunks: chunkPages(pages) };
    await store.setJSON("book/" + book.key, book);
    BOOKS = null;
    return json({ key: book.key, chunks: book.chunks.length });
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

  // find the pages of his books that fit this question (and the one before, for follow-ups)
  const prevUser = incoming.slice(0, -1).reverse().find((m) => m.role === "user");
  let found: Chunk[] = [];
  try {
    const idx = await loadBooks(store);
    found = search(idx, String(question.text || ""));
    // a short follow-up ("why?", "and the next step?") is read together with the question before it
    if (!found.length && words(String(question.text || "")).length < 4 && prevUser) found = search(idx, String(question.text || "") + " " + String(prevUser.text || "").slice(0, 300));
  }
  catch (e) { console.error("book search", e); }
  const bookBlock = found.length
    ? "Excerpts from Tanish's NCERT books that match this question:\n\n" + found.map((c, i) => "[" + (i + 1) + "] " + c.label + " (page " + c.p + " of the chapter)\n" + c.t).join("\n\n")
    : "No excerpt from his NCERT books matched this question.";
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
    { type: "text", text: bookBlock },
  ];

  const stream = new ReadableStream({
    async start(controller) {
      let answer = "";
      let used = "";
      const attempts: { model: string; web: boolean }[] = [];
      for (const model of MODELS) { if (WEB_OK) attempts.push({ model, web: true }); attempts.push({ model, web: false }); }
      for (const { model, web } of attempts) {
        if (web && !WEB_OK) continue;
        try {
          const s = client.messages.stream({
            model,
            max_tokens: 4000,
            system,
            output_config: { effort: "medium" },
            ...(web ? { tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }] as Anthropic.ToolUnion[] } : {}),
            messages,
          });
          for await (const ev of s) {
            if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
              answer += ev.delta.text;
              controller.enqueue(enc.encode(ev.delta.text));
            }
          }
          const final = await s.finalMessage();
          used = model + (web ? " + web" : "");
          // list the web pages the answer quoted, if it searched
          const urls = new Map<string, string>();
          for (const b of final.content) if (b.type === "text") for (const c of (b.citations || []) as any[]) if (c.type === "web_search_result_location" && c.url) urls.set(c.url, c.title || c.url);
          if (urls.size) {
            const tail = "\n\n🌐 From the web: " + [...urls].slice(0, 3).map(([u, t]) => t + " (" + u + ")").join("; ");
            answer += tail; controller.enqueue(enc.encode(tail));
          }
          if (final.stop_reason === "refusal" && !answer) {
            answer = "I can't help with that one. Let's get back to your studies. What topic are you working on?";
            controller.enqueue(enc.encode(answer));
          }
          break;
        } catch (e) {
          // a model the gateway does not offer: try the next one, but only before any text was sent
          if (!answer && e instanceof Anthropic.NotFoundError) continue;
          // the gateway may not allow the web search tool: switch it off and ask again without it
          if (!answer && web && e instanceof Anthropic.BadRequestError) { WEB_OK = false; console.warn("web search refused", e.message); continue; }
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
        book: found.map((c) => c.label + " p." + c.p),
      }));
    },
  });
  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
};

export const config: Config = { path: "/api/tutor/*" };
