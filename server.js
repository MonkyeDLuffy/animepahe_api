const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const BASE =
  process.env.ANIMEPAHE_BASE_API ||
  "https://kkkkkkkkk-cmotakus-projects.vercel.app/api";

const PROXY =
  process.env.M3U8_PROXY ||
  "https://animepaheproxy.vercel.app/m3u8-proxy?url=";

const cache = new Map();

const AXIOS_CONFIG = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    Accept: "application/json,text/plain,*/*",
  },
  timeout: 25000,
};

function setCache(key, data, ttl = 1000 * 60 * 60) {
  cache.set(key, { data, expire: Date.now() + ttl });
}

function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expire) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

async function safeFetch(url) {
  const res = await axios.get(url, AXIOS_CONFIG);
  return res.data;
}

async function anilistInfo(anilistId) {
  const key = `anilist:${anilistId}`;
  const cached = getCache(key);
  if (cached) return cached;

  const query = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id
        idMal
        title {
          romaji
          english
          native
        }
        startDate {
          year
        }
        seasonYear
        episodes
        format
        synonyms
      }
    }
  `;

  const res = await axios.post(
    "https://graphql.anilist.co",
    { query, variables: { id: Number(anilistId) } },
    { timeout: 25000 }
  );

  const m = res.data?.data?.Media;

  const data = {
    id: m.id,
    malId: m.idMal,
    title: m.title?.english || m.title?.romaji || m.title?.native,
    titles: [
      m.title?.english,
      m.title?.romaji,
      m.title?.native,
      ...(m.synonyms || []),
    ].filter(Boolean),
    year: m.seasonYear || m.startDate?.year,
    episodes: m.episodes,
    format: m.format,
  };

  setCache(key, data, 1000 * 60 * 60 * 24);
  return data;
}

function cleanTitle(text = "") {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreAnime(item, info) {
  let score = 0;
  const itemTitle = cleanTitle(item.title);

  for (const t of info.titles) {
    const title = cleanTitle(t);

    if (itemTitle === title) score += 100;
    else if (itemTitle.includes(title) || title.includes(itemTitle)) score += 50;
  }

  if (info.year && Number(item.year) === Number(info.year)) score += 30;

  if (String(item.type).toLowerCase() === String(info.format).toLowerCase()) {
    score += 10;
  }

  return score;
}

async function searchAnime(q) {
  const key = `search:${cleanTitle(q)}`;
  const cached = getCache(key);
  if (cached) return cached;

  const data = await safeFetch(`${BASE}/search?q=${encodeURIComponent(q)}`);
  const results = data?.results || data?.data || [];

  setCache(key, results, 1000 * 60 * 60 * 24);
  return results;
}

async function resolveAnime(anilistId) {
  const key = `resolve:${anilistId}`;
  const cached = getCache(key);
  if (cached) return cached;

  const info = await anilistInfo(anilistId);

  let all = [];

  for (const title of info.titles) {
    try {
      const results = await searchAnime(title);
      all.push(...results);
    } catch {}
  }

  const unique = [];
  const seen = new Set();

  for (const item of all) {
    if (!item?.session) continue;
    if (seen.has(item.session)) continue;
    seen.add(item.session);
    unique.push(item);
  }

  const ranked = unique
    .map((item) => ({
      ...item,
      matchScore: scoreAnime(item, info),
    }))
    .sort((a, b) => b.matchScore - a.matchScore);

  if (!ranked.length) throw new Error("AnimePahe result not found");

  const best = ranked[0];

  const resolved = {
    anilistId: Number(anilistId),
    malId: info.malId,
    title: best.title,
    animeSession: best.session,
    animepaheId: best.id,
    score: best.matchScore,
    candidates: ranked.slice(0, 10),
  };

  setCache(key, resolved, 1000 * 60 * 60 * 24 * 7);
  return resolved;
}

async function getReleasesPage(session, page = 1) {
  const key = `releases:${session}:${page}`;
  const cached = getCache(key);
  if (cached) return cached;

  const data = await safeFetch(
    `${BASE}/${session}/releases?sort=episode_asc&page=${page}`
  );

  setCache(key, data, 1000 * 60 * 60 * 12);
  return data;
}

async function findEpisode(session, epNumber) {
  const target = Number(epNumber || 1);

  for (let page = 1; page <= 150; page++) {
    const data = await getReleasesPage(session, page);

    const list = data?.data || data?.results || [];

    const found = list.find(
      (ep) => Number(ep.episode) === target || String(ep.episode) === String(target)
    );

    if (found) return found;

    const lastPage = Number(data?.last_page || data?.lastPage || data?.pagination?.lastPage || 0);

    if (lastPage && page >= lastPage) break;
    if (!list.length) break;
  }

  return null;
}

function normalizePlayResponse(data) {
  const root = data?.data || data || {};

  const embed =
    root.embed ||
    root.embedUrl ||
    root.iframe ||
    root.player ||
    root.url ||
    root.link ||
    null;

  const download =
    root.download ||
    root.downloadUrl ||
    root.download_link ||
    root.downloads ||
    root.downloadLinks ||
    null;

  const sources = root.sources || root.videos || root.streams || [];

  const proxiedSources = Array.isArray(sources)
    ? sources.map((s, i) => {
        const raw = s.url || s.file || s.link;
        return {
          id: i + 1,
          ...s,
          rawUrl: raw,
          url: raw?.includes(".m3u8") ? PROXY + encodeURIComponent(raw) : raw,
        };
      })
    : [];

  return {
    raw: data,
    embed,
    download,
    sources: proxiedSources,
  };
}

async function getPlay(animeSession, episodeSession) {
  const key = `play:${animeSession}:${episodeSession}`;
  const cached = getCache(key);
  if (cached) return cached;

  const data = await safeFetch(
    `${BASE}/play/${animeSession}?episodeId=${episodeSession}&downloads=true`
  );

  const normalized = normalizePlayResponse(data);

  setCache(key, normalized, 1000 * 60 * 60 * 2);
  return normalized;
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "AnimePahe resolver running",
    base: BASE,
    endpoints: {
      health: "/health",
      search: "/search?q=one%20piece",
      releases: "/:session/releases?page=1",
      resolve: "/resolve?anilistId=21",
      watch: "/watch?anilistId=21&ep=1",
      play: "/play?animeSession=xxx&episodeSession=yyy",
    },
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    time: Date.now(),
  });
});

app.get("/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ status: "error", error: "q missing" });

    const results = await searchAnime(q);

    res.json({
      status: "ok",
      query: q,
      results,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      error: "Search failed",
      reason: err.message,
    });
  }
});

app.get("/resolve", async (req, res) => {
  try {
    const anilistId = req.query.anilistId;
    if (!anilistId) {
      return res.status(400).json({
        status: "error",
        error: "anilistId missing",
      });
    }

    const resolved = await resolveAnime(anilistId);
    res.json({ status: "ok", ...resolved });
  } catch (err) {
    res.status(500).json({
      status: "error",
      error: "Resolve failed",
      reason: err.message,
    });
  }
});

app.get("/play", async (req, res) => {
  try {
    const animeSession = String(req.query.animeSession || "").trim();
    const episodeSession = String(req.query.episodeSession || "").trim();

    if (!animeSession || !episodeSession) {
      return res.status(400).json({
        status: "error",
        error: "animeSession and episodeSession required",
      });
    }

    const play = await getPlay(animeSession, episodeSession);

    res.json({
      status: "ok",
      animeSession,
      episodeSession,
      ...play,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      error: "Play failed",
      reason: err.message,
    });
  }
});

app.get("/watch", async (req, res) => {
  try {
    const anilistId = req.query.anilistId;
    const ep = Number(req.query.ep || 1);

    if (!anilistId) {
      return res.status(400).json({
        status: "error",
        error: "anilistId missing",
      });
    }

    const resolved = await resolveAnime(anilistId);

    const episode = await findEpisode(resolved.animeSession, ep);

    if (!episode) {
      return res.json({
        status: "error",
        error: "Episode not found",
        requestedEpisode: ep,
        resolved,
      });
    }

    const play = await getPlay(resolved.animeSession, episode.session);

    res.json({
      status: "ok",
      title: resolved.title,
      anilistId: Number(anilistId),
      malId: resolved.malId,

      animeSession: resolved.animeSession,
      episodeNumber: ep,
      episodeSession: episode.session,
      episode,

      embed: play.embed,
      download: play.download,
      sources: play.sources,
      raw: play.raw,

      resolved,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      error: "Watch failed",
      reason: err.message,
    });
  }
});

/* IMPORTANT: this must stay near bottom */
app.get("/:session/releases", async (req, res) => {
  try {
    const session = String(req.params.session || "").trim();
    const page = Number(req.query.page || 1);

    if (!session) {
      return res.status(400).json({
        status: "error",
        error: "session missing",
      });
    }

    const data = await getReleasesPage(session, page);

    res.json({
      status: "ok",
      session,
      page,
      ...data,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      error: "Releases failed",
      reason: err.message,
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    status: "error",
    error: "Route not found",
    path: req.path,
  });
});

app.listen(PORT, () => {
  console.log(`🔥 AnimePahe API running on port ${PORT}`);
});
