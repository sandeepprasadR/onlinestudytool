import type { Config } from "@netlify/functions";

// Every Sunday at 7:00 PM India time (13:30 UTC; India has no daylight saving): build the week's
// report and send Papa a phone notification. The work happens in hw.mts (POST /api/hw/report/send).
export default async () => {
  const base = Netlify.env.get("URL") || "https://tanish-study-board.netlify.app";
  const r = await fetch(new URL("/api/hw/report/send", base), {
    method: "POST",
    headers: { "x-class-code": Netlify.env.get("CLASS_CODE") || "", "x-teacher-pin": Netlify.env.get("TEACHER_PIN") || "" },
  });
  if (!r.ok) console.error("weekly report", r.status, await r.text().catch(() => ""));
};

export const config: Config = { schedule: "30 13 * * 0" };
