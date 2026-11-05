import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";
import { istDay } from "../lib/ai.mts";

// Mock exams: Tanish (or Papa) asks for a paper, a background job writes it (exam-job.mts),
// he writes his answers on paper, photographs them, and the background job marks them.

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (status: number, error: string) => json({ error }, status);
function same(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const meta = (e: any) => ({ id: e.id, subject: e.subject, type: e.type, title: e.title || "", marks: e.marks, minutes: e.minutes, chapters: e.chapters, status: e.status, error: e.error || "", by: e.by, createdAt: e.createdAt, startedAt: e.startedAt || 0, submittedAt: e.submittedAt || 0, markedAt: e.markedAt || 0, score: e.result ? e.result.total : null, outOf: e.result ? e.result.outOf : null });
// the paper Tanish sees: no answers or marking scheme until it is marked
function publicPaper(p: any) {
  if (!p) return null;
  const strip = (q: any) => { const { answer, scheme, ...rest } = q; if (rest.or) { const { answer: a2, scheme: s2, ...or } = rest.or; rest.or = or; } return rest; };
  return { ...p, sections: (p.sections || []).map((s: any) => ({ ...s, questions: (s.questions || []).map(strip) })) };
}

export default async (req: Request, context: Context) => {
  const classCode = Netlify.env.get("CLASS_CODE") || "";
  if (!classCode || !same(req.headers.get("x-class-code") || "", classCode)) return fail(401, "Wrong class code.");
  const teacher = same(req.headers.get("x-teacher-pin") || "", Netlify.env.get("TEACHER_PIN") || "");
  const store = getStore({ name: "homework", consistency: "strong" });
  const [id, act] = new URL(req.url).pathname.replace(/^\/api\/exam\/?/, "").split("/").filter(Boolean);
  const run = async (job: "generate" | "mark", eid: string) => {
    const r = await fetch(new URL("/api/exam-job", req.url), { method: "POST", headers: { "content-type": "application/json", "x-class-code": classCode }, body: JSON.stringify({ job, id: eid }) });
    if (r.status >= 400) throw new Error("job " + r.status);
  };

  if (req.method === "GET" && !id) {
    const { blobs } = await store.list({ prefix: "exam/" });
    const items = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean).map(meta).sort((a, b) => b.createdAt - a.createdAt).slice(0, 40);
    return json({ items });
  }
  const safeId = String(id || "").replace(/[^a-z0-9]/g, "");
  if (req.method === "POST" && !id) {
    let b: any;
    try { b = await req.json(); } catch { return fail(400, "Bad request."); }
    const subject = b.subject === "science" ? "science" : b.subject === "maths" ? "maths" : "";
    const type = b.type === "chapters" ? "chapters" : "full";
    const chapters = (Array.isArray(b.chapters) ? b.chapters : []).map((c: any) => ({ n: Math.round(Number(c.n)) || 0, name: String(c.name || "").slice(0, 80) })).filter((c: any) => c.n >= 1 && c.n <= 20).slice(0, 20);
    if (!subject || !chapters.length) return fail(400, "Choose the subject and at least one chapter.");
    const marks = type === "full" ? 80 : Math.min(80, Math.max(10, Math.round(Number(b.marks) || 25)));
    const minutes = type === "full" ? 180 : Math.min(180, Math.max(15, Math.round(Number(b.minutes) || marks * 2)));
    const { blobs } = await store.list({ prefix: "exam/" });
    const todays = (await Promise.all(blobs.map((x) => store.get(x.key, { type: "json" })))).filter((e: any) => e && istDay() === new Date(e.createdAt + 5.5 * 3600_000).toISOString().slice(0, 10));
    if (todays.length >= (teacher ? 6 : 3)) return fail(429, "That is enough new mock papers for today. Finish the ones you have first 🙂");
    const eid = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const e = { id: eid, subject, type, chapters, marks, minutes, status: "writing", by: teacher ? "teacher" : "student", createdAt: Date.now() };
    await store.setJSON("exam/" + eid, e);
    try { await run("generate", eid); } catch (err) { await store.setJSON("exam/" + eid, { ...e, status: "failed", error: "Could not start writing the paper." }); return fail(502, "Could not start writing the paper. Try again."); }
    return json({ exam: meta(e) });
  }
  if (!safeId) return fail(404, "Unknown request.");
  const e: any = await store.get("exam/" + safeId, { type: "json" });
  if (!e) return fail(404, "That mock exam is not there any more.");

  if (req.method === "GET" && !act) {
    const out = { ...meta(e), paper: e.status === "marked" || teacher ? e.paper : publicPaper(e.paper), imgs: e.imgs || [], result: e.result || null };
    return json({ exam: out });
  }
  if (req.method === "POST" && act === "start") {
    if (!e.startedAt && e.paper) { e.startedAt = Date.now(); e.status = "started"; await store.setJSON("exam/" + safeId, e); }
    return json({ exam: meta(e) });
  }
  if (req.method === "POST" && act === "submit") {
    let b: any;
    try { b = await req.json(); } catch { return fail(400, "Bad request."); }
    const imgs = (Array.isArray(b.imgs) ? b.imgs : []).map((x: any) => String(x).replace(/[^a-z0-9]/g, "")).filter(Boolean).slice(0, 20);
    if (!imgs.length) return fail(400, "Add photos of your answer sheets first.");
    if (!["ready", "started", "failed"].includes(e.status) || !e.paper) return fail(409, "This paper cannot be handed in now.");
    Object.assign(e, { imgs, status: "marking", submittedAt: Date.now(), error: "" });
    await store.setJSON("exam/" + safeId, e);
    try { await run("mark", safeId); } catch (err) { e.status = "failed"; e.error = "Could not start marking."; await store.setJSON("exam/" + safeId, e); return fail(502, "Could not start marking. Try again."); }
    return json({ exam: meta(e) });
  }
  if (req.method === "POST" && act === "retry") {
    if (e.status !== "failed") return json({ exam: meta(e) });
    const job = e.paper ? "mark" : "generate";
    e.status = e.paper ? "marking" : "writing"; e.error = "";
    await store.setJSON("exam/" + safeId, e);
    try { await run(job, safeId); } catch (err) { e.status = "failed"; e.error = "Could not start again."; await store.setJSON("exam/" + safeId, e); }
    return json({ exam: meta(e) });
  }
  if (req.method === "DELETE" && !act) {
    if (!teacher && e.status === "marked") return fail(403, "Only Papa can remove a marked mock exam.");
    await store.delete("exam/" + safeId);
    return json({ ok: true });
  }
  return fail(404, "Unknown request.");
};

export const config: Config = { path: ["/api/exam", "/api/exam/*"] }; // the list and "create" use /api/exam itself
