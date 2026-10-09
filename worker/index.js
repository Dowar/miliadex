// Miliadex share links with rich previews (Discord, X, Slack, WhatsApp…).
//   /c/<code>   a collection    → profile card in text: rank, Vivid rating, account value, completion
//   /o/<code>   an outfit       → pieces, full sets, Vivid
//   /s/<file>   a Showcase item → same, with the outfit image
// Link previews never see the part after "#", so the data rides in the path. The Worker answers with a tiny page:
// preview tags for the bots, and a redirect to the usual "/#col=…" (or #look= / #show=) address for people.
// Only these three paths run code: every other file is served straight from the static assets.
// The catalog (worker/embed-data.json) is extracted from index.html by tools/build.py at each deploy, so the numbers follow the site.
import D from "./embed-data.json";

const VLV = 300;                                   // Raiment Collector: one level every 300 Vivid
const RANK_T = [0, .10, .25, .50, .75, .95, 1];
const CREST = ["#7a5440", "#7b7b98", "#b0701f", "#6b3fc9", "#2f7fc9", "#c43f8f", "#ff8f3a"];
const VP = new Set(["o5", "a", "o4", "o3", "s"]);  // value bases counted in "most valuable"
const PER = 99.99 / 8080;                          // best top-up rate: 6,480 + 1,600 Chronal Nexus for 99.99
const IMG = "https://static.wikia.nocookie.net/gensin-impact/images/";
const SLOTS = ["Hairstyle", "Headwear", "Top", "Bottom", "Footwear", "Earrings", "Eye Accessory", "Face Accessory", "Neck Accessory", "Back Accessory",
  "Wrist Accessory", "Leg Accessory", "Pendant 1", "Pendant 2", "Tail Accessory", "Skin Tone", "Eye Shape", "Iris", "Eyebrows", "Eye Makeup", "Facial Makeup", "Lipstick"];
const THUMB_PREF = ["Top", "Bottom", "Headwear", "Footwear", "Hairstyle"];
const SITE_COLOR = "#6a4ddc";

const TX = {
  en: {
    ranks: ["Wide-eyed Traveler", "Wardrobe Apprentice", "Seasoned Collector", "Fashion Virtuoso", "Wonderland Icon", "Octavia's Favorite", "Master of Miliastra"],
    profile: n => n ? `${n} · Miliadex Profile` : "Miliadex Profile",
    lv: "Lv.", vivid: "Vivid rating", value: "Account value", done: p => `${p}% complete`, sets: "Sets", comp: "Cosmetics", top: "Most valuable",
    wear: g => g === "f" ? "Manekina only" : g === "m" ? "Manekin only" : "Manekina + Manekin",
    outfit: n => `${n || "Untitled outfit"} · Miliadex outfit`, show: n => `${n} · Outfits Showcase`,
    pieces: n => `${n} piece${n > 1 ? "s" : ""}`, full: n => n > 1 ? "Full sets" : "Full set", photo: "With its in-game photo",
    remix: "Open it to remix it in My Outfits", open: "Open in Miliadex",
  },
  fr: {
    ranks: ["Voyageur émerveillé", "Apprenti styliste", "Collectionneur aguerri", "Virtuose de la mode", "Icône de Wonderland", "Favori d'Octavia", "Maître de Miliastra"],
    profile: n => n ? `${n} · Profil Miliadex` : "Profil Miliadex",
    lv: "Niv.", vivid: "Vivid rating", value: "Valeur du compte", done: p => `Complété à ${p} %`, sets: "Sets", comp: "Cosmétiques", top: "Plus précieux",
    wear: g => g === "f" ? "Manekina seulement" : g === "m" ? "Manekin seulement" : "Manekina + Manekin",
    outfit: n => `${n || "Tenue sans nom"} · Tenue Miliadex`, show: n => `${n} · Vitrine de tenues`,
    pieces: n => `${n} pièce${n > 1 ? "s" : ""}`, full: n => n > 1 ? "Sets complets" : "Set complet", photo: "Avec sa capture en jeu",
    remix: "Ouvre-la pour la remixer dans Mes tenues", open: "Ouvrir dans le Miliadex",
  },
};

