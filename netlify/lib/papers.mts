// Question papers (board papers, CBSE sample papers, practice papers): turn page text into
// numbered questions with marks and chapter, so Study Buddy can point to them and mock exams can reuse them.

export type PQ = { n: number; marks: number; ch: number; t: string };
export type Paper = { id: string; name: string; subject: "maths" | "science"; kind: "board" | "sample" | "practice"; code: string; title: string; at: number; by: string; questions: PQ[]; text: string };

// Bilingual board papers print Hindi in an old font that comes out of the PDF as gibberish ("H$moS>").
const GARBLE = /H\$|[§¡¢£¤¥¦¨©ª«¬®¯±´µ¶¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]|\{|_|~|`|>/g;
const ENGLISH = /\b(the|of|and|is|are|find|if|in|a|an|that|which|its|from|with|then|show|prove|what|value|given|following|each|by|for|to)\b/gi;
export function cleanText(text: string): string {
  return String(text || "").split("\n").filter((line) => {
    const dev = (line.match(/[\u0900-\u097F]/g) || []).length; // Hindi in real Devanagari (newer papers)
    if (dev && dev >= (line.match(/[A-Za-z]/g) || []).length) return false;
    const g = (line.match(GARBLE) || []).length;
    if (!g) return true;
    const en = (line.match(ENGLISH) || []).length;
    return g < 2 && en >= 2;
  }).join("\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function paperInfo(name: string, text: string) {
  const t = text.slice(0, 6000);
  let kind: Paper["kind"] = /sample\s+question\s+paper/i.test(t) ? "sample" : /Q\.\s*P\.\s*Code|Series\s+[A-Z@]{3,}/i.test(t) ? "board" : "practice";
  const code = (/\b(\d{2}\/[0-9A-Z]{1,2}\/\d)\b/.exec(t) || /(\d{2})-([0-9A-Z]{1,2})-(\d)/.exec(name) || [""])[0].replace(/-/g, "/");
  if (kind === "practice" && /^\d{2}-[0-9A-Z]{1,2}-\d/.test(name.replace(/^[0-9a-f]{8}-/, ""))) kind = "board";
  const yr = (/\b(20\d\d)\s*[-–]\s*(\d\d)\b/.exec(t) || [])[0] || "";
  const title = kind === "board" ? "Board paper " + (code || name) : kind === "sample" ? "CBSE Sample Paper" + (yr ? " " + yr.replace(/\s/g, "").replace("-", "–") : "") : name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
  return { kind, code, title };
}

// "Question numbers 1 to 6 carry 2 marks each", "Section B comprises of 4 questions (Q.no. 7 to 10) of 3 marks each",
// "Question number 21 to 25 ... carrying 2 marks each"
function markRules(text: string) {
  const rules: { a: number; b: number; m: number }[] = [];
  const re = /(\d{1,2})\s*(?:to|-|–)\s*(\d{1,2})\)?[^.\n]{0,120}?\b(\d)\s*marks?\s*each/gi;
  // newer papers: "Questions No. 1 to 20 are Multiple Choice Questions. Each question carries 1 mark."
  const re2 = /(\d{1,2})\s*(?:to|-|–)\s*(\d{1,2})\b(?:(?!\d{1,2}\s*(?:to|-|–)\s*\d)[\s\S]){0,160}?carr(?:y|ies|ying)\s+(\d)\s*marks?/gi;
  let m: RegExpExecArray | null;
  for (const r of [re, re2]) while ((m = r.exec(text))) { const a = +m[1], b = +m[2], k = +m[3]; if (a >= 1 && b >= a && b <= 60 && k >= 1 && k <= 6 && !rules.some((x) => x.a === a && x.b === b)) rules.push({ a, b, m: k }); }
  return rules;
}

export function splitQuestions(text: string): { n: number; marks: number; t: string }[] {
  const passes: { n: number; lines: string[] }[][] = [[]];
  let cur: { n: number; lines: string[] } | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || /^\.?\d{2}\/[0-9A-Z]{1,2}\/\d\b/.test(line) || /^P\.?T\.?O\.?$/i.test(line)) continue; // page footers
    const m = /^(?:Q\.?\s*)?(\d{1,2})\s*[.)](?:\s+(\S.*))?$/.exec(line);
    if (m) {
      const n = +m[1];
      if (n === 1 && cur && cur.n >= 3) { passes.push([]); cur = null; } // a second copy of the paper (other language)
      const pass = passes[passes.length - 1];
      const expect = pass.length ? pass[pass.length - 1].n + 1 : 1;
      if (n === expect || (pass.length && n > expect && n <= expect + 2) || (!pass.length && n === 2)) { // a number lost in a table or fraction layout is skipped over
        cur = { n, lines: m[2] ? [m[2]] : [] }; pass.push(cur); continue; }
    }
    if (cur) cur.lines.push(line);
  }
  const score = (p: { lines: string[] }[]) => p.reduce((a, q) => a + (q.lines.join(" ").match(ENGLISH) || []).length, 0);
  const best = passes.sort((a, b) => score(b) - score(a))[0] || [];
  const rules = markRules(text);
  return best.map((q) => {
    let t = q.lines.join("\n");
    let marks = (rules.find((r) => q.n >= r.a && q.n <= r.b) || { m: 0 }).m;
    if (!marks) { const mm = /\s([1-5])\s*$/m.exec(q.lines.slice(0, 4).join("\n")); if (mm) marks = +mm[1]; }
    t = t.replace(/\s+([1-5])\s*$/gm, "").replace(/^(General Instructions|SECTION [A-E]).*$/gim, "").trim();
    return { n: q.n, marks, t: t.slice(0, 1500) };
  });
}

const KEYS: Record<string, string[][]> = {
  maths: [
    ["hcf", "lcm", "greatest number", "smallest number", "divides", "prime", "irrational", "rational number", "factoris", "composite", "fundamental theorem"],
    ["polynomial", "zeroes", "zeros of", "cubic"],
    ["pair of linear", "linear equations", "two variables", "consistent", "inconsistent", "unique solution", "infinitely many"],
    ["quadratic equation", "discriminant", "real roots", "equal roots", "roots of"],
    ["a.p", " ap ", "ap:", "arithmetic progression", "common difference", "nth term", "th term", "sum of first", "terms of"],
    ["similar", "bpt", "thales", "basic proportionality", "proportional"],
    ["coordinates", "distance between the points", "section formula", "divides the line", "mid-point", "midpoint", "x-axis", "y-axis", "collinear", "vertices"],
    ["sin", "cos", "tan", "sec", "cosec", "cot", "trigonometric", "identity"],
    ["angle of elevation", "angle of depression", "height of", "tower", "observed", "lighthouse", "kite"],
    ["tangent", "circle", "centre", "radius"],
    ["sector", "segment", "arc", "minute hand", "area of the shaded", "quadrant"],
    ["cone", "cylinder", "sphere", "hemisphere", "volume", "surface area", "cuboid", "melted", "recast", "frustum"],
    ["mean", "median", "mode", "frequency", "class interval", "distribution", "cumulative", "ogive"],
    ["probability", "die", "dice", "coin", "cards", "deck", "drawn at random", "random", "bag contains"],
  ],
  science: [
    ["chemical reaction", "balanced", "balance the", "oxidation", "reduction", "redox", "displacement", "decomposition", "combination reaction", "rancidity", "precipitat"],
    ["acid", "base", "salt", "ph", "indicator", "neutralis", "baking soda", "bleaching", "plaster of paris", "washing soda", "litmus"],
    ["metal", "non-metal", "ore", "alloy", "reactivity series", "ionic", "corrosion", "extraction", "amphoteric"],
    ["carbon", "hydrocarbon", "covalent", "ethanol", "ethanoic", "ester", "soap", "detergent", "homologous", "alkane", "alkene", "functional group"],
    ["nutrition", "respiration", "photosynthesis", "digestion", "transport", "excretion", "heart", "blood", "kidney", "xylem", "phloem", "stomata", "nephron", "enzyme"],
    ["nervous", "brain", "reflex", "hormone", "neuron", "auxin", "endocrine", "coordination", "tropism", "gland"],
    ["reproduc", "fission", "budding", "pollination", "fertilisation", "fertilization", "asexual", "menstrua", "contracepti", "regeneration", "spore"],
    ["heredity", "gene", "trait", "mendel", "dominant", "recessive", "sex determination", "inherit", "chromosome"],
    ["mirror", "lens", "refraction", "reflection", "focal", "concave", "convex", "refractive index", "magnification", "real image", "virtual image"],
    ["eye", "myopia", "hypermetropia", "dispersion", "prism", "scattering", "rainbow", "spectrum", "atmospheric refraction", "presbyopia"],
    ["current", "resistance", "ohm", "voltage", "potential difference", "resistor", "circuit", "electric power", "heating effect", "series", "parallel", "ammeter", "voltmeter"],
    ["magnetic", "solenoid", "electromagnet", "fleming", "motor", "induction", "magnet", "field lines", "right-hand"],
    ["ecosystem", "food chain", "food web", "ozone", "trophic", "biodegradable", "environment", "decomposer", "garbage"],
  ],
};
export function chapterOf(subject: string, text: string): number {
  const t = " " + text.toLowerCase().replace(/\s+/g, " ") + " ";
  let best = 0, bestSc = 0;
  (KEYS[subject] || []).forEach((keys, i) => {
    let sc = 0;
    for (const k of keys) { let pos = t.indexOf(k); while (pos >= 0) { sc += k.length > 6 ? 2 : 1; pos = t.indexOf(k, pos + k.length); } }
    if (i === 8 && subject === "maths" && sc) sc += 3; // heights and distances also mention sin/tan: prefer it when it applies
    if (sc > bestSc) { bestSc = sc; best = i + 1; }
  });
  return best;
}

export function buildPaper(id: string, name: string, subject: "maths" | "science", pages: { p: number; text: string }[], by: string): Paper {
  const text = cleanText(pages.map((p) => p.text || "").join("\n"));
  const info = paperInfo(name, text);
  const questions = splitQuestions(text).map((q) => ({ ...q, ch: chapterOf(subject, q.t) }));
  return { id, name: name.slice(0, 120), subject, ...info, at: Date.now(), by, questions, text: text.slice(0, 80000) };
}
