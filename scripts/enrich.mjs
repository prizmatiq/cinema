// Fills posters, runtime, synopsis, IMDb id and IMDb rating for every film in data/library.json.
// Works with OMDB_KEY alone (omdbapi.com, email-only signup). TMDB_TOKEN is optional and gives better posters.
import fs from "node:fs/promises";

const FILE = new URL("../data/library.json", import.meta.url);
const TMDB = (process.env.TMDB_TOKEN || "").trim();
const OMDB = (process.env.OMDB_KEY || "").trim();
const REFRESH = process.env.REFRESH_RATINGS === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!TMDB && !OMDB) {
  console.error("No API keys found. Add OMDB_KEY (and optionally TMDB_TOKEN) in Settings → Secrets and variables → Actions.");
  process.exit(1);
}

async function omdb(params) {
  const url = new URL("https://www.omdbapi.com/");
  url.searchParams.set("apikey", OMDB);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  const res = await fetch(url);
  const j = await res.json().catch(() => ({}));
  if (j.Error && /invalid api key|not activated|limit/i.test(j.Error)) throw new Error("OMDb: " + j.Error);
  await sleep(40);
  return j.Response === "True" ? j : null;
}

async function tmdb(path, params = {}) {
  const url = new URL("https://api.themoviedb.org/3" + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  const headers = { accept: "application/json" };
  if (TMDB.length <= 40) url.searchParams.set("api_key", TMDB); else headers.Authorization = "Bearer " + TMDB;
  const res = await fetch(url, { headers });
  if (res.status === 401) throw new Error("TMDB rejected the key (401)");
  if (!res.ok) throw new Error(`TMDB ${res.status} ${path}`);
  await sleep(60);
  return res.json();
}

const yearOf = (s) => parseInt(String(s || "").slice(0, 4)) || 0;
const variants = (t) => [t, t.replace(/\s*\(.*?\)\s*/g, " ").trim(), t.replace("½", " 1/2")].filter((v, i, a) => v && a.indexOf(v) === i);

async function viaTmdb(f) {
  let id = f.tmdbId;
  if (!id) {
    outer: for (const query of variants(f.t)) {
      for (const p of [{ primary_release_year: f.y }, { year: f.y }, {}]) {
        const hits = ((await tmdb("/search/movie", { query, include_adult: "false", ...p })).results || [])
          .sort((a, b) => Math.abs(yearOf(a.release_date) - f.y) - Math.abs(yearOf(b.release_date) - f.y) || (b.popularity || 0) - (a.popularity || 0));
        if (hits[0] && Math.abs((yearOf(hits[0].release_date) || f.y) - f.y) <= 2) { id = hits[0].id; break outer; }
      }
    }
  }
  if (!id) return false;
  const m = await tmdb(`/movie/${id}`, { append_to_response: "external_ids", language: "en-US" });
  f.tmdbId = id;
  if (m.poster_path) f.poster = m.poster_path;
  f.runtime = f.runtime || m.runtime || null;
  f.overview = f.overview || (m.overview || "").slice(0, 600) || null;
  f.imdbId = f.imdbId || m.external_ids?.imdb_id || m.imdb_id || null;
  return true;
}

async function viaOmdb(f) {
  let m = f.imdbId ? await omdb({ i: f.imdbId, plot: "short" }) : null;
  if (!m) {
    for (const t of variants(f.t)) {
      for (const y of [f.y, f.y - 1, f.y + 1, ""]) {
        m = await omdb({ t, y, type: "movie", plot: "short" });
        if (m && (!y || Math.abs(yearOf(m.Year) - f.y) <= 1)) break;
        m = null;
      }
      if (m) break;
    }
  }
  if (!m) return false;
  f.imdbId = f.imdbId || m.imdbID || null;
  if (!f.poster && m.Poster && m.Poster !== "N/A") f.poster = m.Poster;
  if (!f.runtime && parseInt(m.Runtime)) f.runtime = parseInt(m.Runtime);
  if (!f.overview && m.Plot && m.Plot !== "N/A") f.overview = m.Plot;
  const r = parseFloat(m.imdbRating);
  if (Number.isFinite(r)) f.imdb = r;
  return true;
}

const lib = JSON.parse(await fs.readFile(FILE, "utf8"));
const before = JSON.stringify(lib);
const missed = [];
for (const f of lib.films) {
  const needMeta = !f.poster || !f.imdbId || f.runtime == null;
  const needRating = OMDB && (f.imdb == null || REFRESH);
  if (!needMeta && !needRating) continue;
  let found = false;
  if (TMDB && needMeta) found = await viaTmdb(f).catch((e) => { if (/401/.test(e.message)) throw e; console.warn(`${f.t}: ${e.message}`); return false; });
  if (OMDB) found = (await viaOmdb(f)) || found;
  if (!found) missed.push(`${f.t} (${f.y})`);
}
const withPoster = lib.films.filter((f) => f.poster).length;
console.log(`Films with posters: ${withPoster} of ${lib.films.length}`);
if (missed.length) console.log("Not found:\n  " + missed.join("\n  "));
if (JSON.stringify(lib) !== before) { await fs.writeFile(FILE, JSON.stringify(lib, null, 1) + "\n"); console.log("Library updated."); }
else console.log("Nothing changed.");