/* ---------- catalog (same rules as the site) ---------- */
const VORDER = D.v || [];
const SETS = (D.s || []).map(r => ({ kind: "set", en: r[0], fr: r[1], r: r[2], vi: r[3], f: r[4], m: r[5],
  val: { f: r[6] ? [r[6], r[7]] : null, m: r[8] ? [r[8], r[9]] : null }, viv: [r[10] || 0, r[11] || 0], sx: r[12], fw: r[13] || [] }));
const COMP = (D.c || []).map(r => ({ kind: "comp", id: r[0], en: r[1], fr: r[2], r: r[3], g: r[4], si: r[5], viv: r[6] || 0, val: r[7] || 0, b: r[8] || "",
  img: r[9], sx: r[10], slot: r[11] || "", vi: r[12] }));
const BYID = new Map(COMP.map((c, j) => [c.id, j]));
const PIECES = SETS.map(() => ({ f: [], m: [], a: [] }));   // a set's pieces, by wear
COMP.forEach((c, j) => { if (c.si >= 0 && PIECES[c.si]) (PIECES[c.si][c.g] || PIECES[c.si].a).push(j); });

const nameOf = (it, lang) => lang === "fr" ? it.fr || it.en : it.en;
const fmt = (n, lang) => Math.round(n).toLocaleString(lang === "fr" ? "fr-FR" : "en-US");
const money = (cn, lang) => new Intl.NumberFormat(lang === "fr" ? "fr-FR" : "en-US", { style: "currency", currency: lang === "fr" ? "EUR" : "USD", maximumFractionDigits: 0 }).format(cn * PER);
const lvOf = v => 1 + Math.floor(v / VLV);
const rankOf = (g, tot) => { const lv = lvOf(g); let r = 0; RANK_T.forEach((f, i) => { const x = i === 0 ? 1 : lvOf(Math.floor(f * tot / VLV) * VLV); if (lv >= x) r = i; }); return r; };
const wurl = p => {
  if (!p) return "";
  if (p.startsWith("fr:")) { const q = p.slice(3); return "https://static.wikia.nocookie.net/genshinimpact/images/" + q.split("/").map((x, i) => i < 2 ? x : encodeURIComponent(x)).join("/") + "/revision/latest/scale-to-width-down/300?path-prefix=fr"; }
  return IMG + p.split("/").map((x, i) => i < 2 ? x : encodeURIComponent(x)).join("/") + "/revision/latest/scale-to-width-down/300";
};

