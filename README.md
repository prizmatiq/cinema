# Grinn's Film Library

A personal film library: posters, genres, mood collections, my 5-star ratings, Letterboxd and IMDb scores.

- `index.html` — the whole app (GitHub Pages serves it).
- `data/library.json` — the library itself. The app writes here when you press **Save to GitHub**.
- `scripts/enrich.mjs` + `.github/workflows/enrich.yml` — fetch posters, runtime, synopsis and IMDb ratings after every change, and refresh ratings monthly.

Posters and metadata: [TMDB](https://www.themoviedb.org). This product uses the TMDB API but is not endorsed or certified by TMDB. IMDb ratings via [OMDb](https://www.omdbapi.com).
