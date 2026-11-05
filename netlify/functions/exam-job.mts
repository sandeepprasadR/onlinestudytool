import { getStore } from "@netlify/blobs";
import type { Config } from "@netlify/functions";
import type Anthropic from "@anthropic-ai/sdk";
import { ask, addCost, parseJson } from "../lib/ai.mts";

// Background job (up to 15 minutes): writes a mock paper, or marks the photographed answers.
// Results go into the exam record; the app polls for them.

function same(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const SUBJ: Record<string, string> = { maths: "Mathematics (Standard)", science: "Science" };

const SHAPE = `Return ONLY one JSON object, no other text:
{"title": string, "minutes": number, "marks": number, "instructions": [string],
 "sections": [{"name": "Section A", "note": string, "questions": [
   {"n": 1, "marks": 1, "type": "mcq" | "assertion" | "short" | "long" | "case", "ch": chapter number, "text": string,
    "options": [4 strings, only for mcq and assertion], "from": "label of the bank question it is based on, or empty",
    "answer": string, "scheme": string,
    "or": {"text": string, "answer": string, "scheme": string} (only when the question has an internal choice)}]}]}
"answer" is the final answer (for MCQ the letter and the option). "scheme" is the marking scheme in CBSE style: each step with the marks it earns, adding up to the question's marks.
Write maths in plain text (x², √3, 3/4, θ, π, ≤), no LaTeX. Case-study questions have the case text, then sub-parts (i), (ii), (iii) with their marks in the text.`;

async function generate(store: ReturnType<typeof getStore>, e: any) {
  const { blobs } = await store.list({ prefix: "paper/" });
  const papers = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter((p: any) => p && p.subject === e.subject) as any[];
  const sample = papers.filter((p) => p.kind === "sample").sort((a, b) => b.at - a.at)[0];
  const chs = new Set(e.chapters.map((c: any) => c.n));
  const bank: string[] = [];
  for (const p of papers.filter((p) => p.kind !== "sample")) for (const q of p.questions || []) if (!q.ch || chs.has(q.ch)) bank.push("[" + p.title + " Q" + q.n + ", " + (q.marks || "?") + " marks, ch " + (q.ch || "?") + "] " + q.t.slice(0, 700));
  const bankText = bank.sort(() => Math.random() - 0.5).slice(0, 60).join("\n\n");
  const chapterList = e.chapters.map((c: any) => c.n + ". " + c.name).join("\n");
  const pattern = e.type === "full"
    ? "A full mock board exam: 80 marks, 3 hours. Follow the pattern of the CBSE sample paper below exactly: the same sections, number of questions, question types, marks per question and internal choices. Cover the whole syllabus in about the same proportion as the sample paper."
    : "A chapter test of " + e.marks + " marks in " + e.minutes + " minutes on only these chapters. Use the question types of the CBSE sample paper below (MCQs and assertion-reason of 1 mark, then 2, 3 and 5 marks" + (e.marks >= 30 ? ", and one 4-mark case study" : "") + "), in sections like the board paper.";
  const user = "Write a " + SUBJ[e.subject] + " paper for Tanish, a Class 10 CBSE student.\n\n" + pattern +
    "\n\nChapters:\n" + chapterList +
    "\n\nAbout a third of the questions should be based on real questions from his question bank below where they fit the pattern (adjust numbers or the marks to fit, and give the bank label in \"from\"). Write the rest yourself in CBSE board style and difficulty, with fresh numbers. Do not copy the sample paper's own questions. Avoid questions that need a drawn figure unless the figure is fully described in words." +
    "\n\n" + SHAPE +
    (sample ? "\n\nCBSE SAMPLE PAPER (follow its pattern):\n" + String(sample.text).slice(0, 30000) : "\n\n(No sample paper uploaded: use the current CBSE Class 10 board pattern.)") +
    (bankText ? "\n\nQUESTION BANK (his board papers):\n" + bankText : "");
  const r = await ask({ system: "You are an experienced CBSE Class 10 paper setter and examiner. You write fair, syllabus-accurate papers with complete marking schemes.", content: user, maxTokens: 32000, effort: "medium" });
  await addCost(store, e.by === "teacher" ? "teacher" : "student", r.usd, "exam");
  const paper = parseJson(r.text);
  if (!Array.isArray(paper.sections) || !paper.sections.length) throw new Error("paper has no sections");
  const total = paper.sections.reduce((a: number, s: any) => a + (s.questions || []).reduce((b: number, q: any) => b + (Number(q.marks) || 0), 0), 0);
  return { ...e, status: "ready", paper, title: String(paper.title || "").slice(0, 120) || (e.type === "full" ? "Full mock paper" : "Chapter test"), marks: total || e.marks, minutes: Number(paper.minutes) || e.minutes, writtenAt: Date.now(), cost: r.usd };
}

async function mark(store: ReturnType<typeof getStore>, e: any) {
  const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: "QUESTION PAPER with answers and marking scheme:\n" + JSON.stringify(e.paper) }];
  let n = 0;
  for (const id of e.imgs || []) {
    const got = await store.getWithMetadata("img/" + id, { type: "arrayBuffer" });
    if (!got || !got.data) continue;
    const type = String((got.metadata as any)?.type || "image/jpeg");
    if (!/^image\/(jpeg|png|webp)$/.test(type)) continue;
    content.push({ type: "text", text: "Answer sheet photo " + (++n) + ":" }, { type: "image", source: { type: "base64", media_type: type as "image/jpeg", data: (globalThis as any).Buffer.from(got.data as ArrayBuffer).toString("base64") } });
  }
  if (!n) throw new Error("no answer photos found");
  content.push({ type: "text", text: `Mark Tanish's handwritten answers strictly by the marking scheme, as a fair CBSE examiner: give step marks for correct working even if the final answer is wrong; 0 for a question not attempted. Where he answered one part of an internal choice, mark that part. If a photo is unreadable, say so for those questions.
Return ONLY JSON:
{"results": [{"n": question number, "got": marks, "of": marks, "note": "one short line: what was right or the first mistake"}],
 "total": number, "outOf": number,
 "summary": "2 or 3 encouraging, honest sentences for Tanish",
 "strong": ["topic"], "weak": [{"ch": chapter number, "topic": "short topic", "why": "short reason"}],
 "next": ["3 short, concrete things to practise next"]}` });
  const r = await ask({ system: "You are a fair, careful CBSE Class 10 examiner marking a student's handwritten answer sheets against a marking scheme.", content, maxTokens: 16000, effort: "medium" });
  await addCost(store, e.by === "teacher" ? "teacher" : "student", r.usd, "exam");
  const result = parseJson(r.text);
  if (!Array.isArray(result.results)) throw new Error("no results");
  result.total = Number(result.total) || result.results.reduce((a: number, x: any) => a + (Number(x.got) || 0), 0);
  result.outOf = Number(result.outOf) || e.marks;
  return { ...e, status: "marked", result, markedAt: Date.now(), markCost: r.usd };
}

export default async (req: Request) => {
  const classCode = Netlify.env.get("CLASS_CODE") || "";
  if (!classCode || !same(req.headers.get("x-class-code") || "", classCode)) return;
  const store = getStore({ name: "homework", consistency: "strong" });
  let b: any = {};
  try { b = await req.json(); } catch { return; }
  const id = String(b.id || "").replace(/[^a-z0-9]/g, "");
  const e: any = await store.get("exam/" + id, { type: "json" });
  if (!e) return;
  // only do the job the record is waiting for (a retried invocation finds it already done)
  if (!(b.job === "generate" && e.status === "writing") && !(b.job === "mark" && e.status === "marking")) return;
  try {
    const next = b.job === "generate" ? await generate(store, e) : await mark(store, e);
    await store.setJSON("exam/" + id, next);
  } catch (err) {
    console.error("exam job", b.job, err);
    await store.setJSON("exam/" + id, { ...e, status: "failed", error: b.job === "generate" ? "Study Buddy could not write the paper. Tap Try again." : "Study Buddy could not mark the answers. Tap Try again." });
  }
};

export const config: Config = { path: "/api/exam-job", background: true };