/* ---------- link decoding (mirrors SHARE / parseLook in index.html) ---------- */
function bytes64(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  const b = atob(s), a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a;
}
async function inflate(by) {
  const out = await new Response(new Blob([by]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
  return new Uint8Array(out);
}
const clean = n => String(n || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 24);

// [2][wear 0 both · 1 ♀ · 2 ♂][name length][name UTF-8][sets count u16][2 bits per set ♀/♂][1 bit per cosmetic], "z" deflated or "r" raw
async function readCol(code) {
  if (!/^[zr][A-Za-z0-9_-]+$/.test(code)) return null;
  try {
    let by = bytes64(code.slice(1)); if (code[0] === "z") by = await inflate(by);
    if (by.length < 5 || by[0] !== 2) return null;
    const L = by[2]; if (3 + L + 2 > by.length) return null;
    let name = ""; try { name = clean(new TextDecoder().decode(by.subarray(3, 3 + L))); } catch (e) {}
    const b = by.subarray(3 + L), ns = b[0] | b[1] << 8, sb = Math.ceil(ns * 2 / 8);
    const bit = k => (k >> 3) < b.length && !!(b[k >> 3] & (1 << (k & 7)));
    const s = new Uint8Array(SETS.length), c = new Uint8Array(COMP.length);
    SETS.forEach((it, i) => { if (it.sx == null || it.sx >= ns) return; s[i] = (bit(16 + it.sx * 2) ? 1 : 0) | (bit(17 + it.sx * 2) ? 2 : 0); });
    COMP.forEach((it, j) => { if (it.sx != null && bit((2 + sb) * 8 + it.sx)) c[j] = 1; });
    return { s, c, name, g: by[1] === 1 ? "f" : by[1] === 2 ? "m" : "both" };
  } catch (e) { return null; }
}

function readLook(code) {
  if (!/^[A-Za-z0-9_-]+$/.test(code)) return null;
  try {
    const d = JSON.parse(new TextDecoder().decode(bytes64(code)));
    if (!d || !Array.isArray(d.i)) return null;
    const its = d.i.map(x => BYID.get(String(x))).filter(j => j != null && COMP[j].slot);
    return { n: String(d.n || "").slice(0, 60), g: d.g === "m" ? "m" : "f", its };
  } catch (e) { return null; }
}

/* ---------- numbers (score, tally, worth, worthDetail in index.html) ---------- */
function collStats(o) {
  const g = o.g;
  const hasS = (i, k) => !!(o.s[i] & (k === "f" ? 1 : 2));
  const hasC = j => { const c = COMP[j]; return !!o.c[j] || (c.si >= 0 && (c.g === "f" || c.g === "m") && hasS(c.si, c.g)); };
  const freeVia = (i, k) => { const it = SETS[i]; return it.fw.length && it.val[k] && it.val[k][1] === "o4" ? it.fw.some(F => hasS(F, k)) : false; };
  const baseVal = (i, k) => SETS[i].val[k] ? SETS[i].val[k][0] : 0;
  const valOf = (i, k) => freeVia(i, k) ? 0 : baseVal(i, k);
  const basisOf = (i, k) => SETS[i].val[k] ? (freeVia(i, k) ? "o4f" : SETS[i].val[k][1]) : "";
  const setSlots = g === "both" ? ["f", "m"] : [g];
  let vg = 0, vt = 0, worth = 0, sg = 0, st = 0, cg = 0, ct = 0, g5 = 0, t5 = 0;
  const top = new Map();
  const add = (key, it, v, k) => { const e = top.get(key) || { it, v: 0, gs: [] }; e.v += v; e.gs.push(k); top.set(key, e); };
  SETS.forEach((it, i) => {
    for (const k of ["f", "m"]) {
      const own = hasS(i, k), v = it.viv[k === "m" ? 1 : 0];
      if (v) { vt += v; if (own) vg += v; }
      const w = valOf(i, k); if (w && own) worth += w;
      if (own) { const b = basisOf(i, k); if (b !== "o4f" && w && VP.has(b)) add("s" + i, it, w, k); }
    }
    for (const k of setSlots) { st++; if (hasS(i, k)) sg++; if (it.r === 5) { t5++; if (hasS(i, k)) g5++; } }
  });
  COMP.forEach((it, j) => {
    const own = hasC(j);
    if (it.si < 0) {
      if (it.viv) { vt += it.viv; if (own) vg += it.viv; }
      if (own && it.val) { worth += it.val; if (VP.has(it.b)) add("c" + j, it, it.val, "x"); }
    }
    if (it.g === "a" || g === "both" || it.g === g) { ct++; if (own) cg++; }
  });
  const best = [...top.values()].sort((a, b) => b.v - a.v || b.it.r - a.it.r || b.it.vi - a.it.vi);
  const got = sg + cg, tot = st + ct;
  return { vg, vt, lv: lvOf(vg), rank: rankOf(vg, vt), worth, sg, st, cg, ct, g5, t5, got, tot, pct: tot ? got / tot : 0, top: best.slice(0, 6), g };
}

function lookInfo(L) {
  let viv = 0; const sets = new Set();
  for (const j of L.its) {
    const it = COMP[j];
    if (it.si >= 0) { const k = it.g === "m" ? "m" : "f", n = (PIECES[it.si][it.g] || []).length || 1; viv += (SETS[it.si].viv[k === "m" ? 1 : 0] || 0) / n; sets.add(it.si); }
    else viv += it.viv;
  }
  const inLook = new Set(L.its);
  const full = [...sets].filter(si => { const need = PIECES[si][L.g]; return need.length && need.every(j => inLook.has(j)); });
  const order = [...new Set(L.its)].sort((a, b) => SLOTS.indexOf(COMP[a].slot) - SLOTS.indexOf(COMP[b].slot));
  let thumb = "";
  if (full.length) { const S = SETS[full[0]]; thumb = L.g === "m" ? S.m || S.f : S.f || S.m; }
  else { for (const s of THUMB_PREF) { const j = order.find(x => COMP[x].slot === s && COMP[x].img); if (j != null) { thumb = COMP[j].img; break; } } }
  return { n: L.its.length, viv: Math.round(viv), full, order, thumb };
}

/* ---------- preview text ---------- */
// Discord shortens descriptions past ~350 bytes / 20 lines: the last line (a list) gives way first
const bytes = s => new TextEncoder().encode(s).length;
function fit(lines, listLine, at = lines.length) {
  const MAX = 340;
  if (!listLine) return lines.join("\n");
  const [lead, parts] = listLine;
  for (let shown = parts.length; shown > 0; shown--) {
    const more = parts.length - shown, txt = lead + parts.slice(0, shown).join(" · ") + (more ? ` +${more}` : "");
    const all = [...lines.slice(0, at), txt, ...lines.slice(at)].join("\n");
    if (bytes(all) <= MAX) return all;
  }
  return lines.join("\n");
}

function colPreview(c, lang) {
  const T = TX[lang], st = collStats(c), N = n => fmt(n, lang);
  const pct = st.tot && st.got === st.tot ? 100 : Math.floor(st.pct * 100);
  const lines = [
    `🏅 ${T.ranks[st.rank]} · ${T.lv} ${st.lv}`,
    `✨ ${T.vivid} ${N(st.vg)} / ${N(st.vt)}`,
    `💎 ${T.value} ${N(st.worth)} Chronal Nexus · ≈ ${money(st.worth, lang)}`,
    `📊 ${T.done(pct)} · ${N(st.got)} / ${N(st.tot)}`,
    `👗 ${T.sets} ${N(st.sg)} / ${N(st.st)} · 🌟 5★ ${N(st.g5)} / ${N(st.t5)}`,
    `🧩 ${T.comp} ${N(st.cg)} / ${N(st.ct)} · ${T.wear(st.g)}`,
  ];
  const tops = st.top.slice(0, 3).map(e => nameOf(e.it, lang));
  const e0 = st.top[0], img = e0 ? (e0.it.kind === "set" ? (e0.gs.includes("f") ? e0.it.f || e0.it.m : e0.it.m || e0.it.f) : e0.it.img) : "";
  return { title: T.profile(c.name), desc: fit(lines, tops.length ? [`🏆 ${T.top}${lang === "fr" ? " : " : ": "}`, tops] : null),
    image: wurl(img), large: false, color: CREST[st.rank] };
}

function lookLines(L, info, lang, extra) {
  const T = TX[lang];
  const lines = [`${L.g === "m" ? "♂ Manekin" : "♀ Manekina"} · ${T.pieces(info.n)} · ✨ ${fmt(info.viv, lang)} Vivid`];
  if (info.full.length) lines.push(`🧩 ${T.full(info.full.length)}${lang === "fr" ? " : " : ": "}${info.full.slice(0, 2).map(si => nameOf(SETS[si], lang)).join(" · ")}${info.full.length > 2 ? ` +${info.full.length - 2}` : ""}`);
  if (extra) lines.push(extra);
  lines.push(`🪄 ${T.remix}`);
  return fit(lines, info.order.length ? ["👗 ", info.order.map(j => nameOf(COMP[j], lang))] : null, lines.length - 1);
}

/* ---------- page ---------- */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])).replace(/\n/g, "&#10;");
function page(p, url, target, lang) {
  const T = TX[lang], tags = [
    `<meta property="og:type" content="website">`, `<meta property="og:site_name" content="Miliadex">`,
    `<meta property="og:title" content="${esc(p.title)}">`, `<meta property="og:description" content="${esc(p.desc)}">`, `<meta property="og:url" content="${esc(url)}">`,
    p.image ? `<meta property="og:image" content="${esc(p.image)}">` : "",
    `<meta name="twitter:card" content="${p.large ? "summary_large_image" : "summary"}">`, `<meta name="twitter:title" content="${esc(p.title)}">`, `<meta name="twitter:description" content="${esc(p.desc)}">`,
    p.image ? `<meta name="twitter:image" content="${esc(p.image)}">` : "",
  ].filter(Boolean).join("\n");
  const html = `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.desc)}">
<meta name="robots" content="noindex">
<meta name="theme-color" content="${esc(p.color)}">
${tags}
<link rel="icon" href="/favicon.ico">
<script>location.replace(${JSON.stringify(target).replace(/</g, "\\u003c")})</script>
</head><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#140d33;color:#efeaff;font:16px system-ui,sans-serif">
<a href="${esc(target)}" style="color:#c58cff">${esc(T.open)} →</a></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=600", "x-robots-tag": "noindex" } });
}

async function showItem(env, origin, file) {
  try {
    const r = await env.ASSETS.fetch(new Request(origin + "/showcase/index.json"));
    if (!r.ok) return null;
    const idx = await r.json();
    return (idx.items || []).find(x => x.file === file) || null;
  } catch (e) { return null; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), origin = url.origin;
    const lang = url.searchParams.get("l") === "fr" ? "fr" : "en";
    const m = url.pathname.match(/^\/([cos])\/([^/]+)\/?$/);
    if (!m) return env.ASSETS.fetch(request);
    const [, kind, raw] = m;
    let arg = raw; try { arg = decodeURIComponent(raw); } catch (e) {}
    const here = origin + url.pathname + (lang === "fr" ? "?l=fr" : "");
    try {
      if (kind === "c") {
        const target = "/#col=" + arg, c = await readCol(arg);
        return c ? page(colPreview(c, lang), here, target, lang) : Response.redirect(origin + target, 302);
      }
      if (kind === "o") {
        const target = "/#look=" + arg, L = readLook(arg);
        if (!L) return Response.redirect(origin + target, 302);
        const info = lookInfo(L);
        return page({ title: TX[lang].outfit(L.n), desc: lookLines(L, info, lang), image: wurl(info.thumb), large: false, color: SITE_COLOR }, here, target, lang);
      }
      const target = "/#show=" + encodeURIComponent(arg), it = await showItem(env, origin, arg);
      if (!it) return Response.redirect(origin + target, 302);
      const title = TX[lang].show(it.name || arg.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim());
      const L = it.look ? readLook(it.look) : null, img = it.view || it.thumb ? origin + "/showcase/" + (it.view || it.thumb).split("/").map(encodeURIComponent).join("/") + (it.v ? "?v=" + it.v : "") : origin + "/showcase/" + encodeURIComponent(it.file);
      const desc = L ? lookLines(L, lookInfo(L), lang, it.pic ? `📸 ${TX[lang].photo}` : "") : `🪄 ${TX[lang].remix}`;
      return page({ title, desc, image: img, large: true, color: SITE_COLOR }, here, target, lang);
    } catch (e) {
      return Response.redirect(origin + "/", 302);
    }
  },
};
