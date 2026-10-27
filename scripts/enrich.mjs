// Fills posters, runtime, synopsis, IMDb id and IMDb rating for every item in data/library.json.
// Every match is checked against the director and year before it is accepted.
// Secrets: OMDB_KEY (required), TMDB_TOKEN (optional, sharper posters).
import fs from "node:fs/promises";

const FILE = new URL("../data/library.json", import.meta.url);
const OMDB = (process.env.OMDB_KEY || "").trim();
const TMDB = (process.env.TMDB_TOKEN || "").trim();
const REFRESH = process.env.REFRESH_RATINGS === "1" && new Date().getUTCDate() === 1; // scheduled runs refresh everything on the 1st of the month
const VERIFIED = 3; // bump to re-check everything with the current rules
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!OMDB) {
  console.error("OMDB_KEY is missing. Add it in Settings → Secrets and variables → Actions.");
  process.exit(1);
}

let calls = 0;
async function omdb(params) {
  const url = new URL("https://www.omdbapi.com/");
  url.searchParams.set("apikey", OMDB);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  calls++;
  const res = await fetch(url);
  const j = await res.json().catch(() => ({}));
  if (j.Error && /invalid api key|not activated|limit/i.test(j.Error)) throw new Error("OMDb: " + j.Error);
  await sleep(40);
  return j.Response === "True" ? j : null;
}

async function tmdbPoster(imdbId) {
  if (!TMDB || !imdbId) return null;
  const url = new URL(`https://api.themoviedb.org/3/find/${imdbId}`);
  url.searchParams.set("external_source", "imdb_id");
  const headers = { accept: "application/json" };
  if (TMDB.length <= 40) url.searchParams.set("api_key", TMDB); else headers.Authorization = "Bearer " + TMDB;
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  const j = await res.json();
  const hit = (j.movie_results || [])[0] || (j.tv_results || [])[0];
  return hit?.poster_path || null;
}

const norm = (s) => String(s || "").toLowerCase().replace(/ł/g, "l").replace(/ø/g, "o").replace(/æ/g, "ae").replace(/ß/g, "ss").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
const yearOf = (s) => parseInt(String(s || "").slice(0, 4)) || 0;
// First and last word of every director name: covers "Wong Kar-wai" ↔ "Kar-Wai Wong" and "Bong Joon-ho".
const nameKeys = (d) => String(d || "").split(/,|&|\band\b/).flatMap((p) => { const w = norm(p).split(" ").filter((x) => x.length > 2); return w.length ? [w[0], w[w.length - 1]] : []; });
const words = (s) => new Set(norm(s).split(" "));

// A candidate is accepted only when the director (for series: the creator) matches and the year is within one.
function accept(f, m) {
  if (Math.abs(yearOf(m.Year) - f.y) > 1) return false;
  const dir = words(f.type === "series" ? `${m.Director} ${m.Writer}` : m.Director);
  return nameKeys(f.d).some((k) => dir.has(k));
}

const titleVariants = (t) => [t, t.replace(/\s*\(.*?\)\s*/g, " ").trim(), t.replace("½", " 1/2"), t.replace(/\s*[–—]\s*/g, " - "), t.replace(/\s*[–—:]\s*/g, " ").replace(/\s+/g, " ")].filter((v, i, a) => v && a.indexOf(v) === i);
const typeFor = (f) => (f.type === "series" ? "series" : "movie");

async function resolve(f) {
  // 1. A manually set IMDb id always wins.
  if (f.idLock && f.imdbId) return omdb({ i: f.imdbId, plot: "short" });
  // 2. The id we already have, if it checks out.
  if (f.imdbId) {
    const m = await omdb({ i: f.imdbId, plot: "short" });
    if (m && accept(f, m)) return m;
  }
  // 3. Search by title and verify each candidate.
  const seen = new Set();
  for (const t of titleVariants(f.t)) {
    for (const y of [f.y, ""]) {
      const s = await omdb({ s: t, y, type: typeFor(f) });
      const cands = (s?.Search || []).filter((c) => !seen.has(c.imdbID) && Math.abs(yearOf(c.Year) - f.y) <= 1).slice(0, 3);
      for (const c of cands) {
        seen.add(c.imdbID);
        const m = await omdb({ i: c.imdbID, plot: "short" });
        if (m && accept(f, m)) return m;
      }
    }
  }
  return null;
}

