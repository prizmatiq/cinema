// Fills posters, runtime, overview, IMDb id and IMDb rating for every film in data/library.json.
// Needs two repository secrets: TMDB_TOKEN (TMDB API key or read access token) and OMDB_KEY (optional, for IMDb ratings).
import fs from "node:fs/promises";

const FILE = new URL("../data/library.json", import.meta.url);
const TMDB = process.env.TMDB_TOKEN || "";
const OMDB = process.env.OMDB_KEY || "";
const REFRESH = process.env.REFRESH_RATINGS === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!TMDB) { console.log("TMDB_TOKEN is not set — nothing to do."); process.exit(0); }

async function tmdb(path, params = {}) {
  const url = new URL("https://api.themoviedb.org/3" + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  const headers = { accept: "application/json" };
  if (TMDB.length <= 40) url.searchParams.set("api_key", TMDB); else headers.Authorization = "Bearer " + TMDB;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`TMDB ${res.status} ${path}`);
  await sleep(60);
  return res.json();
}

async function findMovie(f) {
  const titles = [f.t, f.t.replace(/\s*\(.*?\)\s*/g, " ").trim()].filter((v, i, a) => v && a.indexOf(v) === i);
  for (const query of titles) {
    for (const params of [{ primary_release_year: f.y }, { year: f.y }, {}]) {
      const j = await tmdb("/search/movie", { query, include_adult: "false", ...params });
      const hits = j.results || [];
      if (!hits.length) continue;
      // Prefer the closest release year, then popularity.
      hits.sort((a, b) => {
        const ya = Math.abs((parseInt(a.release_date) || 0) - f.y), yb = Math.abs((parseInt(b.release_date) || 0) - f.y);
        return ya - yb || (b.popularity || 0) - (a.popularity || 0);
      });
      const best = hits[0];
      if (Math.abs((parseInt(best.release_date) || f.y) - f.y) <= 2) return best.id;
    }
  }
  return null;
}

async function omdbRating(imdbId) {
  if (!OMDB || !imdbId) return null;
  const res = await fetch(`https://www.omdbapi.com/?i=${imdbId}&apikey=${OMDB}`);
  if (!res.ok) return null;
  const j = await res.json();
  const v = parseFloat(j.imdbRating);
  return Number.isFinite(v) ? v : null;
}

const lib = JSON.parse(await fs.readFile(FILE, "utf8"));
let changed = 0, missed = [];
for (const f of lib.films) {
  try {
    if (!f.tmdbId) {
      const id = await findMovie(f);
      if (!id) { missed.push(`${f.t} (${f.y})`); continue; }
      f.tmdbId = id; changed++;
    }
    if (!f.poster || !f.imdbId || f.runtime == null) {
      const m = await tmdb(`/movie/${f.tmdbId}`, { append_to_response: "external_ids", language: "en-US" });
      f.poster = m.poster_path || null;
      f.runtime = m.runtime || null;
      f.overview = (m.overview || "").slice(0, 600) || null;
      f.imdbId = m.external_ids?.imdb_id || m.imdb_id || null;
      changed++;
    }
    if (f.imdbId && (f.imdb == null || REFRESH)) {
      const r = await omdbRating(f.imdbId);
      if (r != null && r !== f.imdb) { f.imdb = r; changed++; }
    }
  } catch (e) {
    console.warn(`Skipped ${f.t}: ${e.message}`);
  }
}
if (missed.length) console.log("Not found on TMDB:\n  " + missed.join("\n  "));
if (changed) {
  await fs.writeFile(FILE, JSON.stringify(lib, null, 1) + "\n");
  console.log(`Updated ${changed} fields.`);
} else console.log("Nothing changed.");
