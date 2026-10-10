// Miliadex share links with rich previews (Discord, X, Slack, WhatsApp…).
//   /c/<code>   a collection    → profile card in text: rank, Vivid rating, account value, completion
//   /o/<code>   an outfit       → pieces, full sets, Vivid
//   /s/<file>   a Showcase item → same, with the outfit image
// Link previews never see the part after "#", so the data rides in the path. The Worker answers with a tiny page:
// preview tags for the bots, and a redirect to the usual "/#col=…" (or #look= / #show=) address for people.
// Preview pictures: when someone shares from the site, the page draws the card (same look as the site) and sends it to
//   POST /api/card; the Worker keeps it in Durable Objects (CardStore) and serves it at /card/<key>.jpg|png for that link.
//   An outfit's picture is the image the site downloads, with the outfit and its in-game screenshot inside: people opening the
//   link get "/#look=…&card=<key>", and the site reads the screenshot back from that picture.
// Only these paths run code: every other file is served straight from the static assets.
// The catalog (worker/embed-data.json) is extracted from index.html by tools/build.py at each deploy, so the numbers follow the site.
import { DurableObject } from "cloudflare:workers";
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

const CARD_V = 2;   // same as CARD_V in index.html: bump both when the card design changes
const pctOf = st => st.tot && st.got === st.tot ? 100 : Math.floor(st.pct * 100);
async function cardKey(k, code, lang) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${k}|${code}|${lang}|${CARD_V}`));
  return [...new Uint8Array(d)].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
}
// with a card picture, the text stays short: the picture carries the details
function colShort(c, lang) {
  const T = TX[lang], st = collStats(c), N = n => fmt(n, lang);
  return { title: T.profile(c.name), desc: `🏅 ${T.ranks[st.rank]} · ${T.lv} ${st.lv} · ${T.done(pctOf(st))}\n✨ ${N(st.vg)} Vivid · 💎 ${N(st.worth)} Chronal Nexus`, color: CREST[st.rank] };
}
function lookShort(L, info, lang) {
  const T = TX[lang];
  return `${L.g === "m" ? "♂ Manekin" : "♀ Manekina"} · ${T.pieces(info.n)} · ✨ ${fmt(info.viv, lang)} Vivid\n🪄 ${T.remix}`;
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
    p.image && p.w ? `<meta property="og:image:width" content="${p.w}">\n<meta property="og:image:height" content="${p.h}">` : "",
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
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": p.brief ? "public, max-age=60" : "public, max-age=600", "x-robots-tag": "noindex" } });
}

async function showItem(env, origin, file) {
  try {
    const r = await env.ASSETS.fetch(new Request(origin + "/showcase/index.json"));
    if (!r.ok) return null;
    const idx = await r.json();
    return (idx.items || []).find(x => x.file === file) || null;
  } catch (e) { return null; }
}

/* ---------- preview pictures ---------- */
// Cards live in SQLite-backed Durable Objects (strongly consistent: a card sent from Paris is there for Discord's fetch from
// the US a second later). Free plan: 5 GB for the account and 1 GB per object, so the cards are spread over SHARDS objects,
// each kept under BUDGET: past it, the cards used least recently go first. Cards unused for 6 months go too.
const SHARDS = 4, BUDGET = 850 * 2 ** 20, KEEP = 183 * 864e5, PART = 1536 * 1024;
export class CardStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = this.sql = ctx.storage.sql;
    sql.exec("DROP TABLE IF EXISTS cards");   // first version (one row per card, 2 MB cap)
    sql.exec("CREATE TABLE IF NOT EXISTS card (k TEXT PRIMARY KEY, t INTEGER NOT NULL, ty TEXT NOT NULL, n INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS card_part (k TEXT NOT NULL, i INTEGER NOT NULL, b BLOB NOT NULL, PRIMARY KEY (k, i))");
    sql.exec("CREATE INDEX IF NOT EXISTS card_t ON card (t)");
    sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
    if (this.meta("schema") < 2) {            // v2: each card's size (z) and the running total (meta "bytes")
      sql.exec("ALTER TABLE card ADD COLUMN z INTEGER NOT NULL DEFAULT 0");
      sql.exec("UPDATE card SET z = COALESCE((SELECT SUM(length(b)) FROM card_part WHERE card_part.k = card.k), 0)");
      this.recount(); this.setMeta("schema", 2);
    }
  }
  meta(k) { const r = this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0]; return r ? r.v : 0; }
  setMeta(k, v) { this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", k, v); }
  recount() { const s = this.sql.exec("SELECT COALESCE(SUM(z), 0) AS s FROM card").toArray()[0].s; this.setMeta("bytes", s); return s; }
  drop(k) { this.sql.exec("DELETE FROM card_part WHERE k = ?", k); this.sql.exec("DELETE FROM card WHERE k = ?", k); }
  // least recently used first, until the cards weigh at most `room` bytes
  evict(total, room) {
    while (total > room) {
      const old = this.sql.exec("SELECT k, z FROM card ORDER BY t LIMIT 32").toArray();
      if (!old.length) return 0;
      for (const r of old) { this.drop(r.k); total -= r.z; if (total <= room) break; }
    }
    return Math.max(0, total);
  }
  // pictures are kept in 1.5 MB parts (a row holds at most 2 MB; an outfit PNG with its screenshot can weigh several MB)
  put(k, ty, b) {
    const now = Date.now(), size = b.byteLength;
    let total = this.meta("bytes");
    if (Math.random() < .02) {                 // now and then: forget cards unused for 6 months, recount
      this.sql.exec("DELETE FROM card_part WHERE k IN (SELECT k FROM card WHERE t < ?)", now - KEEP);
      this.sql.exec("DELETE FROM card WHERE t < ?", now - KEEP);
      total = this.recount();
    }
    const prev = this.sql.exec("SELECT z FROM card WHERE k = ?", k).toArray()[0];
    if (prev) { this.drop(k); total = Math.max(0, total - prev.z); }
    if (total + size > BUDGET) total = this.evict(total, BUDGET * .9 - size);   // make room for ~10% more at once
    const write = () => this.ctx.storage.transactionSync(() => {
      let n = 0; for (let o = 0; o < size; o += PART, n++) this.sql.exec("INSERT INTO card_part (k, i, b) VALUES (?, ?, ?)", k, n, b.slice(o, o + PART));
      this.sql.exec("INSERT INTO card (k, t, ty, n, z) VALUES (?, ?, ?, ?, ?)", k, now, ty, n, size);
    });
    try { write(); }
    catch (e) {                                // full anyway (SQLite's own overhead): clear a fifth more, try once again
      if (!/full/i.test(String(e && e.message))) throw e;
      total = this.evict(total, total * .8 - size); write();
    }
    this.setMeta("bytes", total + size);
    return true;
  }
  has(k) {
    return this.sql.exec("SELECT 1 AS x FROM card WHERE k = ?", k).toArray().length > 0;
  }
  get(k) {
    const r = this.sql.exec("SELECT ty, t FROM card WHERE k = ?", k).toArray()[0];
    if (!r) return null;
    const parts = this.sql.exec("SELECT b FROM card_part WHERE k = ? ORDER BY i", k).toArray().map(x => new Uint8Array(x.b));
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    const now = Date.now(); if (now - r.t > 864e5) this.sql.exec("UPDATE card SET t = ? WHERE k = ?", now, k);   // still in use: keep it
    return { ty: r.ty, b: out.buffer };
  }
  size() { return { cards: this.sql.exec("SELECT COUNT(*) AS c FROM card").toArray()[0].c, bytes: this.meta("bytes") }; }
}
// a card's object follows its key; the first one keeps the name of the single object used before (its cards stay readable)
const shardOf = key => parseInt(key[0], 16) % SHARDS;
const store = (env, key) => { if (!env.CARDS) return null; const n = shardOf(key); return env.CARDS.get(env.CARDS.idFromName(n ? "cards-" + n : "cards")); };
const legacy = (env, key) => env.CARDS && shardOf(key) ? env.CARDS.get(env.CARDS.idFromName("cards")) : null;
const sniff = b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? "image/jpeg"
  : b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? "image/png"
  : b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 ? "image/webp" : "";
// link previews (Discord, X, Slack, WhatsApp, iMessage…) wait a few seconds for a card that is on its way; people never wait
const BOTS = /bot\b|crawl|spider|preview|externalhit|facebot|embedly|iframely|slack|discord|telegram|whatsapp|skype|mastodon|bluesky|cardyb|pleroma|misskey|vkshare|pinterest|linkedin|google-|curl|wget|python|go-http|okhttp|axios|node-fetch|headless/i;
const isBot = request => { const ua = request.headers.get("user-agent") || ""; return !/Mozilla/.test(ua) || BOTS.test(ua); };

// POST /api/card?k=c|o&l=en|fr&c=<code>  body: the picture the page drew for that link
async function saveCard(request, env, url) {
  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  const k = url.searchParams.get("k"), code = url.searchParams.get("c") || "", lang = url.searchParams.get("l") === "fr" ? "fr" : "en";
  if (!/^[co]$/.test(k) || code.length > 4000) return new Response("bad link", { status: 400 });
  const ok = k === "c" ? await readCol(code) : readLook(code);
  if (!ok) return new Response("bad link", { status: 400 });
  const b = new Uint8Array(await request.arrayBuffer()), ty = sniff(b);
  if (!ty || b.length > 8 * 1024 * 1024) return new Response("bad picture", { status: 400 });
  const key = await cardKey(k, code, lang), s = store(env, key); if (!s) return new Response("no store", { status: 503 });
  await s.put(key, ty, b.buffer);
  return new Response(null, { status: 204 });
}
// is the picture there? The page sends it as the link is copied: previews give it a few seconds before answering without it
async function cardThere(env, key, tries) {
  const s = store(env, key);
  for (let i = 0; s && i < tries; i++) {
    try { if (await s.has(key)) return true; } catch (e) { return false; }
    if (i < tries - 1) await new Promise(res => setTimeout(res, 650));
  }
  try { const l = legacy(env, key); return !!l && await l.has(key); } catch (e) { return false; }
}
// the preview's picture: the card when the site has it, the site banner otherwise (so a card address never stands for the banner)
// collection: a 1200 × 630 card (JPEG) · outfit: the picture the site downloads, 1080 × 1350 JPEG with the outfit inside
// (outfit cards sent before October 2026 are PNG: served with their own type)
async function previewImage(env, origin, k, code, lang, bot) {
  const key = await cardKey(k, code, lang);
  if (!await cardThere(env, key, bot ? 9 : 1)) return { image: `${origin}/og-banner.png`, w: 1200, h: 400, brief: true };
  return k === "o" ? { image: `${origin}/card/${key}.jpg`, w: 1080, h: 1350, key } : { image: `${origin}/card/${key}.jpg`, w: 1200, h: 630, key };
}
// GET /card/<key>.png|jpg  the picture (cards can be replaced: the same outfit shared again with another screenshot)
async function sendCard(env, origin, key) {
  const s = store(env, key);
  for (let i = 0; s && i < 3; i++) {
    let r = null; try { r = await s.get(key); } catch (e) {}
    if (!r && i === 0) try { const l = legacy(env, key); if (l) r = await l.get(key); } catch (e) {}
    if (r) return new Response(r.b, { headers: { "content-type": r.ty, "cache-control": "public, max-age=86400" } });
    await new Promise(res => setTimeout(res, 700));
  }
  const fb = await env.ASSETS.fetch(new Request(origin + "/og-banner.png"));
  return new Response(fb.body, { headers: { "content-type": "image/png", "cache-control": "public, max-age=120", "x-miliadex": "no-card" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), origin = url.origin;
    const lang = url.searchParams.get("l") === "fr" ? "fr" : "en";
    try {
      if (url.pathname === "/api/card") return await saveCard(request, env, url);
      const cm = url.pathname.match(/^\/card\/([0-9a-f]{32})\.(?:jpg|png|webp)$/);
      if (cm) return await sendCard(env, origin, cm[1]);
    } catch (e) { return new Response("error", { status: 500 }); }
    const m = url.pathname.match(/^\/([cos])\/([^/]+)\/?$/);
    if (!m) return env.ASSETS.fetch(request);
    const [, kind, raw] = m;
    let arg = raw; try { arg = decodeURIComponent(raw); } catch (e) {}
    const here = origin + url.pathname + url.search, bot = isBot(request);
    try {
      if (kind === "c") {
        const target = "/#col=" + arg, c = await readCol(arg);
        if (!c) return Response.redirect(origin + target, 302);
        return page({ ...colShort(c, lang), ...await previewImage(env, origin, "c", arg, lang, bot), large: true }, here, target, lang);
      }
      if (kind === "o") {
        const L = readLook(arg);
        if (!L) return Response.redirect(origin + "/#look=" + arg, 302);
        const info = lookInfo(L), pic = await previewImage(env, origin, "o", arg, lang, bot);
        // people land on the outfit with the card's key: the site reads the in-game screenshot back from the card
        return page({ title: TX[lang].outfit(L.n), desc: lookShort(L, info, lang), ...pic, large: true, color: SITE_COLOR }, here, "/#look=" + arg + (pic.key ? "&card=" + pic.key : ""), lang);
      }
      const target = "/#show=" + encodeURIComponent(arg), it = await showItem(env, origin, arg);
      if (!it) return Response.redirect(origin + target, 302);
      const title = TX[lang].show(it.name || arg.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim());
      const L = it.look ? readLook(it.look) : null, img = it.view || it.thumb ? origin + "/showcase/" + (it.view || it.thumb).split("/").map(encodeURIComponent).join("/") + (it.v ? "?v=" + it.v : "") : origin + "/showcase/" + encodeURIComponent(it.file);
      const desc = L ? lookShort(L, lookInfo(L), lang) : `🪄 ${TX[lang].remix}`;
      return page({ title, desc, image: img, large: true, color: SITE_COLOR }, here, target, lang);
    } catch (e) {
      return Response.redirect(origin + "/", 302);
    }
  },
};
