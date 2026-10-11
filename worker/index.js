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
// Outfits Showcase: signed-in people share their saved outfits there (POST /api/show/publish, its own picture, updatable
//   once a minute, removable by its owner); GET /api/showcase lists them (most liked or newest, small pictures inside the same
//   response). Featured: the repo's images (showcase/) and the copies the admin makes of community outfits (frozen, never cleared).
// Accounts: the Google account connected for Drive sync, checked with Google once (POST /api/auth), then a signed session;
//   a pseudo (random at first) is shown on the outfits one shares; one like per account and outfit.
// Admin: /a/<secret> is a 404 page, except for the site owner's Google account, checked with Google on every admin call.
// People opening a link (a browser navigation) are sent on right away: no storage read, the site works out the rest itself.
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
    outfit: n => `${n || "Untitled outfit"} · Miliadex outfit`, show: n => `${n} · Community Outfits`,
    pieces: n => `${n} piece${n > 1 ? "s" : ""}`, full: n => n > 1 ? "Full sets" : "Full set", photo: "With its in-game photo",
    remix: "Open it to remix it in My Outfits", open: "Open in Miliadex",
  },
  fr: {
    ranks: ["Voyageur émerveillé", "Apprenti styliste", "Collectionneur aguerri", "Virtuose de la mode", "Icône de Wonderland", "Favori d'Octavia", "Maître de Miliastra"],
    profile: n => n ? `${n} · Profil Miliadex` : "Profil Miliadex",
    lv: "Niv.", vivid: "Vivid rating", value: "Valeur du compte", done: p => `Complété à ${p} %`, sets: "Sets", comp: "Cosmétiques", top: "Plus précieux",
    wear: g => g === "f" ? "Manekina seulement" : g === "m" ? "Manekin seulement" : "Manekina + Manekin",
    outfit: n => `${n || "Tenue sans nom"} · Tenue Miliadex`, show: n => `${n} · Tenues de la communauté`,
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

// [2][wear 0 both · 1 ♀ · 2 ♂, +16: its owner shows the value in money][name length][name UTF-8][sets count u16][2 bits per set ♀/♂][1 bit per cosmetic], "z" deflated or "r" raw
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
    const w = by[1] & 3;
    return { s, c, name, g: w === 1 ? "f" : w === 2 ? "m" : "both", money: !!(by[1] & 16) };
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
// short links: /o/<10 letters or digits> for an outfit, /c/<…> for a collection. The key is a hash of what the link stands for (the same
// share gives the same link, and nobody can aim a share at someone else's link); the picture is kept under it, and the code in a
// table of its own, so the link still opens the outfit or the collection once its picture is gone. "salt": the outfit's screenshot id
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", SHORT = /^[0-9A-Za-z]{10}$/;
async function shortKey(k, code, lang, salt) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${k}|${code}|${lang}|${salt || ""}|${CARD_V}`)));
  let n = 0n; for (let i = 0; i < 8; i++) n = n << 8n | BigInt(d[i]);
  let s = ""; for (let i = 0; i < 10; i++) { s += B62[Number(n % 62n)]; n /= 62n; }
  return s;
}
// with a card picture, the text stays short: the picture carries the details
function colShort(c, lang) {
  const T = TX[lang], st = collStats(c), N = n => fmt(n, lang);
  // the value in money only when the profile's owner shows it on the site
  return { title: T.profile(safeName(c.name)), desc: `🏅 ${T.ranks[st.rank]} · ${T.lv} ${st.lv} · ${T.done(pctOf(st))}\n✨ ${N(st.vg)} Vivid · 💎 ${N(st.worth)} Chronal Nexus${c.money ? ` (≈ ${money(st.worth, lang)})` : ""}`, color: CREST[st.rank] };
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
    // by file name, or without the extension: links keep working when an image changes format (witchy-garden.png → .jpg)
    const base = n => String(n).replace(/\.[a-z0-9]+$/i, ""), items = idx.items || [];
    return items.find(x => x.file === file) || items.find(x => base(x.file) === base(file)) || null;
  } catch (e) { return null; }
}

/* ---------- preview pictures, showcase, accounts ---------- */
// Cards live in SQLite-backed Durable Objects (strongly consistent: a card sent from Paris is there for Discord's fetch from
// the US a second later), spread over SHARDS objects. Each keeps at most MAX_CARDS cards (4 × 1250 = about 5,000 in all)
// and stays under BUDGET bytes (free plan: 1 GB per object, 5 GB per account): past either, the cards used least recently
// go first, never a featured one. Cards unused for 6 months go too. One more object, "users", keeps the accounts.
// Showcase entries (kind "s") are counted apart: MAX_SHOW per object, PER_USER per account, never expired, cleared last.
const MAX_LINKS = 50000;   // short links per object (a few hundred bytes each): past that, the ones opened least recently go
const SHARDS = 4, MAX_CARDS = 1250, MAX_SHOW = 800, PER_USER = 30, COOLDOWN = 60e3, BUDGET = 850 * 2 ** 20, KEEP = 183 * 864e5, PART = 1536 * 1024, PAGE = 36;
const COLS = "k, code, lang, pt, pic, likes, nick, feat, th, thty";   // a showcase entry, with its small picture
const NICK_A = ["Starry", "Lunar", "Velvet", "Crimson", "Azure", "Golden", "Misty", "Frosty", "Blooming", "Silent", "Radiant", "Moonlit", "Stellar", "Wild", "Gentle", "Amber"];
const NICK_B = ["Manekin", "Manekina", "Stylist", "Wanderer", "Dreamer", "Seeker", "Muse", "Comet", "Petal", "Lantern", "Traveler", "Tailor", "Sparrow", "Ribbon", "Fable", "Nova"];
const randomNick = long => NICK_A[Math.random() * 16 | 0] + NICK_B[Math.random() * 16 | 0] + (Math.random() * (long ? 9000 : 90) + (long ? 1000 : 10) | 0);
export class CardStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = this.sql = ctx.storage.sql;
    sql.exec("DROP TABLE IF EXISTS cards");   // first version (one row per card, 2 MB cap)
    sql.exec("CREATE TABLE IF NOT EXISTS card (k TEXT PRIMARY KEY, t INTEGER NOT NULL, ty TEXT NOT NULL, n INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS card_part (k TEXT NOT NULL, i INTEGER NOT NULL, b BLOB NOT NULL, PRIMARY KEY (k, i))");
    sql.exec("CREATE INDEX IF NOT EXISTS card_t ON card (t)");
    sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
    const v = this.meta("schema");
    // a column already there (an upgrade cut short) is fine
    const addCol = c => { try { sql.exec("ALTER TABLE card ADD COLUMN " + c); } catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; } };
    if (v < 2) {                              // v2: each card's size (z) and the running total (meta "bytes")
      addCol("z INTEGER NOT NULL DEFAULT 0");
      sql.exec("UPDATE card SET z = COALESCE((SELECT SUM(length(b)) FROM card_part WHERE card_part.k = card.k), 0)");
    }
    if (v < 3) this.setMeta("schema", 3);    // v3: the running counts (meta "count"): counted once the columns are all there (v6)
    if (v < 4) {                              // v4: the showcase (outfit code, in it or not, taken out by the admin, its small picture)
      for (const c of ["code TEXT", "lang TEXT", "pub INTEGER NOT NULL DEFAULT 0", "ban INTEGER NOT NULL DEFAULT 0", "pt INTEGER NOT NULL DEFAULT 0",
        "pic INTEGER NOT NULL DEFAULT 0", "th BLOB", "thty TEXT"]) addCol(c);
      sql.exec("CREATE INDEX IF NOT EXISTS card_pub ON card (pub, pt)");
      this.setMeta("schema", 4);
    }
    if (v < 5) {                              // v5: author, likes, featured by the admin
      for (const c of ["uid TEXT", "nick TEXT", "likes INTEGER NOT NULL DEFAULT 0", "feat INTEGER NOT NULL DEFAULT 0"]) addCol(c);
      sql.exec("CREATE INDEX IF NOT EXISTS card_top ON card (pub, feat, likes, pt)");
      sql.exec("CREATE TABLE IF NOT EXISTS lk (k TEXT NOT NULL, u TEXT NOT NULL, t INTEGER NOT NULL, PRIMARY KEY (k, u))");
      sql.exec("CREATE INDEX IF NOT EXISTS lk_u ON lk (u)");
      sql.exec("CREATE TABLE IF NOT EXISTS user (u TEXT PRIMARY KEY, n TEXT NOT NULL, nl TEXT NOT NULL UNIQUE, t INTEGER NOT NULL)");
      sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
      this.setMeta("schema", 5);
    }
    if (v < 6) {                              // v6: showcase entries apart from link pictures, last update, a featured copy's original
      for (const c of ["kind TEXT", "ut INTEGER NOT NULL DEFAULT 0", "src TEXT"]) addCol(c);
      sql.exec("UPDATE card SET kind = 's' WHERE pub = 1 OR feat = 1 OR ban = 1");
      sql.exec("CREATE INDEX IF NOT EXISTS card_uid ON card (uid)");
      this.recount(); this.setMeta("schema", 6);
    }
    if (v < 7) {                              // v7: short links (what each one stands for, kept when its picture goes)
      sql.exec("CREATE TABLE IF NOT EXISTS link (k TEXT PRIMARY KEY, kind TEXT NOT NULL, code TEXT NOT NULL, lang TEXT NOT NULL, pic INTEGER NOT NULL DEFAULT 0, t INTEGER NOT NULL)");
      sql.exec("CREATE INDEX IF NOT EXISTS link_t ON link (t)");
      this.setMeta("lcount", sql.exec("SELECT COUNT(*) AS c FROM link").toArray()[0].c); this.setMeta("schema", 7);
    }
  }
  meta(k) { const r = this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0]; return r ? r.v : 0; }
  setMeta(k, v) { this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", k, v); }
  // bytes (all), count (link pictures), scount (showcase entries)
  recount() {
    const r = this.sql.exec("SELECT COALESCE(SUM(z), 0) AS z, COALESCE(SUM(kind IS NULL), 0) AS c, COALESCE(SUM(kind = 's'), 0) AS s FROM card").toArray()[0];
    this.setMeta("bytes", r.z); this.setMeta("count", r.c); this.setMeta("scount", r.s); return [r.z, r.c];
  }
  dropRow(k) { this.sql.exec("DELETE FROM card_part WHERE k = ?", k); this.sql.exec("DELETE FROM card WHERE k = ?", k); }
  drop(k) { this.dropRow(k); this.sql.exec("DELETE FROM lk WHERE k = ?", k); }
  // least recently used first (never a featured one), until the cards weigh at most `room` bytes and number at most `most`;
  // link pictures, or showcase entries (show)
  evict(total, count, room, most, show) {
    while (total > room || count > most) {
      const old = this.sql.exec(`SELECT k, z FROM card WHERE feat = 0 AND kind IS ${show ? "'s'" : "NULL"} ORDER BY t LIMIT 32`).toArray();
      if (!old.length) break;
      for (const r of old) { this.drop(r.k); total -= r.z; count--; if (total <= room && count <= most) break; }
    }
    return [Math.max(0, total), Math.max(0, count)];
  }
  // link pictures, kept in 1.5 MB parts (a row holds at most 2 MB); o: {code, lang, pic, link: "o" | "c" for a short link}
  put(k, ty, b, o = {}) {
    const now = Date.now(), size = b.byteLength;
    let total = this.meta("bytes"), count = this.meta("count");
    if (Math.random() < .02) {                 // now and then: forget link pictures unused for 6 months, recount
      this.sql.exec("DELETE FROM card_part WHERE k IN (SELECT k FROM card WHERE t < ? AND kind IS NULL AND feat = 0)", now - KEEP);
      this.sql.exec("DELETE FROM card WHERE t < ? AND kind IS NULL AND feat = 0", now - KEEP);
      [total, count] = this.recount();
    }
    const prev = this.sql.exec("SELECT z, kind FROM card WHERE k = ?", k).toArray()[0];
    if (prev && prev.kind === "s") return true;   // a showcase entry from before entries had their own key: left as it is
    if (prev) { this.dropRow(k); total = Math.max(0, total - prev.z); count = Math.max(0, count - 1); }
    // full: make room for a few more at once (2% of the cards, ~10% of the bytes)
    if (count + 1 > MAX_CARDS || total + size > BUDGET) [total, count] = this.evict(total, count, BUDGET * .9 - size, MAX_CARDS - Math.ceil(MAX_CARDS * .02) - 1);
    const newLink = !!o.link && !this.sql.exec("SELECT 1 AS x FROM link WHERE k = ?", k).toArray().length;
    const write = () => this.ctx.storage.transactionSync(() => {
      let n = 0; for (let x = 0; x < size; x += PART, n++) this.sql.exec("INSERT INTO card_part (k, i, b) VALUES (?, ?, ?)", k, n, b.slice(x, x + PART));
      this.sql.exec("INSERT INTO card (k, t, ty, n, z, code, lang, pic) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", k, now, ty, n, size, o.code || null, o.lang || null, o.pic ? 1 : 0);
      if (o.link) this.sql.exec("INSERT OR REPLACE INTO link (k, kind, code, lang, pic, t) VALUES (?, ?, ?, ?, ?, ?)", k, o.link, o.code, o.lang || "en", o.pic ? 1 : 0, now);
    });
    try { write(); }
    catch (e) {                                // full anyway (SQLite's own overhead): clear a fifth more, try once again
      if (!/full/i.test(String(e && e.message))) throw e;
      [total, count] = this.evict(total, count, total * .8 - size, count); write();
    }
    this.setMeta("bytes", total + size); this.setMeta("count", count + 1);
    if (newLink) this.linkRoom(this.meta("lcount") + 1);
    return true;
  }
  // short links: at most MAX_LINKS, the ones opened least recently go first (2% at once)
  linkRoom(n) {
    if (n > MAX_LINKS) { const cut = n - MAX_LINKS + Math.ceil(MAX_LINKS * .02); this.sql.exec("DELETE FROM link WHERE k IN (SELECT k FROM link ORDER BY t LIMIT ?)", cut); n -= cut; }
    this.setMeta("lcount", n);
  }
  linkGet(k) {
    const r = this.sql.exec("SELECT kind, code, lang, pic, t FROM link WHERE k = ?", k).toArray()[0];
    if (!r) return null;
    const now = Date.now(); if (now - r.t > 864e5) this.sql.exec("UPDATE link SET t = ? WHERE k = ?", now, k);   // still opened: keep it
    return { kind: r.kind, code: r.code, lang: r.lang, pic: !!r.pic, card: this.has(k) };
  }
  // a showcase entry (its own key, its own picture): e = {code, lang, pic, uid, nick, th, thty, feat, src}
  // its owner can replace it once a minute (its likes and its place stay); the admin's copies (feat) are written once
  entryWrite(k, ty, b, e, prev) {
    const now = Date.now(), th = e.th || null, size = b.byteLength + (th ? th.byteLength : 0);
    let total = this.meta("bytes"), scount = this.meta("scount");
    if (prev) { this.dropRow(k); total = Math.max(0, total - prev.z); scount = Math.max(0, scount - 1); }
    if (scount + 1 > MAX_SHOW) [total, scount] = this.evict(total, scount, Infinity, MAX_SHOW - Math.ceil(MAX_SHOW * .02) - 1, true);
    if (total + size > BUDGET) {               // short of room: link pictures go first, then the oldest entries
      let count = this.meta("count"); [total, count] = this.evict(total, count, BUDGET * .9 - size, count); this.setMeta("count", count);
      if (total + size > BUDGET) [total, scount] = this.evict(total, scount, BUDGET * .9 - size, scount, true);
    }
    this.ctx.storage.transactionSync(() => {
      let n = 0; for (let x = 0; x < b.byteLength; x += PART, n++) this.sql.exec("INSERT INTO card_part (k, i, b) VALUES (?, ?, ?)", k, n, b.slice(x, x + PART));
      this.sql.exec("INSERT INTO card (k, t, ty, n, z, code, lang, pub, ban, pt, pic, th, thty, uid, nick, likes, feat, kind, ut, src) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, 's', ?, ?)",
        k, now, ty, n, size, e.code, e.lang || "en", prev ? prev.pt || now : now, e.pic ? 1 : 0, th, th ? e.thty || "image/jpeg" : null, e.uid || null, e.nick || null,
        prev ? prev.likes : 0, e.feat ? 1 : 0, now, e.src || null);
    });
    this.setMeta("bytes", total + size); this.setMeta("scount", scount + 1);
  }
  publish(k, ty, b, e) {
    const prev = this.sql.exec("SELECT z, uid, ban, likes, pt, ut, kind, feat FROM card WHERE k = ?", k).toArray()[0];
    if (prev && (prev.kind !== "s" || prev.feat || (prev.uid && prev.uid !== e.uid))) return { error: "owner" };
    if (prev && prev.ban) return { error: "ban" };
    const since = prev ? Date.now() - prev.ut : Infinity;
    if (since < COOLDOWN) return { error: "wait", wait: Math.ceil((COOLDOWN - since) / 1000) };
    this.entryWrite(k, ty, b, e, prev || null);
    return { ok: true, new: !prev };
  }
  // the owner takes it out (the admin's featured copy, if any, stays)
  removeOwn(k, u) {
    const r = this.sql.exec("SELECT z, uid, kind, feat FROM card WHERE k = ?", k).toArray()[0];
    if (!r || r.kind !== "s" || r.feat || r.uid !== u) return false;
    this.drop(k); this.setMeta("bytes", Math.max(0, this.meta("bytes") - r.z)); this.setMeta("scount", Math.max(0, this.meta("scount") - 1));
    return true;
  }
  mine(u) { return this.sql.exec(`SELECT ${COLS}, ban, ut FROM card WHERE uid = ? AND kind = 's' AND feat = 0`, u).toArray(); }
  countBy(u) { return this.sql.exec("SELECT COUNT(*) AS c FROM card WHERE uid = ? AND kind = 's' AND feat = 0", u).toArray()[0].c; }
  // the admin features a community outfit: a frozen copy (the original stays in the community, still its owner's)
  exportEntry(k) {
    const r = this.sql.exec("SELECT ty, code, lang, pic, nick, uid, th, thty FROM card WHERE k = ? AND kind = 's'", k).toArray()[0];
    if (!r || !r.code) return null;
    const g = this.get(k); return g ? { ...r, b: g.b } : null;
  }
  putFeatured(k, x, src) { this.entryWrite(k, x.ty, x.b, { code: x.code, lang: x.lang, pic: x.pic, uid: x.uid, nick: x.nick, th: x.th, thty: x.thty, feat: 1, src }, null); return true; }
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
  // showcase: a page (most liked, or newest) after a cursor, plus (first page) the featured ones — one call per object
  page(sort, cur, n, withFeat) {
    const rows = sort === "new"
      ? this.sql.exec(`SELECT ${COLS} FROM card WHERE pub = 1 AND feat = 0 AND pt < ? ORDER BY pt DESC LIMIT ?`, cur.t, n).toArray()
      : this.sql.exec(`SELECT ${COLS} FROM card WHERE pub = 1 AND feat = 0 AND (likes < ? OR (likes = ? AND pt < ?)) ORDER BY likes DESC, pt DESC LIMIT ?`, cur.l, cur.l, cur.t, n).toArray();
    const feat = withFeat ? this.sql.exec(`SELECT ${COLS} FROM card WHERE pub = 1 AND feat = 1 ORDER BY likes DESC, pt DESC LIMIT 200`).toArray() : [];
    return { rows, feat };
  }
  item(k) { return this.sql.exec(`SELECT ${COLS} FROM card WHERE k = ? AND pub = 1`, k).toArray()[0] || null; }
  thumb(k) {
    const r = this.sql.exec("SELECT th, thty FROM card WHERE k = ?", k).toArray()[0];
    if (!r) return null; if (!r.th) return this.get(k);
    return { ty: r.thty || "image/jpeg", b: new Uint8Array(r.th).buffer };
  }
  // likes: one per account and outfit; a like keeps the outfit from being cleared for a while
  like(k, u, on) {
    const c = this.sql.exec("SELECT likes, pub FROM card WHERE k = ?", k).toArray()[0];
    if (!c || !c.pub) return null;
    const had = this.sql.exec("SELECT 1 AS x FROM lk WHERE k = ? AND u = ?", k, u).toArray().length > 0;
    if (on && !had) { this.sql.exec("INSERT INTO lk (k, u, t) VALUES (?, ?, ?)", k, u, Date.now()); this.sql.exec("UPDATE card SET likes = likes + 1, t = ? WHERE k = ?", Date.now(), k); return c.likes + 1; }
    if (!on && had) { this.sql.exec("DELETE FROM lk WHERE k = ? AND u = ?", k, u); this.sql.exec("UPDATE card SET likes = MAX(0, likes - 1) WHERE k = ?", k); return Math.max(0, c.likes - 1); }
    return c.likes;
  }
  myLikes(u) { return this.sql.exec("SELECT k FROM lk WHERE u = ?", u).toArray().map(r => r.k); }
  renameAuthor(u, n) { this.sql.exec("UPDATE card SET nick = ? WHERE uid = ?", n, u); }
  // an account deleted: its likes go, its outfits leave the showcase (the admin's featured copies stay, without a name)
  forgetUser(u) {
    this.sql.exec("UPDATE card SET likes = MAX(0, likes - 1) WHERE k IN (SELECT k FROM lk WHERE u = ?)", u);
    this.sql.exec("DELETE FROM lk WHERE u = ?", u);
    for (const r of this.sql.exec("SELECT k FROM card WHERE uid = ? AND kind = 's' AND feat = 0", u).toArray()) this.drop(r.k);
    this.sql.exec("UPDATE card SET uid = NULL, nick = NULL WHERE uid = ?", u);
    this.recount();
  }
  // accounts (object "users"): pseudo, unique whatever the case
  login(u) {
    const r = this.sql.exec("SELECT n FROM user WHERE u = ?", u).toArray()[0];
    if (r) return r.n;
    for (let i = 0; i < 24; i++) {
      const n = randomNick(i > 8);
      if (!this.sql.exec("SELECT 1 AS x FROM user WHERE nl = ?", n.toLowerCase()).toArray().length) { this.sql.exec("INSERT INTO user (u, n, nl, t) VALUES (?, ?, ?, ?)", u, n, n.toLowerCase(), Date.now()); return n; }
    }
    const n = "Traveler" + Date.now().toString(36); this.sql.exec("INSERT INTO user (u, n, nl, t) VALUES (?, ?, ?, ?)", u, n, n.toLowerCase(), Date.now()); return n;
  }
  setNick(u, n) {
    const o = this.sql.exec("SELECT u FROM user WHERE nl = ?", n.toLowerCase()).toArray()[0];
    if (o && o.u !== u) return "taken";
    if (!this.sql.exec("SELECT 1 AS x FROM user WHERE u = ?", u).toArray().length) return "gone";
    this.sql.exec("UPDATE user SET n = ?, nl = ? WHERE u = ?", n, n.toLowerCase(), u); return "ok";
  }
  forgetAccount(u) { this.sql.exec("DELETE FROM user WHERE u = ?", u); }
  userCount() { return this.sql.exec("SELECT COUNT(*) AS c FROM user").toArray()[0].c; }
  secret() {
    const r = this.sql.exec("SELECT v FROM kv WHERE k = 'session'").toArray()[0]; if (r) return r.v;
    const v = [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, "0")).join("");
    this.sql.exec("INSERT INTO kv (k, v) VALUES ('session', ?)", v); return v;
  }
  // admin
  stats() { return this.sql.exec("SELECT COALESCE(SUM(kind IS NULL), 0) AS c, COALESCE(SUM(kind = 's'), 0) AS s, COALESCE(SUM(z), 0) AS z, COALESCE(SUM(pub = 1 AND feat = 0), 0) AS p, COALESCE(SUM(ban), 0) AS b, COALESCE(SUM(feat), 0) AS f FROM card").toArray()[0]; }
  adminList(which, before, n) {
    const q = "SELECT k, code, lang, %AT% AS at, pic, z, ban, pub, feat, likes, nick FROM card WHERE %W% AND %AT% < ? ORDER BY %AT% DESC LIMIT ?";
    const [at, w] = which === "ban" ? ["t", "ban = 1"] : which === "feat" ? ["pt", "feat = 1"] : ["pt", "kind = 's' AND pub = 1 AND feat = 0"];
    return this.sql.exec(q.replace(/%AT%/g, at).replace("%W%", w), before, n).toArray();
  }
  // hide / show an entry · unfeature (a featured copy: deleted) · delete (the picture, whatever it is)
  moderate(k, op) {
    const r = this.sql.exec("SELECT z, code, kind, feat FROM card WHERE k = ?", k).toArray()[0];
    if (!r) return false;
    const now = Date.now(), gone = () => { this.drop(k); this.setMeta("bytes", Math.max(0, this.meta("bytes") - r.z)); const m = r.kind === "s" ? "scount" : "count"; this.setMeta(m, Math.max(0, this.meta(m) - 1)); };
    if (op === "hide") { if (r.feat) gone(); else this.sql.exec("UPDATE card SET pub = 0, ban = 1, kind = 's' WHERE k = ?", k); }
    else if (op === "show") { if (!r.code || r.kind !== "s") return false; this.sql.exec("UPDATE card SET ban = 0, pub = 1, pt = CASE WHEN pt > 0 THEN pt ELSE ? END WHERE k = ?", now, k); }
    else if (op === "unfeature") { if (!r.feat) return false; gone(); }
    else if (op === "delete") gone();
    else return false;
    return true;
  }
}
// a card's object follows its key; the first one keeps the name of the single object used before (its cards stay readable)
const shardOf = key => (key.length === 32 ? parseInt(key[0], 16) : key.charCodeAt(key.length - 1)) % SHARDS;
const shardName = n => n ? "cards-" + n : "cards";
const store = (env, key) => env.CARDS ? env.CARDS.get(env.CARDS.idFromName(shardName(shardOf(key)))) : null;
const shards = env => env.CARDS ? Array.from({ length: SHARDS }, (_, n) => env.CARDS.get(env.CARDS.idFromName(shardName(n)))) : [];
const users = env => env.CARDS ? env.CARDS.get(env.CARDS.idFromName("users")) : null;
const legacy = (env, key) => env.CARDS && key.length === 32 && shardOf(key) ? env.CARDS.get(env.CARDS.idFromName("cards")) : null;
// every card object at once; one that fails counts as empty
const each = (env, f, empty) => Promise.all(shards(env).map(async s => { try { return await f(s); } catch (e) { return empty; } }));
const sniff = b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? "image/jpeg"
  : b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? "image/png"
  : b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 ? "image/webp" : "";
// link previews (Discord, X, Slack, WhatsApp, iMessage…) wait a little for a card that is on its way; people never wait
const BOTS = /bot\b|crawl|spider|preview|externalhit|facebot|embedly|iframely|slack|discord|telegram|whatsapp|skype|mastodon|bluesky|cardyb|pleroma|misskey|vkshare|pinterest|linkedin|google-|curl|wget|python|go-http|okhttp|axios|node-fetch|headless/i;
const isBot = request => { const ua = request.headers.get("user-agent") || ""; return !/Mozilla/.test(ua) || BOTS.test(ua); };
// a person opening the link in a browser (browsers mark navigations; link previews don't)
const isPerson = request => request.headers.get("sec-fetch-mode") === "navigate" && !isBot(request);
const enc = new TextEncoder(), sha256 = async s => [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))].map(x => x.toString(16).padStart(2, "0")).join("");
const json = (o, age, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": age ? `public, max-age=${age}` : "no-store" } });
const notFound = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/* ---------- accounts ---------- */
// the Google token the page holds for Drive sync: issued to the Miliadex (tokeninfo's audience); the account through Drive
const googleSeen = new Map();
async function googleUser(tok) {
  if (!tok || tok.length > 4096) return null;
  const h = await sha256(tok), c = googleSeen.get(h);
  if (c && c.exp > Date.now()) return c.user;
  let user = null;
  try {
    const ti = await (await fetch("https://oauth2.googleapis.com/tokeninfo?access_token=" + encodeURIComponent(tok))).json();
    if (ti && !ti.error && (!D.g || ti.aud === D.g || ti.azp === D.g)) {
      const r = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,permissionId)", { headers: { authorization: "Bearer " + tok } });
      if (r.ok) { const j = await r.json(), u = j && j.user; if (u && u.permissionId) user = { uid: "g" + u.permissionId, email: String(u.emailAddress || "").trim().toLowerCase() }; }
    }
  } catch (e) { user = null; }
  if (googleSeen.size > 500) googleSeen.clear();
  googleSeen.set(h, { user, exp: Date.now() + (user ? 10 : 2) * 60e3 });
  return user;
}
const bearer = request => (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
// sessions: {u, n (pseudo), e (expiry)} signed with a key kept in the "users" object (read once per Worker instance)
let SKEY = null;
async function sessionKey(env) {
  if (!SKEY) { const hex = await users(env).secret(); SKEY = await crypto.subtle.importKey("raw", new Uint8Array(hex.match(/../g).map(x => parseInt(x, 16))), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]); }
  return SKEY;
}
const b64u = by => btoa(String.fromCharCode(...by)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function makeSession(env, u, n) {
  const e = Date.now() + 30 * 864e5, p = b64u(enc.encode(JSON.stringify({ u, n, e })));
  return { s: p + "." + b64u(new Uint8Array(await crypto.subtle.sign("HMAC", await sessionKey(env), enc.encode(p)))), n, e };
}
async function readSession(env, request) {
  const tok = request.headers.get("x-session") || "";
  const [p, sig] = tok.split(".");
  if (!p || !sig || tok.length > 1200) return null;
  try {
    if (!await crypto.subtle.verify("HMAC", await sessionKey(env), bytes64(sig), enc.encode(p))) return null;
    const d = JSON.parse(new TextDecoder().decode(bytes64(p)));
    return d && d.u && d.e > Date.now() ? d : null;
  } catch (e) { return null; }
}
// names people choose (pseudo, showcase outfit names): a short list of insults, slurs and sexual words in English and French,
// read through common disguises (accents, l33t, s.p.a.c.e.s, CamelCase, repeated letters). Base64 so the source doesn't spell them out
const BADW=JSON.parse(atob("eyJzIjpbImZ1Y2siLCJiaXRjaCIsIndob3JlIiwic2x1dCIsInJhcGlzdCIsInBvcm4iLCJoZW50YWkiLCJuc2Z3IiwicGVkb3BoaWwiLCJwYWVkb3BoaWwiLCJoaXRsZXIiLCJhc3Nob2xlIiwicGVuaXMiLCJ2YWdpbmEiLCJqaXp6IiwiZGlsZG8iLCJtYXN0dXJiIiwib3JnYXNtIiwibWlsZiIsImluY2VzdCIsImtpbGx5b3Vyc2VsZiIsInB1dGFpbiIsInNhbG9wZSIsImVuY3VsIiwiY29ubmFyZCIsImNvbm5hc3NlIiwidGFybG91emUiLCJuaXF1ZXRhbWVyZSIsImNvdWlsbGUiLCJicmFubGUiLCJzdWNldXNlIiwiYmFtYm91bGEiLCJib3Vnbm91bCIsInlvdXBpbiIsImNoaW50b2siLCJlbmZvaXJlIiwidmlvbGV1ciIsInBlZG9waGlsZSIsIm5lZ3JvZmlsIiwiZnZjayIsInBodWNrIiwiYmlhdGNoIiwibW90aGVyZnVjayJdLCJyIjpbIm5pZ2ciLCJmYWdnb3QiLCJmYWdvdCJdLCJ3IjpbInNoaXQiLCJjdW50IiwicmV0YXJkIiwicmFwZSIsInBlZG8iLCJuYXppIiwibmF6aXMiLCJoZWlsIiwia2trIiwiZGljayIsImNvY2siLCJwdXNzeSIsImJvb2IiLCJib29icyIsInRpdHMiLCJhbmFsIiwic2V4Iiwic2V4ZSIsImN1bSIsImt5cyIsInB1dGUiLCJwdXRlcyIsInNhbGF1ZCIsImNvbm5lIiwicGQiLCJwZWRlIiwidGFwZXR0ZSIsImZkcCIsIm50bSIsIm5pcXVlIiwibmlxdWVyIiwidGFtZXJlIiwiYml0ZSIsInN1Y2UiLCJjaGllbm5lIiwibmVncmUiLCJuZWdybyIsImJpY290Iiwieml6aSIsImZvdXRyZSIsImJhdGFyZCIsIm1lcmRlIiwidmlvbCIsIm5hemllIiwiZmFnIiwiZmFncyIsInR3YXQiLCJ3YW5rIiwid2Fua2VyIiwiYm9sbG9ja3MiLCJwcmljayIsImJhc3RhcmQiLCJjdWwiLCJwb3JubyIsInh4eCIsImZjayIsImZ1ayIsImZraW5nIiwiZmNraW5nIiwic3RmdSJdfQ=="));
function nameOk(s){
  const L={"0":"o","1":"i","3":"e","4":"a","5":"s","7":"t","8":"b","@":"a","$":"s","!":"i","|":"i","€":"e"};
  const sp=String(s||"").replace(/([a-z])([A-Z])/g,"$1 $2").normalize("NFKD").replace(/[̀-ͯ]/g,"").toLowerCase().replace(/[0134578@$!|€]/g,c=>L[c]);
  const words=sp.split(/[^a-z]+/).filter(Boolean), all=words.join(""), sq=x=>x.replace(/(.)\1+/g,"$1");
  if(BADW.r.some(x=>all.includes(x)) || BADW.s.some(x=>all.includes(x) || sq(all).includes(sq(x)))) return false;
  const W=new Set([...BADW.w, ...BADW.w.map(sq).filter(x=>x.length>=5)]), cand=[...words, all];
  let run=""; for(const w of [...words,"--"]){ if(w.length===1) run+=w; else { if(run.length>1) cand.push(run); run=""; } }   // "s h i t"
  return !cand.some(x=>W.has(x) || W.has(sq(x)));
}
const safeName = n => nameOk(n) ? n : "";
function cleanNick(x) {
  const s = String(x || "").normalize("NFC").replace(/\s+/g, " ").trim();
  if (s.length < 3 || s.length > 20 || !/^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u.test(s) || /miliadex|admin|modérat|moderat/i.test(s)) return null;
  return s;
}
// POST /api/auth (Google token) · /api/nick {nick} · /api/like {k, on} · /api/account/delete · /api/show/publish (form) ·
// /api/show/remove {k} · /api/show/mine — all but the first with the session (x-session)
async function accountApi(request, env, url, ctx) {
  if (request.method !== "POST") return notFound();
  const op = url.pathname.slice(5);
  if (op === "auth") {
    const g = await googleUser(bearer(request)); if (!g) return json({ error: "google" }, 0, 401);
    const n = await users(env).login(g.uid), likes = (await each(env, s => s.myLikes(g.uid), [])).flat();
    return json({ ...await makeSession(env, g.uid, n), likes });
  }
  const me = await readSession(env, request); if (!me) return json({ error: "session" }, 0, 401);
  if (op === "show/publish") {               // card = the outfit image · thumb = its small picture · code · lang · lid (the saved outfit) · pic
    const f = await request.formData(), card = f.get("card"), thumb = f.get("thumb"), code = String(f.get("code") || ""), lid = String(f.get("lid") || "");
    const L = code.length <= 4000 ? readLook(code) : null;
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(lid) || !L || !L.its.length || !card || typeof card === "string") return json({ error: "bad" }, 0, 400);
    if (!nameOk(L.n)) return json({ error: "name" }, 0, 400);   // outfit names shown in the showcase: same check as pseudos
    const b = new Uint8Array(await card.arrayBuffer()), ty = sniff(b);
    if (!ty || b.length > 8 * 1024 * 1024) return json({ error: "bad" }, 0, 400);
    let th = null; if (thumb && typeof thumb !== "string") { const t = new Uint8Array(await thumb.arrayBuffer()); if (sniff(t) && t.length <= 300 * 1024) th = t; }
    const k = (await sha256(`s|${me.u}|${lid}`)).slice(0, 32), s = store(env, k);
    const r = await s.publish(k, ty, b.buffer, { code, lang: f.get("lang") === "fr" ? "fr" : "en", pic: f.get("pic") === "1", uid: me.u, nick: me.n, th: th && th.buffer, thty: th && sniff(th) });
    if (r.error) return json(r, 0, r.error === "wait" ? 429 : 403);
    if (r.new) {                             // at most PER_USER outfits in the showcase per account
      const n = (await each(env, x => x.countBy(me.u), 0)).reduce((a, c) => a + c, 0);
      if (n > PER_USER) { await s.removeOwn(k, me.u); return json({ error: "limit", max: PER_USER }, 0, 403); }
    }
    dropShowCache(url.origin, ctx);
    return json({ ok: true, k, new: r.new });
  }
  if (op === "show/mine") return bundle({ items: (await each(env, s => s.mine(me.u), [])).flat().sort((a, b) => b.pt - a.pt), feat: [] }, 0);
  let body = {}; try { body = await request.json(); } catch (e) {}
  if (op === "show/remove") {
    const k = String(body.k || ""); if (!/^[0-9a-f]{32}$/.test(k)) return json({ error: "bad" }, 0, 400);
    const ok = await store(env, k).removeOwn(k, me.u); if (ok) dropShowCache(url.origin, ctx);
    return ok ? json({ ok: true }) : json({ error: "owner" }, 0, 403);
  }
  if (op === "like") {
    const k = String(body.k || ""); if (!/^[0-9a-f]{32}$/.test(k)) return json({ error: "bad" }, 0, 400);
    const n = await store(env, k).like(k, me.u, !!body.on);
    return n == null ? json({ error: "gone" }, 0, 404) : json({ ok: true, likes: n });
  }
  if (op === "nick") {
    const n = cleanNick(body.nick); if (!n) return json({ error: "bad" }, 0, 400);
    if (!nameOk(n)) return json({ error: "rude" }, 0, 400);   // the page checks it too: this is for calls made without the page
    const r = await users(env).setNick(me.u, n); if (r !== "ok") return json({ error: r }, 0, r === "taken" ? 409 : 400);
    await each(env, s => s.renameAuthor(me.u, n), null); dropShowCache(url.origin, ctx);
    return json(await makeSession(env, me.u, n));
  }
  if (op === "account/delete") {
    await users(env).forgetAccount(me.u); await each(env, s => s.forgetUser(me.u), null); dropShowCache(url.origin, ctx);
    return json({ ok: true });
  }
  return notFound();
}

/* ---------- preview pictures ---------- */
// POST /api/card?k=c|o&l=en|fr&c=<code>  body: the picture the page drew for that link, or (outfits) a form: card = the picture ·
// pic = 1 with an in-game screenshot (a link picture never goes to the showcase: that is POST /api/show/publish)
async function saveCard(request, env, url, ctx) {
  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  const k = url.searchParams.get("k"), code = url.searchParams.get("c") || "", lang = url.searchParams.get("l") === "fr" ? "fr" : "en";
  const short = url.searchParams.get("x") === "1", salt = url.searchParams.get("s") || "";   // x=1: a short link (its key comes back)
  if (!/^[co]$/.test(k) || code.length > 4000 || salt.length > 64 || !/^[A-Za-z0-9_-]*$/.test(salt)) return new Response("bad link", { status: 400 });
  const L = k === "o" ? readLook(code) : null, ok = k === "c" ? await readCol(code) : L;
  if (!ok) return new Response("bad link", { status: 400 });
  if (!nameOk(k === "o" ? L.n : ok.name)) return json({ error: "name" }, 0, 400);
  let b, pic = false;
  if (/multipart\/form-data/i.test(request.headers.get("content-type") || "")) {
    const f = await request.formData(), card = f.get("card");
    if (!card || typeof card === "string") return new Response("bad picture", { status: 400 });
    b = new Uint8Array(await card.arrayBuffer()); pic = f.get("pic") === "1";
  } else b = new Uint8Array(await request.arrayBuffer());
  const ty = sniff(b);
  if (!ty || b.length > 8 * 1024 * 1024) return new Response("bad picture", { status: 400 });
  const key = short ? await shortKey(k, code, lang, salt) : await cardKey(k, code, lang), s = store(env, key); if (!s) return new Response("no store", { status: 503 });
  await s.put(key, ty, b.buffer, { code, lang, pic, link: short ? k : null });
  return short ? json({ k: key }) : new Response(null, { status: 204 });
}
// is the picture there? The page sends it before the link is copied: previews still give it a moment before answering without it
async function cardThere(env, key, tries) {
  const s = store(env, key);
  for (let i = 0; s && i < tries; i++) {
    try { if (await s.has(key)) return true; } catch (e) { return false; }
    if (i < tries - 1) await new Promise(res => setTimeout(res, 600));
  }
  try { const l = legacy(env, key); return !!l && await l.has(key); } catch (e) { return false; }
}
// the preview's picture: the card when the site has it, the site banner otherwise (so a card address never stands for the banner)
// collection: a 1200 × 630 card (JPEG) · outfit: the picture the site downloads, 1080 × 1350 JPEG with the outfit inside
async function previewImage(env, origin, k, code, lang, bot) {
  const key = await cardKey(k, code, lang);
  if (!await cardThere(env, key, bot ? 5 : 1)) return { image: `${origin}/og-banner.png`, w: 1200, h: 400, brief: true };
  return k === "o" ? { image: `${origin}/card/${key}.jpg`, w: 1080, h: 1350, key } : { image: `${origin}/card/${key}.jpg`, w: 1200, h: 630, key };
}
// what a short link stands for: {kind, code, lang, pic, card}. Kept in the edge cache for a week (it never changes), so a link
// opened again and again reads the storage once; bots get a few tries (the link may be pasted as its picture is still on its way)
const linkCacheKey = (origin, k) => new Request(origin + "/__link/" + k);
async function linkOf(env, origin, key, ctx, tries = 1) {
  const ck = linkCacheKey(origin, key), cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache) { const hit = await cache.match(ck).catch(() => null); if (hit) try { return await hit.json(); } catch (e) {} }
  const s = store(env, key); let r = null;
  for (let i = 0; s && i < tries && !r; i++) {
    try { r = await s.linkGet(key); } catch (e) { return null; }
    if (!r && i < tries - 1) await new Promise(res => setTimeout(res, 600));
  }
  if (r && cache) { const p = cache.put(ck, new Response(JSON.stringify(r), { headers: { "content-type": "application/json", "cache-control": "public, max-age=604800" } })).catch(() => {}); if (ctx && ctx.waitUntil) ctx.waitUntil(p); }
  return r;
}
// /o/<short> and /c/<short>: a person goes straight to the site with the code; a link preview gets the card
async function shortLink(request, env, ctx, url, kind, key) {
  const origin = url.origin, person = isPerson(request), bot = isBot(request);
  const r = await linkOf(env, origin, key, ctx, person ? 1 : bot ? 5 : 1);
  if (!r || r.kind !== kind) return new Response(null, { status: 302, headers: { location: origin + "/#" + kind + "=" + key, "cache-control": "no-store" } });   // the page says it's gone
  const lang = r.lang === "fr" ? "fr" : "en";
  const target = kind === "c" ? "/#col=" + r.code : "/#look=" + r.code + (lang === "fr" ? "&l=fr" : "") + "&p=" + (r.pic ? "1&card=" + key : "0");
  if (person) return new Response(null, { status: 302, headers: { location: origin + target, "cache-control": "no-store" } });
  const here = origin + url.pathname;
  const img = r.card ? { image: `${origin}/card/${key}.jpg`, w: kind === "o" ? 1080 : 1200, h: kind === "o" ? 1350 : 630 } : { image: `${origin}/og-banner.png`, w: 1200, h: 400, brief: true };
  if (kind === "c") {
    const c = await readCol(r.code); if (!c) return Response.redirect(origin + target, 302);
    return page({ ...colShort(c, lang), ...img, large: true }, here, target, lang);
  }
  const L = readLook(r.code); if (!L) return Response.redirect(origin + target, 302);
  return page({ title: TX[lang].outfit(safeName(L.n)), desc: lookShort(L, lookInfo(L), lang), ...img, large: true, color: SITE_COLOR }, here, target, lang);
}
// GET /card/<key>.png|jpg  the picture (cards can be replaced: the same outfit shared again with another screenshot)
// GET /card/<key>/thumb    its small square picture (admin page), the picture itself for cards sent without one
async function sendCard(env, origin, key, small) {
  const s = store(env, key);
  for (let i = 0; s && i < 2; i++) {
    let r = null; try { r = small ? await s.thumb(key) : await s.get(key); } catch (e) {}
    if (!r && i === 0) try { const l = legacy(env, key); if (l) r = await l.get(key); } catch (e) {}
    if (r) return new Response(r.b, { headers: { "content-type": r.ty, "cache-control": "public, max-age=86400" } });
    await new Promise(res => setTimeout(res, 700));
  }
  const fb = await env.ASSETS.fetch(new Request(origin + "/og-banner.png"));
  return new Response(fb.body, { headers: { "content-type": "image/png", "cache-control": "public, max-age=120", "x-miliadex": "no-card" } });
}

/* ---------- Outfits Showcase ---------- */
// one response per page: "MLS1" · JSON length (u32) · JSON {items, feat, next} · the small pictures back to back (th: [offset, length, type])
function bundle(o, age) {
  const parts = []; let off = 0;
  const out = x => {
    const r = { k: x.k, c: x.code, l: x.lang || "en", t: x.pt, p: x.pic ? 1 : 0, lk: x.likes || 0, n: x.nick || "", f: x.feat ? 1 : 0 };
    if (x.ban) r.b = 1; if (x.ut) r.u = x.ut;
    if (x.th) { const b = new Uint8Array(x.th); r.th = [off, b.length, x.thty || "image/jpeg"]; parts.push(b); off += b.length; }
    return r;
  };
  const js = enc.encode(JSON.stringify({ items: o.items.map(out), feat: (o.feat || []).map(out), next: o.next || null })), head = new Uint8Array(8);
  head.set([77, 76, 83, 49]); new DataView(head.buffer).setUint32(4, js.length);
  return new Response(new Blob([head, js, ...parts]), { headers: { "content-type": "application/octet-stream", "cache-control": age ? `public, max-age=${age}` : "no-store" } });
}
const showCacheKey = (origin, q) => new Request(origin + "/api/showcase?" + q);
function dropShowCache(origin, ctx) {
  try { if (typeof caches !== "undefined") { const p = Promise.all(["sort=top", "sort=new"].map(q => caches.default.delete(showCacheKey(origin, q)))); if (ctx && ctx.waitUntil) ctx.waitUntil(p.catch(() => {})); } } catch (e) {}
}
const dedupe = rows => { const seen = new Set(); return rows.filter(r => r.code && !seen.has(r.code) && seen.add(r.code)); };   // the same outfit shared in English and French: once
// GET /api/showcase?sort=top|new[&after=<cursor>] · GET /api/showcase?k=<key> (one of them)
async function showcaseList(env, url, ctx) {
  const one = url.searchParams.get("k");
  if (one != null) {
    let r = null; if (/^[0-9a-f]{32}$/.test(one)) try { const s = store(env, one); r = s && await s.item(one); } catch (e) {}
    return bundle({ items: r && !r.feat ? [r] : [], feat: r && r.feat ? [r] : [] }, 60);
  }
  const sort = url.searchParams.get("sort") === "new" ? "new" : "top", after = (url.searchParams.get("after") || "").slice(0, 60);
  const q = "sort=" + sort + (after ? "&after=" + encodeURIComponent(after) : ""), ck = showCacheKey(url.origin, q);
  const hit = typeof caches !== "undefined" ? await caches.default.match(ck).catch(() => null) : null;
  if (hit) return hit;
  const [a, b] = after.split("_").map(Number), cur = sort === "new" ? { t: a || 9e15 } : { l: after ? a || 0 : 1e15, t: b || 9e15 };
  const got = await each(env, s => s.page(sort, cur, PAGE + 4, !after), { rows: [], feat: [] });
  const order = sort === "new" ? (x, y) => y.pt - x.pt : (x, y) => y.likes - x.likes || y.pt - x.pt;
  const items = dedupe(got.flatMap(g => g.rows).sort(order)).slice(0, PAGE), last = items[items.length - 1];
  const feat = dedupe(got.flatMap(g => g.feat).sort((x, y) => y.likes - x.likes || y.pt - x.pt));
  const res = bundle({ items, feat, next: items.length >= PAGE ? (sort === "new" ? String(last.pt) : last.likes + "_" + last.pt) : null }, 60);
  if (typeof caches !== "undefined") { const p = caches.default.put(ck, res.clone()).catch(() => {}); if (ctx && ctx.waitUntil) ctx.waitUntil(p); }
  return res;
}

/* ---------- admin ---------- */
// sha256 of the owner's Google address and of the secret part of the admin address (neither is written here in clear)
const ADMIN_EMAIL = "65022ea26dc785e5b8c6c96b814e0a7f127c3cc439cd6684bc53fd75a39288ec";
const ADMIN_PATH = "6e4e34447ea09adf1e85c657b16d940af33af38b9bcb5d284a038d859c97a86a";
async function isAdmin(request, seg) {
  if (typeof seg !== "string" || !seg || seg.length > 100 || await sha256(seg) !== ADMIN_PATH) return false;
  const g = await googleUser(bearer(request));
  return !!g && !!g.email && await sha256(g.email) === ADMIN_EMAIL;
}
// POST /api/admin/me | list | set   body {seg, …}: anything else, or anyone else, gets a plain 404
async function adminApi(request, env, url, ctx) {
  if (request.method !== "POST") return notFound();
  let body = {}; try { body = await request.json(); } catch (e) {}
  if (!body || !await isAdmin(request, body.seg)) return notFound();
  const op = url.pathname.slice("/api/admin/".length);
  if (op === "me") {
    let people = 0; try { people = await users(env).userCount(); } catch (e) {}
    return json({ ok: true, max: SHARDS * MAX_CARDS, maxShow: SHARDS * MAX_SHOW, budget: SHARDS * BUDGET, people, stats: await each(env, s => s.stats(), null) });
  }
  if (op === "list") {
    const which = ["ban", "feat"].includes(body.which) ? body.which : "pub", before = Math.min(+body.before || 9e15, 9e15), N = 48;
    const rows = (await each(env, s => s.adminList(which, before, N), [])).flat().sort((a, b) => b.at - a.at).slice(0, N);
    return json({ items: rows.map(r => ({ k: r.k, c: r.code, l: r.lang || "en", at: r.at, p: r.pic ? 1 : 0, z: r.z, ban: r.ban, pub: r.pub, f: r.feat, lk: r.likes, n: r.nick || "" })), next: rows.length >= N ? rows[rows.length - 1].at : null });
  }
  if (op === "set") {
    const k = String(body.k || "");
    if (!/^[0-9a-f]{32}$/.test(k) || !["hide", "show", "delete", "feature", "unfeature"].includes(body.op)) return json({ ok: false }, 0, 400);
    let ok = false;
    if (body.op === "feature") {             // a frozen copy in Featured; the original stays in the community
      const x = await store(env, k).exportEntry(k);
      if (x) { const fk = (await sha256(`f|${k}|${Date.now()}`)).slice(0, 32); ok = await store(env, fk).putFeatured(fk, x, k); }
    } else ok = await store(env, k).moderate(k, body.op);
    dropShowCache(url.origin, ctx);
    return json({ ok });
  }
  return notFound();
}
// /a/<anything>: the site's page with a 404 status; the page itself shows "page not found" unless the owner is signed in
async function adminPage(env, origin) {
  const r = await env.ASSETS.fetch(new Request(origin + "/index.html"));
  return new Response(r.body, { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), origin = url.origin;
    const lang = url.searchParams.get("l") === "fr" ? "fr" : "en";
    try {
      if (url.pathname === "/api/card") return await saveCard(request, env, url, ctx);
      if (url.pathname === "/api/showcase") return await showcaseList(env, url, ctx);
      if (url.pathname === "/api/link") {   // GET ?k=<short key>: what a short link stands for (when one reaches the page some other way)
        const k = url.searchParams.get("k") || "", r = SHORT.test(k) ? await linkOf(env, origin, k, ctx) : null;
        return r ? json({ k, kind: r.kind, code: r.code, lang: r.lang, pic: r.pic }, 86400) : json({ error: "gone" }, 0, 404);
      }
      if (url.pathname.startsWith("/api/admin/")) return await adminApi(request, env, url, ctx);
      if (/^\/api\/(auth|nick|like|account\/delete|show\/(publish|remove|mine))$/.test(url.pathname)) return await accountApi(request, env, url, ctx);
      if (url.pathname.startsWith("/a/")) return await adminPage(env, origin);
      const cm = url.pathname.match(/^\/card\/([0-9a-f]{32}|[0-9A-Za-z]{10})(?:\.(?:jpg|png|webp)|\/(thumb))$/);
      if (cm) return await sendCard(env, origin, cm[1], !!cm[2]);
    } catch (e) { return new Response("error", { status: 500 }); }
    const m = url.pathname.match(/^\/([cos])\/([^/]+)\/?$/);
    if (!m) return env.ASSETS.fetch(request);
    const [, kind, raw] = m;
    let arg = raw; try { arg = decodeURIComponent(raw); } catch (e) {}
    if ((kind === "o" || kind === "c") && SHORT.test(arg)) {   // short links (a long link's code is never exactly 10 letters or digits)
      try { return await shortLink(request, env, ctx, url, kind, arg); } catch (e) { return Response.redirect(origin + "/", 302); }
    }
    // where the site takes over: the outfit's language and "has an in-game screenshot" ride along, the page works out the rest
    const p = url.searchParams.get("p"), lookAt = card => "/#look=" + arg + (lang === "fr" ? "&l=fr" : "") + (p === "0" || p === "1" ? "&p=" + p : "") + (card ? "&card=" + card : "");
    const target = kind === "c" ? "/#col=" + arg : kind === "o" ? lookAt("") : "/#show=" + encodeURIComponent(arg);
    // a person: straight to the site (no storage read, nothing to describe)
    if (isPerson(request)) return new Response(null, { status: 302, headers: { location: origin + target, "cache-control": "no-store" } });
    const here = origin + url.pathname + url.search, bot = isBot(request);
    try {
      if (kind === "c") {
        const c = await readCol(arg);
        if (!c) return Response.redirect(origin + target, 302);
        return page({ ...colShort(c, lang), ...await previewImage(env, origin, "c", arg, lang, bot), large: true }, here, target, lang);
      }
      if (kind === "o") {
        const L = readLook(arg);
        if (!L) return Response.redirect(origin + target, 302);
        const info = lookInfo(L), pic = await previewImage(env, origin, "o", arg, lang, bot);
        return page({ title: TX[lang].outfit(safeName(L.n)), desc: lookShort(L, info, lang), ...pic, large: true, color: SITE_COLOR }, here, lookAt(pic.key), lang);
      }
      if (/^u-[0-9a-f]{32}$/.test(arg)) {   // a community outfit
        const k = arg.slice(2); let e = null; try { e = await store(env, k).item(k); } catch (x) {}
        const L = e && readLook(e.code); if (!L) return Response.redirect(origin + target, 302);
        const title = TX[lang].show(safeName(L.n) || "…") + (e.nick && nameOk(e.nick) ? (lang === "fr" ? " · par " : " · by ") + e.nick : "");
        return page({ title, desc: lookShort(L, lookInfo(L), lang), image: `${origin}/card/${k}.jpg`, w: 1080, h: 1350, large: true, color: SITE_COLOR }, here, target, lang);
      }
      const it = await showItem(env, origin, arg);
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
