import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

// Homework exchange between the teacher (iPad) and the student (laptop).
// Every request carries the class code; teacher-only actions also carry the teacher PIN.
// Both live in environment variables CLASS_CODE and TEACHER_PIN (scope: Functions).

const MAX_BYTES = 4_400_000; // buffered function payload limit is about 4.5 MB of binary

type Item = {
  id: string;
  kind: "task" | "sub";
  title: string;
  subject: string;
  note: string;
  due?: string;
  taskId?: string;
  created: number;
  file?: { name: string; type: string; size: number };
  status?: "submitted" | "checked";
  score?: string;
  outOf?: string;
  remarks?: string;
  checkedAt?: number;
  marked?: { name: string; type: string; size: number };
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (status: number, error: string) => json({ error }, status);
const clean = (v: unknown, max = 500) => String(v ?? "").trim().slice(0, max);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const store = () => getStore({ name: "homework", consistency: "strong" });

function same(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function readFile(form: FormData, audio = false) {
  const f = form.get("file");
  if (!f || typeof f === "string") return null;
  const file = f as File;
  if (file.size > MAX_BYTES) throw new Error("too_big");
  const type = (file.type || "application/octet-stream").split(";")[0];
  const ok = audio ? /^audio\/(webm|ogg|mp4|mpeg|aac|x-m4a|wav)$/.test(type) : /^(application\/pdf|image\/(jpeg|png|webp|heic|heif))$/.test(type);
  if (!ok) throw new Error("bad_type");
  return { data: await file.arrayBuffer(), meta: { name: clean(file.name, 120) || "homework", type, size: file.size } };
}

export default async (req: Request, context: Context) => {
  const classCode = Netlify.env.get("CLASS_CODE") || "";
  const teacherPin = Netlify.env.get("TEACHER_PIN") || "";
  if (!classCode || !teacherPin) return fail(500, "The class code is not set up on the server yet.");
  if (!same(req.headers.get("x-class-code") || "", classCode)) return fail(401, "Wrong class code.");
  const teacher = same(req.headers.get("x-teacher-pin") || "", teacherPin);

  const parts = new URL(req.url).pathname.replace(/^\/api\/hw\/?/, "").split("/").filter(Boolean);
  const [action, id] = parts;
  const s = store();

  try {
    if (req.method === "GET" && action === "whoami") return json({ ok: true, teacher });

    if (req.method === "GET" && action === "items") {
      const { blobs } = await s.list({ prefix: "item/" });
      const items = (await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })))).filter(Boolean) as Item[];
      items.sort((a, b) => b.created - a.created);
      return json({ items, teacher });
    }

    if (req.method === "GET" && action === "msgs") {
      // keys are msg/<13-digit time>-<random>, so they sort by time
      const since = Number(new URL(req.url).searchParams.get("since") || 0);
      const { blobs } = await s.list({ prefix: "msg/" });
      const keys = blobs.map((b) => b.key).sort().slice(-300).filter((k) => Number(k.slice(4, 17)) > since);
      const msgs = (await Promise.all(keys.map((k) => s.get(k, { type: "json" })))).filter(Boolean);
      return json({ msgs, teacher });
    }

    if (req.method === "POST" && action === "msg") {
      const body = await req.json();
      const text = clean(body.text, 2000);
      if (!text) return fail(400, "Type a message first.");
      const at = Date.now();
      const msg = { id: String(at).padStart(13, "0") + "-" + Math.random().toString(36).slice(2, 8), at, from: teacher ? "teacher" : "student", text };
      await s.setJSON("msg/" + msg.id, msg);
      return json({ msg });
    }

    if (req.method === "POST" && action === "voice") {
      const form = await req.formData();
      const f = await readFile(form, true);
      if (!f) return fail(400, "No recording received.");
      const at = Date.now();
      const msgId = String(at).padStart(13, "0") + "-" + Math.random().toString(36).slice(2, 8);
      const dur = Math.max(0, Math.min(600, Number(form.get("dur")) || 0));
      await s.set("voice/" + msgId, f.data);
      const msg = { id: msgId, at, from: teacher ? "teacher" : "student", text: "", audio: { type: f.meta.type, size: f.meta.size, dur } };
      await s.setJSON("msg/" + msgId, msg);
      return json({ msg });
    }

    // pictures in the chat (screenshots, photos of a question)
    if (req.method === "POST" && action === "photo") {
      const form = await req.formData();
      const f = await readFile(form);
      if (!f || !/^image\//.test(f.meta.type)) return fail(400, "Send a picture.");
      const at = Date.now();
      const msgId = String(at).padStart(13, "0") + "-" + Math.random().toString(36).slice(2, 8);
      await s.set("chatimg/" + msgId, f.data);
      const msg = { id: msgId, at, from: teacher ? "teacher" : "student", text: clean(form.get("text"), 2000), image: { type: f.meta.type, size: f.meta.size } };
      await s.setJSON("msg/" + msgId, msg);
      return json({ msg });
    }

    if (req.method === "GET" && action === "photo" && id) {
      const rec = (await s.get("msg/" + id, { type: "json" })) as { image?: { type: string } } | null;
      const data = await s.get("chatimg/" + id, { type: "arrayBuffer" });
      if (!rec || !rec.image || !data) return fail(404, "Picture not found.");
      return new Response(data, { headers: { "content-type": rec.image.type, "cache-control": "private, max-age=86400" } });
    }

    if (req.method === "GET" && action === "voice" && id) {
      const rec = (await s.get("msg/" + id, { type: "json" })) as { audio?: { type: string } } | null;
      const data = await s.get("voice/" + id, { type: "arrayBuffer" });
      if (!rec || !rec.audio || !data) return fail(404, "Recording not found.");
      return new Response(data, { headers: { "content-type": rec.audio.type, "cache-control": "no-store" } });
    }

    // shared chapter library: the teacher uploads each chapter PDF once; every device can download it
    if (req.method === "GET" && action === "lib" && !id) {
      const { blobs } = await s.list({ prefix: "libmeta/" });
      const items = (await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })))).filter(Boolean);
      return json({ items, teacher });
    }

    if (req.method === "GET" && action === "lib" && id) {
      // large chapters are stored in parts (each under the function payload limit); the client fetches part by part
      const meta = (await s.get("libmeta/" + id, { type: "json" })) as { parts?: number } | null;
      const part = Math.max(0, Math.round(Number(new URL(req.url).searchParams.get("part") || 0)));
      const data = meta && meta.parts ? await s.get("libpart/" + id + "/" + part, { type: "arrayBuffer" }) : await s.get("lib/" + id, { type: "arrayBuffer" });
      if (!meta || !data) return fail(404, "That chapter is not in the shared library.");
      return new Response(data, { headers: { "content-type": "application/pdf", "cache-control": "no-store" } });
    }

    if (req.method === "POST" && action === "lib") {
      if (!teacher) return fail(403, "Only the teacher can add to the shared library.");
      const form = await req.formData();
      const f = await readFile(form);
      if (!f || f.meta.type !== "application/pdf") return fail(400, "Send a chapter PDF.");
      const subject = clean(form.get("subject"), 20);
      const ch = Math.round(Number(form.get("ch")));
      if (!/^(maths|science)$/.test(subject) || !(ch >= 1 && ch <= 20)) return fail(400, "Unknown chapter.");
      const key = subject + "-" + ch;
      const parts = Math.max(1, Math.min(40, Math.round(Number(form.get("parts")) || 1)));
      const part = Math.max(0, Math.round(Number(form.get("part")) || 0));
      if (part >= parts) return fail(400, "Bad part number.");
      await s.set("libpart/" + key + "/" + part, f.data);
      if (part < parts - 1) return json({ received: part });
      // last part: check every part arrived, then publish the chapter
      for (let i = 0; i < parts - 1; i++) {
        if (!(await s.getMetadata("libpart/" + key + "/" + i))) return fail(409, "Some parts did not arrive. Share the chapter again.");
      }
      const size = Math.round(Number(form.get("size")) || f.meta.size);
      const meta = { key, subject, ch, name: clean(form.get("name"), 120) || f.meta.name, size, parts, at: Date.now() };
      await s.setJSON("libmeta/" + key, meta);
      await s.delete("lib/" + key);
      return json({ item: meta });
    }

    if (req.method === "DELETE" && action === "lib" && id) {
      if (!teacher) return fail(403, "Only the teacher can remove from the shared library.");
      const { blobs } = await s.list({ prefix: "libpart/" + id + "/" });
      await Promise.all([s.delete("lib/" + id), s.delete("libmeta/" + id), ...blobs.map((b) => s.delete(b.key))]);
      return json({ ok: true });
    }

    if (req.method === "GET" && action === "settings") {
      return json({ settings: (await s.get("settings", { type: "json" })) || {} });
    }

    if (req.method === "POST" && action === "settings") {
      if (!teacher) return fail(403, "Only the teacher can change this.");
      const body = await req.json();
      const m = /^https:\/\/meet\.google\.com\/[a-z0-9-]+$/i.exec(clean(body.meetUrl, 200));
      const settings = { meetUrl: m ? m[0] : "" };
      await s.setJSON("settings", settings);
      return json({ settings });
    }

    if (req.method === "GET" && action === "file" && id) {
      const which = new URL(req.url).searchParams.get("v") === "marked" ? "marked" : "file";
      const rec = (await s.get("item/" + id, { type: "json" })) as Item | null;
      const meta = rec && (which === "marked" ? rec.marked : rec.file);
      if (!rec || !meta) return fail(404, "File not found.");
      const data = await s.get(which + "/" + id, { type: "arrayBuffer" });
      if (!data) return fail(404, "File not found.");
      return new Response(data, { headers: { "content-type": meta.type, "cache-control": "no-store" } });
    }

    if (req.method === "POST" && action === "task") {
      if (!teacher) return fail(403, "Only the teacher can give homework.");
      const body = await req.json();
      const title = clean(body.title, 120);
      if (!title) return fail(400, "Give the homework a title.");
      const item: Item = { id: newId(), kind: "task", title, subject: clean(body.subject, 20), note: clean(body.note, 2000), due: clean(body.due, 40), created: Date.now() };
      await s.setJSON("item/" + item.id, item);
      return json({ item });
    }

    if (req.method === "POST" && action === "submit") {
      const form = await req.formData();
      const f = await readFile(form);
      if (!f) return fail(400, "Attach the homework file.");
      const title = clean(form.get("title"), 120) || "Homework";
      const item: Item = {
        id: newId(), kind: "sub", title, subject: clean(form.get("subject"), 20), note: clean(form.get("note"), 1000),
        taskId: clean(form.get("taskId"), 40) || undefined, created: Date.now(), file: f.meta, status: "submitted",
      };
      await s.set("file/" + item.id, f.data);
      await s.setJSON("item/" + item.id, item);
      return json({ item });
    }

    if (req.method === "POST" && action === "check" && id) {
      if (!teacher) return fail(403, "Only the teacher can mark homework.");
      const rec = (await s.get("item/" + id, { type: "json" })) as Item | null;
      if (!rec || rec.kind !== "sub") return fail(404, "Submission not found.");
      const form = await req.formData();
      const f = await readFile(form);
      if (f) { await s.set("marked/" + id, f.data); rec.marked = f.meta; }
      rec.score = clean(form.get("score"), 10);
      rec.outOf = clean(form.get("outOf"), 10);
      rec.remarks = clean(form.get("remarks"), 2000);
      rec.status = "checked";
      rec.checkedAt = Date.now();
      await s.setJSON("item/" + id, rec);
      return json({ item: rec });
    }

    if (req.method === "DELETE" && action === "item" && id) {
      if (!teacher) return fail(403, "Only the teacher can delete.");
      await Promise.all([s.delete("item/" + id), s.delete("file/" + id), s.delete("marked/" + id)]);
      return json({ ok: true });
    }

    return fail(404, "Unknown request.");
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "too_big") return fail(413, "The file is larger than 4 MB. Send fewer pages, or a shorter recording.");
    if (msg === "bad_type") return fail(415, "That kind of file cannot be sent here.");
    console.error(e);
    return fail(500, "The server could not save that. Try again.");
  }
};

export const config: Config = { path: "/api/hw/*" };