const lib = JSON.parse(await fs.readFile(FILE, "utf8"));
const before = JSON.stringify(lib);

// New titles from data/additions.json are appended once (matched by id = "title|year" in lowercase).
const additions = JSON.parse(await fs.readFile(new URL("../data/additions.json", import.meta.url), "utf8").catch(() => "[]"));
const ids = new Set(lib.films.map((f) => f.id));
let added = 0;
for (const a of additions) {
  const id = a.id || `${a.t}|${a.y}`.toLowerCase();
  if (ids.has(id)) continue;
  lib.films.push({ w: false, r: null, lb: null, imdb: null, c: [], g: [], n: "", type: "film", ...a, id });
  ids.add(id); added++;
}
if (added) console.log(`Added ${added} new titles from additions.json`);

// Franchises from data/franchises.json: [{ name, ids: [...] }] — order in the file is the watch order.
const franchises = JSON.parse(await fs.readFile(new URL("../data/franchises.json", import.meta.url), "utf8").catch(() => "[]"));
const frMap = new Map();
franchises.forEach((fr) => fr.ids.forEach((id, i) => frMap.set(id, { fr: fr.name, frI: i })));
for (const f of lib.films) {
  const x = frMap.get(f.id);
  if (x) { f.fr = x.fr; f.frI = x.frI; } else { delete f.fr; delete f.frI; }
}

// Manual corrections from data/fixes.json (this file is never written by the script, so editing it can't clash with its commits).
const fixes = JSON.parse(await fs.readFile(new URL("../data/fixes.json", import.meta.url), "utf8").catch(() => "{}"));
for (const f of lib.films) {
  const fx = fixes[f.id];
  if (!fx) continue;
  if (fx.d && fx.d !== f.d) f.d = fx.d;
  if (fx.t && fx.t !== f.t) f.t = fx.t;
  if (fx.trailer !== undefined) f.trailer = fx.trailer;
  if (Array.isArray(fx.cast)) f.cast = fx.cast;
  if (fx.n !== undefined) f.n = fx.n;
  // Watched / month watched / review. Applied only when the fix itself changes, so later edits made in the web app aren't overwritten.
  const wk = JSON.stringify([fx.w, fx.wd, fx.rev]);
  if ((fx.w !== undefined || fx.wd !== undefined || fx.rev !== undefined) && f.fxW !== wk) {
    if (fx.w !== undefined) f.w = !!fx.w;
    if (fx.wd !== undefined) f.wd = fx.wd || null;
    if (fx.rev !== undefined) f.rev = fx.rev;
    f.fxW = wk;
  }
  if (fx.imdbId && (fx.imdbId !== f.imdbId || !f.idLock)) {
    Object.assign(f, { imdbId: fx.imdbId, idLock: true, v: 0, imdb: null, runtime: null, overview: null, lb: null, lbUrl: null });
    delete f.check;
    if (!f.posterLock) f.poster = null;
  }
  if (fx.poster && (fx.poster !== f.poster || !f.posterLock)) { f.poster = fx.poster; f.posterLock = true; }
}
const missed = [], unsure = [];
for (const f of lib.films) {
  try {
    // Matched by an older, looser rule: re-check the id it has; keep the data if the check is inconclusive.
    if (f.v === 2 && f.imdbId && !f.idLock) {
      const m = await omdb({ i: f.imdbId });
      if (!m || !accept(f, m)) { unsure.push(`${f.t} (${f.y}) — ${f.imdbId}, director on IMDb: ${m?.Director || "?"}`); f.check = true; }
      else delete f.check;
      f.v = VERIFIED;
      continue;
    }
    if (f.v === VERIFIED) {
      if (REFRESH && f.imdbId) {
        const m = await omdb({ i: f.imdbId });
        const r = parseFloat(m?.imdbRating);
        if (Number.isFinite(r)) f.imdb = r;
      }
      continue;
    }
    const m = await resolve(f);
    if (!m) {
      // Drop data from an earlier unverified match.
      if (!f.idLock) { f.imdbId = null; f.imdb = null; f.runtime = null; f.overview = null; }
      if (!f.posterLock) f.poster = null;
      missed.push(`${f.t} (${f.y})`);
      continue;
    }
    f.imdbId = m.imdbID;
    const r = parseFloat(m.imdbRating);
    f.imdb = Number.isFinite(r) ? r : null;
    f.runtime = parseInt(m.Runtime) || null;
    f.overview = m.Plot && m.Plot !== "N/A" ? m.Plot : null;
    if (!f.posterLock) {
      const tp = await tmdbPoster(m.imdbID);
      f.poster = tp || (m.Poster && m.Poster !== "N/A" ? m.Poster : null);
      if (!f.poster) missed.push(`${f.t} (${f.y}) — matched ${m.imdbID}, but no poster`);
    }
    f.v = VERIFIED;
    delete f.check;
  } catch (e) {
    if (/OMDb:/.test(e.message)) { console.error(e.message); break; }
    console.warn(`${f.t}: ${e.message}`);
  }
}
// ---- Lead actors (top 4 from OMDb), once per title. Stops quietly when the daily OMDb limit is reached.
{
  let got = 0;
  for (const f of lib.films.filter((x) => x.imdbId && x.cast === undefined)) {
    try {
      const m = await omdb({ i: f.imdbId });
      if (!m) { f.cast = []; continue; }
      f.cast = (m.Actors && m.Actors !== "N/A") ? m.Actors.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 4) : [];
      got++;
    } catch (e) { console.warn("Cast: " + e.message); break; }
  }
  console.log(`Cast: ${got} titles updated`);
}

