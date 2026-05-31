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

const mappingCache = new Map();
const episodeCache = new Map();
const searchCache = new Map();
const anilistCache = new Map();

const AXIOS_CONFIG = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json,text/plain,*/*",
    Referer: "https://animepahe.ru/",
    Origin: "https://animepahe.ru",
  },
  timeout: 30000,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanTitle(str = "") {
  return String(str)
    .toLowerCase()
    .replace(/season\s*\d+/gi, "")
    .replace(/cour\s*\d+/gi, "")
    .replace(/part\s*\d+/gi, "")
    .replace(/[\W_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleIncludes(a = "", b = "") {
  const x = cleanTitle(a);
  const y = cleanTitle(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

async function safeFetch(url, retries = 2) {
  let lastError;

  for (let i = 0; i <= retries; i++) {
    try {
      return await axios.get(url, AXIOS_CONFIG);
    } catch (err) {
      lastError = err;
      console.log(
        `Request failed ${i + 1}/${retries + 1}:`,
        err.response?.status || err.message
      );

      if (i < retries) await sleep(1500);
    }
  }

  throw lastError;
}

async function fetchAniListInfo(anilistId) {
  if (anilistCache.has(String(anilistId))) {
    return anilistCache.get(String(anilistId));
  }

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
        season
        episodes
        format
        synonyms
      }
    }
  `;

  const res = await axios.post(
    "https://graphql.anilist.co",
    {
      query,
      variables: { id: Number(anilistId) },
    },
    {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 30000,
    }
  );

  const media = res.data?.data?.Media;
  if (!media) throw new Error("AniList anime not found");

  const info = {
    id: media.id,
    malId: media.idMal || null,
    romaji: media.title?.romaji || "",
    english: media.title?.english || "",
    native: media.title?.native || "",
    year: media.seasonYear || media.startDate?.year || null,
    episodes: media.episodes || null,
    format: media.format || "",
    season: media.season || "",
    synonyms: media.synonyms || [],
  };

  anilistCache.set(String(anilistId), info);
  return info;
}

async function searchAnimePahe(q) {
  const key = cleanTitle(q);

  if (searchCache.has(key)) {
    return searchCache.get(key);
  }

  const url = `${BASE}/search?q=${encodeURIComponent(q)}`;
  const res = await safeFetch(url);

  const results = res.data?.data || res.data?.results || [];

  searchCache.set(key, results);
  return results;
}

function scoreCandidate(candidate, anilist) {
  let score = 0;

  const titles = [
    anilist.romaji,
    anilist.english,
    anilist.native,
    ...(anilist.synonyms || []),
  ].filter(Boolean);

  for (const title of titles) {
    if (cleanTitle(candidate.title) === cleanTitle(title)) score += 100;
    else if (titleIncludes(candidate.title, title)) score += 55;
  }

  if (anilist.year && Number(candidate.year) === Number(anilist.year)) {
    score += 30;
  }

  if (
    anilist.episodes &&
    candidate.episodes &&
    Number(candidate.episodes) === Number(anilist.episodes)
  ) {
    score += 25;
  }

  const cTitle = cleanTitle(candidate.title);
  const fullTitle = cleanTitle(
    `${anilist.romaji} ${anilist.english} ${anilist.synonyms?.join(" ")}`
  );

  if (fullTitle.includes("season 2") && cTitle.includes("season 2")) score += 25;
  if (fullTitle.includes("season 3") && cTitle.includes("season 3")) score += 25;
  if (fullTitle.includes("season 4") && cTitle.includes("season 4")) score += 25;
  if (fullTitle.includes("part 2") && cTitle.includes("part 2")) score += 25;
  if (fullTitle.includes("part 3") && cTitle.includes("part 3")) score += 25;
  if (fullTitle.includes("cour 2") && cTitle.includes("cour 2")) score += 25;
  if (fullTitle.includes("cour 3") && cTitle.includes("cour 3")) score += 25;

  if (String(candidate.type || "").toLowerCase() === "tv") score += 5;

  return score;
}

async function resolveAnimePaheSession(anilistId) {
  const cacheKey = String(anilistId);

  if (mappingCache.has(cacheKey)) {
    return mappingCache.get(cacheKey);
  }

  const anilist = await fetchAniListInfo(anilistId);

  const queries = [
    anilist.english,
    anilist.romaji,
    ...(anilist.synonyms || []),
  ].filter(Boolean);

  let allResults = [];

  for (const q of queries) {
    try {
      const results = await searchAnimePahe(q);
      allResults.push(...results);
    } catch (err) {
      console.log("AnimePahe search failed:", q, err.message);
    }
  }

  const unique = [];
  const seen = new Set();

  for (const item of allResults) {
    if (!item?.session) continue;
    if (seen.has(item.session)) continue;

    seen.add(item.session);
    unique.push(item);
  }

  if (!unique.length) {
    throw new Error("AnimePahe result not found");
  }

  const ranked = unique
    .map((item) => ({
      ...item,
      matchScore: scoreCandidate(item, anilist),
    }))
    .sort((a, b) => b.matchScore - a.matchScore);

  const best = ranked[0];

  const resolved = {
    anilistId: Number(anilistId),
    malId: anilist.malId,
    session: best.session,
    title: best.title,
    animepaheId: best.id,
    score: best.matchScore,
    anilist,
    candidates: ranked.slice(0, 10).map((x) => ({
      title: x.title,
      session: x.session,
      year: x.year,
      episodes: x.episodes,
      type: x.type,
      score: x.matchScore,
    })),
  };

  mappingCache.set(cacheKey, resolved);
  return resolved;
}

async function loadAllEpisodes(session) {
  if (episodeCache.has(session)) {
    return episodeCache.get(session);
  }

  let page = 1;
  let allEpisodes = [];

  while (true) {
    const url = `${BASE}/${session}/releases?sort=episode_asc&page=${page}`;
    const res = await safeFetch(url);

    const episodes = res.data?.data || [];

    if (!episodes.length) break;

    allEpisodes.push(...episodes);

    const lastPage = Number(res.data?.last_page || res.data?.lastPage || 0);

    if (lastPage && page >= lastPage) break;

    page++;

    if (page > 150) break;
  }

  const normalized = allEpisodes
    .filter(Boolean)
    .sort((a, b) => Number(a.episode) - Number(b.episode));

  episodeCache.set(session, normalized);
  return normalized;
}

function detectQuality(source = {}) {
  const text = `${source.quality || ""} ${source.resolution || ""} ${
    source.label || ""
  } ${source.url || ""}`;

  const match = text.match(/(360|480|720|1080|2160)p?/i);
  return match ? `${match[1]}p` : "auto";
}

function detectAudio(source = {}) {
  const text = `${source.audio || ""} ${source.type || ""} ${
    source.language || ""
  } ${source.name || ""} ${source.label || ""} ${source.url || ""}`.toLowerCase();

  if (
    text.includes("eng") ||
    text.includes("english") ||
    text.includes("dub") ||
    text.includes("dubbed")
  ) {
    return "dub";
  }

  if (
    text.includes("jpn") ||
    text.includes("japanese") ||
    text.includes("sub") ||
    text.includes("subbed")
  ) {
    return "sub";
  }

  return "unknown";
}

function normalizeStream(source, index) {
  const quality = detectQuality(source);
  const audio = detectAudio(source);
  const rawUrl = source.url;

  return {
    id: `${quality}-${audio}-${index}`,
    quality,
    audio,
    label: `AnimePahe ${quality}`,
    rawUrl,
    url: PROXY + encodeURIComponent(rawUrl),
    original: source,
  };
}

function groupByQuality(streams = []) {
  const order = ["360p", "480p", "720p", "1080p", "2160p", "auto"];

  const grouped = {};

  for (const stream of streams) {
    if (!grouped[stream.quality]) grouped[stream.quality] = [];
    grouped[stream.quality].push(stream);
  }

  return order
    .filter((quality) => grouped[quality]?.length)
    .map((quality) => ({
      quality,
      label: `AnimePahe ${quality}`,
      streams: grouped[quality],
      defaultUrl: grouped[quality][0]?.url,
      rawUrl: grouped[quality][0]?.rawUrl,
    }));
}

function buildStreams(sources = []) {
  const normalized = sources
    .filter((s) => s?.url)
    .map((s, index) => normalizeStream(s, index));

  let sub = normalized.filter((s) => s.audio === "sub");
  let dub = normalized.filter((s) => s.audio === "dub");
  const unknown = normalized.filter((s) => s.audio === "unknown");

  if (!sub.length && unknown.length) sub = unknown;
  if (!dub.length && unknown.length) dub = unknown;

  return {
    sub,
    dub,
    all: normalized,
    sections: {
      sub: groupByQuality(sub),
      dub: groupByQuality(dub),
    },
  };
}

function pickPreferredStreams(streamsData, audio = "sub") {
  const safeAudio = audio === "dub" ? "dub" : "sub";

  return {
    audio: safeAudio,
    streams: streamsData[safeAudio] || [],
    sections: streamsData.sections?.[safeAudio] || [],
  };
}

function selectEpisode(episodes, requestedEp) {
  const sorted = [...episodes].sort(
    (a, b) => Number(a.episode) - Number(b.episode)
  );

  const direct = sorted.find(
    (e) => String(e.episode) === String(requestedEp)
  );

  if (direct) return direct;

  const firstEpisode = Number(sorted[0]?.episode || 1);
  const localEp = Number(requestedEp || 1);
  const actualEpisode = firstEpisode + localEp - 1;

  return sorted.find((e) => Number(e.episode) === actualEpisode);
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "AnimePahe resolver running",
    base: BASE,
    endpoints: {
      health: "/health",
      search: "/search?q=one%20piece",
      resolve: "/resolve?anilistId=21",
      allEpisodes: "/all-episodes?session=SESSION_ID",
      stream: "/stream?session=SESSION_ID&ep=EPISODE_SESSION&audio=sub",
      watch: "/watch?anilistId=21&ep=1&audio=sub",
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

    if (!q) {
      return res.status(400).json({
        status: "error",
        error: "Query missing",
      });
    }

    const results = await searchAnimePahe(q);

    res.json({
      status: "ok",
      query: q,
      results,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      error: "Search failed",
      reason: err.response?.data || err.message,
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

    const resolved = await resolveAnimePaheSession(anilistId);

    res.json({
      status: "ok",
      ...resolved,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      error: "Resolve failed",
      reason: err.response?.data || err.message,
    });
  }
});

app.get("/all-episodes", async (req, res) => {
  try {
    const session = String(req.query.session || "").trim();

    if (!session) {
      return res.status(400).json({
        status: "error",
        error: "Session missing",
      });
    }

    const episodes = await loadAllEpisodes(session);

    res.json({
      status: "ok",
      session,
      total: episodes.length,
      results: episodes,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      error: "All episodes failed",
      reason: err.response?.data || err.message,
    });
  }
});

app.get("/stream", async (req, res) => {
  try {
    const session = String(req.query.session || "").trim();
    const ep = String(req.query.ep || req.query.episodeId || "").trim();
    const audio = String(req.query.audio || req.query.lang || "sub").toLowerCase();

    if (!session || !ep) {
      return res.status(400).json({
        status: "error",
        error: "Session or episode missing",
      });
    }

    const url = `${BASE}/play/${session}?episodeId=${ep}&downloads=false`;
    const stream = await safeFetch(url);

    const sources = stream.data?.sources || [];

    if (!sources.length) {
      return res.json({
        status: "error",
        error: "No sources found",
        session,
        episodeSession: ep,
      });
    }

    const built = buildStreams(sources);
    const preferred = pickPreferredStreams(built, audio);

    res.json({
      status: "ok",
      session,
      episodeSession: ep,
      audio: preferred.audio,
      selected: preferred,
      sections: preferred.sections,
      streams: built,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      error: "Stream failed",
      reason: err.response?.data || err.message,
    });
  }
});

app.get("/watch", async (req, res) => {
  try {
    const anilistId = req.query.anilistId;
    const ep = req.query.ep || 1;
    const audio = String(req.query.audio || req.query.lang || "sub").toLowerCase();

    if (!anilistId) {
      return res.status(400).json({
        status: "error",
        error: "anilistId missing",
      });
    }

    const resolved = await resolveAnimePaheSession(anilistId);
    const session = resolved.session;

    const episodes = await loadAllEpisodes(session);

    if (!episodes.length) {
      return res.json({
        status: "error",
        error: "No episodes found",
        resolved,
      });
    }

    const selectedEp = selectEpisode(episodes, ep);

    if (!selectedEp) {
      return res.json({
        status: "error",
        error: "Episode not found",
        requestedEpisode: ep,
        resolved,
        availableEpisodes: episodes.map((e) => ({
          episode: e.episode,
          session: e.session,
          title: e.title,
        })),
      });
    }

    const url = `${BASE}/play/${session}?episodeId=${selectedEp.session}&downloads=false`;
    const stream = await safeFetch(url);

    const sources = stream.data?.sources || [];

    if (!sources.length) {
      return res.json({
        status: "error",
        error: "No stream found",
        resolved,
        episode: selectedEp,
      });
    }

    const built = buildStreams(sources);
    const preferred = pickPreferredStreams(built, audio);

    res.json({
      status: "ok",
      title: resolved.title,
      anilistId: Number(anilistId),
      malId: resolved.malId,
      session,
      animepaheId: resolved.animepaheId,
      matchScore: resolved.score,

      requestedEpisode: Number(ep),
      actualEpisode: selectedEp.episode,
      episodeSession: selectedEp.session,
      episode: selectedEp,

      audio: preferred.audio,
      selected: preferred,
      sections: preferred.sections,
      streams: built,

      debug: {
        totalEpisodes: episodes.length,
        totalSources: sources.length,
        subCount: built.sub.length,
        dubCount: built.dub.length,
      },
    });
  } catch (err) {
    console.error("WATCH ERROR:", err.response?.data || err.message);

    res.status(500).json({
      status: "error",
      error: "Watch failed",
      reason: err.response?.data || err.message,
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