import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";
import webpush from "web-push";

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

// Phone notifications (Web Push). The server makes its own key pair on first use and keeps it in the
// blob store (key "vapid"), so no secret is handled by hand. Subscriptions are stored per role at
// push/<role>/<id>; a message from one side notifies every device of the other side.
type Vapid = { publicKey: string; privateKey: string };
async function vapid(s: ReturnType<typeof store>): Promise<Vapid> {
  const have = (await s.get("vapid", { type: "json" })) as Vapid | null;
  if (have && have.publicKey && have.privateKey) return have;
  await s.setJSON("vapid", webpush.generateVAPIDKeys(), { onlyIfNew: true });
  return (await s.get("vapid", { type: "json" })) as Vapid;
}
async function notify(s: ReturnType<typeof store>, to: "teacher" | "student", title: string, body: string, tag: string) {
  const { blobs } = await s.list({ prefix: "push/" + to + "/" });
  if (!blobs.length) return;
  const k = await vapid(s);
  webpush.setVapidDetails("https://tanish-study-board.netlify.app", k.publicKey, k.privateKey);
  const payload = JSON.stringify({ title, body: body.slice(0, 160), tag, url: tag === "chat" ? "./#chat" : "./#homework" });
  await Promise.allSettled(blobs.map(async (b) => {
    const sub = await s.get(b.key, { type: "json" });
    if (!sub) return;
    try { await webpush.sendNotification(sub, payload, { TTL: 86400, urgency: "high", timeout: 8000 }); }
    catch (e) { const code = (e as { statusCode?: number }).statusCode; if (code === 404 || code === 410) await s.delete(b.key); }
  }));
}
const who = (teacher: boolean) => (teacher ? "Papa" : "Tanish");
const other = (teacher: boolean): "teacher" | "student" => (teacher ? "student" : "teacher");

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
  // a phone that scanned the board's QR code may send photos with that code's token, without signing in
  const snapToken = clean(req.headers.get("x-snap-token"), 40);
  if (snapToken && req.method === "POST" && /\/api\/hw\/snap\/?$/.test(new URL(req.url).pathname)) {
    try {
      const st = store();
      const tok = (await st.get("snaptok/" + snapToken, { type: "json" })) as { exp: number; n: number } | null;
      if (!/^[a-z0-9]{16,40}$/.test(snapToken) || !tok || tok.exp < Date.now()) return fail(403, "This QR code has expired. Ask for a new one on the board.");
      if (tok.n >= 30) return fail(429, "Enough photos from this QR code. Ask for a new one.");
      const form = await req.formData();
      const f = await readFile(form);
      if (!f || !/^image\//.test(f.meta.type)) return fail(400, "Send a photo.");
      const iid = newId();
      tok.n++;
      await Promise.all([st.set("img/" + iid, f.data, { metadata: { type: f.meta.type } }), st.setJSON("snapmeta/tok/" + snapToken + "/" + iid, { id: iid, at: Date.now() }), st.setJSON("snaptok/" + snapToken, tok)]);
      return json({ id: iid });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg === "too_big") return fail(413, "The photo is too large.");
      if (msg === "bad_type") return fail(415, "That kind of file cannot be sent here.");
      return fail(500, "Could not send. Try again.");
    }
  }
  if (!same(req.headers.get("x-class-code") || "", classCode)) return fail(401, "Wrong class code.");
  const teacher = same(req.headers.get("x-teacher-pin") || "", teacherPin);

  const parts = new URL(req.url).pathname.replace(/^\/api\/hw\/?/, "").split("/").filter(Boolean);
  const [action, id] = parts;
  const s = store();

  try {
    if (req.method === "GET" && action === "whoami") return json({ ok: true, teacher });

    if (req.method === "GET" && action === "push") return json({ key: (await vapid(s)).publicKey });

    if (req.method === "POST" && action === "push") {
      const body = await req.json();
      const sub = body && body.subscription;
      const endpoint = clean(sub && sub.endpoint, 1000);
      if (!/^https:\/\//.test(endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return fail(400, "Bad subscription.");
      const key = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)))).slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("");
      const role = teacher ? "teacher" : "student";
      await Promise.all([s.delete("push/" + other(teacher) + "/" + key), body.off ? s.delete("push/" + role + "/" + key) : s.setJSON("push/" + role + "/" + key, { endpoint, keys: { p256dh: clean(sub.keys.p256dh, 200), auth: clean(sub.keys.auth, 100) } })]);
      if (body.test && !body.off) await notify(s, role, "Study Board", "Notifications are on for this device.", "test");
      return json({ ok: true });
    }

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
      await notify(s, other(teacher), who(teacher), text, "chat");
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
      await notify(s, other(teacher), who(teacher), "🎤 Voice message", "chat");
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
      await notify(s, other(teacher), who(teacher), "📷 " + (msg.text || "Picture"), "chat");
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

    // live pages: both write on the same pages. The teacher starts a session with the page heights,
    // uploads a picture of each page, then opens it. Each side sends the strokes it added or removed and
    // the stroke it is drawing right now; it gets back the other side's changes (polling).
    if (req.method === "POST" && action === "live" && id === "start") {
      if (!teacher) return fail(403, "Only the teacher can start a live page.");
      const body = await req.json();
      const hs = (Array.isArray(body.pages) ? body.pages : []).slice(0, 30).map((h: unknown) => Math.max(100, Math.min(20000, Math.round(Number(h) || 1414))));
      if (!hs.length) return fail(400, "No pages.");
      const old = await s.list({ prefix: "live/" });
      await Promise.all(old.blobs.map((x) => s.delete(x.key)));
      const at = Date.now();
      const session = { sid: at.toString(36) + Math.random().toString(36).slice(2, 6), title: clean(body.title, 120) || "Live page", pages: hs, at, active: false };
      await s.setJSON("live/session", session);
      return json({ session });
    }

    // photos placed on pages (stored once, drawn by id on every device)
    if (req.method === "POST" && action === "img") {
      const form = await req.formData();
      const f = await readFile(form);
      const iid = clean(form.get("id"), 30);
      if (!f || !/^image\//.test(f.meta.type) || !/^[a-z0-9]{6,24}$/.test(iid)) return fail(400, "Send a photo.");
      await s.set("img/" + iid, f.data, { metadata: { type: f.meta.type } });
      return json({ id: iid });
    }

    if (req.method === "GET" && action === "img" && id) {
      if (!/^[a-z0-9]{6,24}$/.test(id)) return fail(404, "Photo not found.");
      const r = await s.getWithMetadata("img/" + id, { type: "arrayBuffer" });
      if (!r || !r.data) return fail(404, "Photo not found.");
      return new Response(r.data, { headers: { "content-type": String((r.metadata as { type?: string }).type || "image/jpeg"), "cache-control": "private, max-age=604800" } });
    }

    // a photo snapped on the phone waits here until the laptop (same person) picks it up
    if (req.method === "POST" && action === "snap") {
      const form = await req.formData();
      const f = await readFile(form);
      if (!f || !/^image\//.test(f.meta.type)) return fail(400, "Send a photo.");
      const iid = newId();
      const role = teacher ? "teacher" : "student";
      await s.set("img/" + iid, f.data, { metadata: { type: f.meta.type } });
      await s.setJSON("snapmeta/" + role + "/" + iid, { id: iid, at: Date.now() });
      return json({ id: iid });
    }

    if (req.method === "POST" && action === "snaptoken") {
      const token = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 24);
      await s.setJSON("snaptok/" + token, { exp: Date.now() + 30 * 60000, n: 0 });
      return json({ token, minutes: 30 });
    }

    if (req.method === "GET" && action === "snaps") {
      const role = teacher ? "teacher" : "student";
      const tk = clean(new URL(req.url).searchParams.get("token"), 40);
      const { blobs } = await s.list({ prefix: tk ? "snapmeta/tok/" + tk + "/" : "snapmeta/" + role + "/" });
      const now = Date.now();
      const snaps = (await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })))).filter((x: any) => x && now - x.at < 30 * 60000);
      return json({ snaps });
    }

    if (req.method === "DELETE" && action === "snap" && id) {
      const tk = clean(new URL(req.url).searchParams.get("token"), 40);
      await s.delete((tk ? "snapmeta/tok/" + tk : "snapmeta/" + (teacher ? "teacher" : "student")) + "/" + clean(id, 30));
      return json({ ok: true });
    }

    // either side can add pages (a picture or PDF for reference) to a running live session
    if (req.method === "POST" && action === "live" && id === "add") {
      const body = await req.json();
      const session = (await s.get("live/session", { type: "json" })) as { sid: string; active: boolean; pages: number[] } | null;
      if (!session || !session.active || session.sid !== clean(body.sid, 40)) return fail(409, "The live page has ended.");
      const hs = (Array.isArray(body.pages) ? body.pages : []).slice(0, 10).map((h: unknown) => Math.max(100, Math.min(20000, Math.round(Number(h) || 1414))));
      if (!hs.length) return fail(400, "No pages.");
      if (session.pages.length + hs.length > 30) return fail(400, "The live pages are full (30 pages). End and start again to add more.");
      const start = session.pages.length;
      session.pages.push(...hs);
      await s.setJSON("live/session", session);
      return json({ start, np: session.pages.length });
    }

    if (req.method === "POST" && action === "live" && id === "bg") {
      const form = await req.formData();
      const f = await readFile(form);
      const n = Math.round(Number(form.get("n")));
      const ses = (await s.get("live/session", { type: "json" })) as { pages: number[]; active: boolean } | null;
      if (!ses || (!teacher && !ses.active)) return fail(409, "The live page has ended.");
      if (!f || !/^image\//.test(f.meta.type) || !(n >= 0 && n < ses.pages.length)) return fail(400, "Send a picture of the page.");
      await s.set("live/bg/" + n, f.data);
      return json({ ok: true });
    }

    if (req.method === "POST" && action === "live" && id === "go") {
      if (!teacher) return fail(403, "Only the teacher can do this.");
      const session = (await s.get("live/session", { type: "json" })) as { sid: string; title: string; pages: number[]; active: boolean; at: number } | null;
      if (!session) return fail(404, "No live page.");
      session.active = true;
      await s.setJSON("live/session", session);
      const at = Date.now();
      const msgId = String(at).padStart(13, "0") + "-" + Math.random().toString(36).slice(2, 8);
      const what = session.pages.length > 1 ? session.pages.length + " live pages: " : "Live page: ";
      const msg = { id: msgId, at, from: "teacher", text: "🖊️ " + what + session.title + ". Tap Join to write on it with Papa.", live: session.sid };
      await s.setJSON("msg/" + msgId, msg);
      await notify(s, "student", "Papa", "🖊️ Live page started. Open Study Board and tap Join.", "chat");
      return json({ session, msg });
    }

    if (req.method === "GET" && action === "live" && !id) {
      const session = (await s.get("live/session", { type: "json" })) as { active?: boolean } | null;
      return json({ session: session && session.active ? session : null });
    }

    if (req.method === "GET" && action === "live" && id === "bg") {
      const n = Math.max(0, Math.round(Number(new URL(req.url).searchParams.get("n") || 0)));
      const data = await s.get("live/bg/" + n, { type: "arrayBuffer" });
      if (!data) return fail(404, "That live page is not ready.");
      return new Response(data, { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
    }

    if (req.method === "POST" && action === "live" && id === "end") {
      if (!teacher) return fail(403, "Only the teacher can end the live page.");
      const session = (await s.get("live/session", { type: "json" })) as { active?: boolean } | null;
      if (session) { session.active = false; await s.setJSON("live/session", session); }
      return json({ ok: true });
    }

    if (req.method === "POST" && action === "live" && id === "sync") {
      const body = await req.json();
      const session = (await s.get("live/session", { type: "json" })) as { sid: string; active: boolean; pages: number[] } | null;
      const now = Date.now();
      if (!session || !session.active || session.sid !== clean(body.sid, 40)) return json({ active: false, now, events: [] });
      const role = teacher ? "teacher" : "student", otherRole = teacher ? "student" : "teacher";
      const np = session.pages.length;
      const okStroke = (x: any) => x && (/^(pen|hl|line|arrow|rect|ellipse)$/.test(x.t) || (x.t === "img" && typeof x.src === "string" && /^img\/[a-z0-9]{6,24}$/.test(x.src))) && typeof x.c === "string" && x.c.length < 30 && Number.isFinite(+x.w) && Array.isArray(x.pts) && x.pts.length >= 3 && x.pts.length <= 30000 && x.pts.every((v: unknown) => Number.isFinite(v as number));
      const okPg = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < np;
      const adds = (Array.isArray(body.adds) ? body.adds : []).slice(0, 100)
        .filter((a: any) => a && typeof a.id === "string" && a.id.length < 60 && okPg(a.pg) && okStroke(a.s))
        .map((a: any) => ({ id: a.id, pg: a.pg, s: { t: a.s.t, c: a.s.c, w: +a.s.w, pts: a.s.pts, ...(a.s.t === "img" ? { src: a.s.src } : {}) } }));
      const dels = (Array.isArray(body.dels) ? body.dels : []).filter((x: unknown) => typeof x === "string" && (x as string).length < 60).slice(0, 2000);
      const writes: Promise<unknown>[] = [];
      if (adds.length || dels.length) writes.push(s.setJSON("live/e/" + session.sid + "/" + String(now).padStart(13, "0") + "-" + Math.random().toString(36).slice(2, 8), { by: role, adds, dels }));
      // the stroke being drawn right now (not saved as an event, overwritten each time)
      if (body.cur === null) writes.push(s.delete("live/cur/" + role));
      else if (body.cur && okPg(body.cur.pg) && okStroke(body.cur.s)) writes.push(s.setJSON("live/cur/" + role, { pg: body.cur.pg, s: { t: body.cur.s.t, c: body.cur.s.c, w: +body.cur.s.w, pts: body.cur.s.pts }, at: now }));
      // where on the live pages this side is looking (page number and fraction down the page)
      if (body.view && okPg(body.view.pg) && Number.isFinite(+body.view.f)) writes.push(s.setJSON("live/view/" + role, { pg: body.view.pg, f: Math.max(-1, Math.min(1, +body.view.f)), at: now }));
      await Promise.all(writes);
      const since = Math.max(0, Number(body.since) || 0);
      const pre = "live/e/" + session.sid + "/";
      const [{ blobs }, theirCur, theirView, mySnaps] = await Promise.all([s.list({ prefix: pre }), s.get("live/cur/" + otherRole, { type: "json" }) as Promise<{ at: number } | null>, s.get("live/view/" + otherRole, { type: "json" }), s.list({ prefix: "snapmeta/" + role + "/" })]);
      const keys = blobs.map((x) => x.key).filter((k) => Number(k.slice(pre.length, pre.length + 13)) >= since).sort();
      const evs = (await Promise.all(keys.map(async (k) => ({ key: k.slice(pre.length), ...((await s.get(k, { type: "json" })) as object) })))) as { key: string; by: string }[];
      const cur = theirCur && now - theirCur.at < 4000 ? theirCur : null;
      return json({ active: true, now, events: evs.filter((e) => e.by && e.by !== role), cur, view: theirView || null, np, snaps: mySnaps.blobs.length });
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
      const meta = { key, subject, ch, name: clean(form.get("name"), 120) || f.meta.name, size, parts, at: Date.now(), by: teacher ? "teacher" : "student" };
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
      await notify(s, "student", "New homework", title, "hw");
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
      await notify(s, "teacher", "Tanish handed in homework", title, "hw");
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
      await notify(s, "student", "Homework checked", rec.title + (rec.score ? ": " + rec.score + (rec.outOf ? "/" + rec.outOf : "") : ""), "hw");
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