// ---- TMDB (only when TMDB_TOKEN is set): YouTube trailer for every title, sharper posters for ones without a manual poster.
if (TMDB) {
  const H = { accept: "application/json" };
  const q = (u) => { const url = new URL("https://api.themoviedb.org/3" + u); if (TMDB.length <= 40) url.searchParams.set("api_key", TMDB); else H.Authorization = "Bearer " + TMDB; return url; };
  const get = async (u) => { const r = await fetch(q(u), { headers: H }); if (!r.ok) throw new Error(`TMDB ${r.status}`); await sleep(30); return r.json(); };
  let tr = 0, po = 0;
  for (const f of lib.films.filter((x) => x.imdbId && (x.trailer === undefined || x.castP === undefined || x.dirP === undefined || (!x.posterLock && !String(x.poster || "").includes("image.tmdb.org"))))) {
    try {
      const j = await get(`/find/${f.imdbId}?external_source=imdb_id`);
      const hit = (j.movie_results || [])[0] ? { ...j.movie_results[0], kind: "movie" } : (j.tv_results || [])[0] ? { ...j.tv_results[0], kind: "tv" } : null;
      if (!hit) { if (f.trailer === undefined) f.trailer = null; continue; }
      f.tmdbId = hit.id;
      if (!f.posterLock && hit.poster_path) { f.poster = "https://image.tmdb.org/t/p/w500" + hit.poster_path; po++; }
      if (f.trailer === undefined) {
        const v = (await get(`/${hit.kind}/${hit.id}/videos?language=en-US`)).results || [];
        const yt = v.filter((x) => x.site === "YouTube");
        const best = yt.find((x) => x.type === "Trailer" && x.official) || yt.find((x) => x.type === "Trailer") || yt.find((x) => x.type === "Teaser") || null;
        f.trailer = best ? best.key : null;
        if (best) tr++;
      }
      const P = (x) => x.profile_path ? "https://image.tmdb.org/t/p/w185" + x.profile_path : null;
      const needCast = f.castP === undefined && !Array.isArray(fixes[f.id]?.cast);
      let credits = null;
      if (needCast || (f.dirP === undefined && hit.kind === "movie")) credits = await get(`/${hit.kind}/${hit.id}/credits?language=en-US`);
      if (needCast) {
        // Top-billed cast with photos; TMDB names replace OMDb ones so the same actor links up across titles.
        const c = (credits.cast || []).sort((a, b) => (a.order ?? 99) - (b.order ?? 99)).slice(0, 4);
        if (c.length) { f.cast = c.map((x) => x.name); f.castP = c.map(P); }
        else f.castP = [];
      }
      if (f.dirP === undefined) {
        // Director photos (films) or creator photos (series) — shown only on the person's filter banner.
        const people = hit.kind === "movie" ? (credits.crew || []).filter((x) => x.job === "Director") : ((await get(`/tv/${hit.id}?language=en-US`)).created_by || []);
        f.dirP = people.filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i).map((x) => ({ n: x.name, p: P(x) }));
      }
    } catch (e) { console.warn(`TMDB ${f.t}: ${e.message}`); if (/401/.test(e.message)) break; }
  }
  console.log(`TMDB: ${tr} trailers, ${po} posters, cast and director photos updated`);
} else console.log("TMDB_TOKEN not set — trailers use YouTube search links, posters come from OMDb.");

// ---- IMDb ratings from IMDb's own public dataset (refreshed daily by IMDb, free for personal use).
try {
  const want = new Set(lib.films.map((f) => f.imdbId).filter(Boolean));
  const res = await fetch("https://datasets.imdbws.com/title.ratings.tsv.gz");
  if (!res.ok) throw new Error("HTTP " + res.status);
  const { createGunzip } = await import("node:zlib");
  const { Readable } = await import("node:stream");
  const { createInterface } = await import("node:readline");
  const lines = createInterface({ input: Readable.fromWeb(res.body).pipe(createGunzip()) });
  const ratings = new Map();
  for await (const line of lines) {
    const tab = line.indexOf("\t");
    const id = line.slice(0, tab);
    if (want.has(id)) { const [, r, votes] = line.split("\t"); ratings.set(id, { r: parseFloat(r), votes: parseInt(votes) }); }
  }
  let n = 0;
  for (const f of lib.films) {
    const x = f.imdbId && ratings.get(f.imdbId);
    if (x && Number.isFinite(x.r)) { if (f.imdb !== x.r) n++; f.imdb = x.r; f.imdbVotes = x.votes; }
  }
  console.log(`IMDb ratings: ${ratings.size} found, ${n} updated`);
} catch (e) { console.warn("IMDb dataset unavailable: " + e.message); }

// ---- Letterboxd: direct film link and average rating, looked up by IMDb id.
// Polite: one request every 0.6 s, and only for films that don't have a rating yet (all of them on the monthly run).
{
  const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
  let got = 0, blocked = false;
  const todo = lib.films.filter((f) => f.imdbId && f.type !== "series" && (f.lb == null || !f.lbUrl || REFRESH));
  for (const f of todo) {
    try {
      const res = await fetch(`https://letterboxd.com/imdb/${f.imdbId}/`, { headers: { "user-agent": UA, accept: "text/html" }, redirect: "follow" });
      if (res.status === 403 || res.status === 429) { blocked = true; console.warn(`Letterboxd refused requests (HTTP ${res.status}) — stopping; ratings stay as they are.`); break; }
      if (!res.ok) continue;
      if (/letterboxd\.com\/film\//.test(res.url)) f.lbUrl = res.url;
      const html = await res.text();
      const m = html.match(/"ratingValue"\s*:\s*([\d.]+)/) || html.match(/name="twitter:data2" content="([\d.]+) out of 5"/);
      if (m) { f.lb = Math.round(parseFloat(m[1]) * 100) / 100; got++; }
    } catch (e) { console.warn(`Letterboxd ${f.t}: ${e.message}`); }
    await sleep(600);
  }
  console.log(`Letterboxd: ${got} ratings from ${todo.length} lookups${blocked ? " (stopped early)" : ""}`);
}

console.log(`OMDb requests: ${calls}`);
console.log(`With posters: ${lib.films.filter((f) => f.poster).length} of ${lib.films.length}`);
if (unsure.length) console.log("Director doesn't match — open these on the site and check the IMDb link:\n  " + unsure.join("\n  "));
if (missed.length) console.log("Check these on the site → open the film → Edit details (IMDb link or poster URL):\n  " + missed.join("\n  "));
// OMDb sometimes returns HTML entities ("O&apos;Brien") — turn them back into plain characters.
const unent = (x) => typeof x === "string" ? x.replace(/&(apos|#39|quot|amp|lt|gt);/g, (_, e) => ({ apos: "'", "#39": "'", quot: '"', amp: "&", lt: "<", gt: ">" })[e]) : x;
for (const f of lib.films) {
  for (const k of ["t", "d", "overview"]) if (typeof f[k] === "string") f[k] = unent(f[k]);
  if (Array.isArray(f.cast)) f.cast = f.cast.map(unent);
}
if (JSON.stringify(lib) !== before) { await fs.writeFile(FILE, JSON.stringify(lib, null, 1) + "\n"); console.log("Library updated."); }
else console.log("Nothing changed.");
