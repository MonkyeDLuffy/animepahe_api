const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const BASE =
  process.env.BASE_API_URL ||
  "https://kkkkkkkkk-cmotakus-projects.vercel.app/api";
const PROXY =
  process.env.M3U8_PROXY_URL ||
  "https://animepaheproxy.vercel.app/m3u8-proxy?url=";

const PORT = process.env.PORT || 3000;

const CACHE_TTL = {
  SEARCH: 1000 * 60 * 15,
  MAPPING: 1000 * 60 * 60 * 12,
  EPISODES: 1000 * 60 * 30,
  ANILIST: 1000 * 60 * 60 * 6,
  STREAM: 1000 * 60 * 10,
};

const cacheStore = new Map();
const inflight = new Map();

const http = axios.create({
  timeout: 30000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/json,text/plain,*/*",
    Referer: "https://animepahe.pw/",
    Origin: "https://animepahe.pw",
  },
  validateStatus: () => true,
});

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

function setCache(key, value, ttl) {
  cacheStore.set(key, {
    value,
    expiresAt: Date.now() + ttl,
  });
}

function getCache(key) {
  const item = cacheStore.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    cacheStore.delete(key);
    return null;
  }
  return item.value;
}

function withInflight(key, factory) {
  if (inflight.has(key)) return inflight.get(key);

  const promise = Promise.resolve()
    .then(factory)
    .finally(() => inflight.delete(key));

  inflight.set(key, promise);
  return promise;
}

function isHtmlResponse(response) {
  const contentType = String(response?.headers?.["content-type"] || "").toLowerCase();
  const text =
    typeof response?.data === "string"
      ? response.data.slice(0, 600).toLowerCase()
      : "";

  return (
    contentType.includes("text/html") ||
    text.includes("<html") ||
    text.includes("<!doctype html") ||
    text.includes("vercel authentication") ||
    text.includes("deployment protection")
  );
}

function normalizeBaseUrl(url = "") {
  return String(url).replace(/\/+$/, "");
}

async function safeFetch(url, retries = 2) {
  let lastError;

  for (let i = 0; i <= retries; i++) {
    try {
      const response = await http.get(url);

      if (response.status >= 500) {
        throw new Error(`Upstream error ${response.status}`);
      }

      if (isHtmlResponse(response)) {
        throw new Error(
          "Upstream returned HTML instead of JSON. The BASE API is likely protected or no longer public."
        );
      }

      if (response.status >= 400) {
        throw new Error(`Upstream request failed with ${response.status}`);
      }

      return response;
    } catch (err) {
      lastError = err;
      console.log(
        `Request failed attempt ${i + 1}/${retries + 1}:`,
        err?.response?.status || err.message
      );

      if (i < retries) await sleep(1200 * (i + 1));
    }
  }

  throw lastError;
}

async function fetchAniListInfo(anilistId) {
  const key = `anilist:${anilistId}`;
  const cached = getCache(key);
  if (cached) return cached;

  return withInflight(key, async () => {
    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          id
          title {
            romaji
            english
            native
          }
          startDate {
            year
          }
          season
          seasonYear
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
      romaji: media.title?.romaji || "",
      english: media.title?.english || "",
      native: media.title?.native || "",
      year: media.seasonYear || media.startDate?.year || null,
      episodes: media.episodes || null,
      format: media.format || "",
      season: media.season || "",
      synonyms: media.synonyms || [],
    };

    setCache(key, info, CACHE_TTL.ANILIST);
    return info;
  });
}

async function searchAnimePahe(q) {
  const key = `search:${cleanTitle(q)}`;
  const cached = getCache(key);
  if (cached) return cached;

  return withInflight(key, async () => {
    const url = `${normalizeBaseUrl(BASE)}/search?q=${encodeURIComponent(q)}`;
    const res = await safeFetch(url);
    const results = Array.isArray(res.data?.data) ? res.data.data : [];

    setCache(key, results, CACHE_TTL.SEARCH);
    return results;
  });
}

function scoreCandidate(candidate, anilist) {
  let score = 0;

  const titles = [
    anilist.romaji,
    anilist.english,
    anilist.native,
    ...(anilist.synonyms || []),
  ].filter(Boolean);

  for (const t of titles) {
    if (cleanTitle(candidate.title) === cleanTitle(t)) score += 100;
    else if (titleIncludes(candidate.title, t)) score += 55;
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
  const fullTitle = cleanTitle(`${anilist.romaji} ${anilist.english}`);

  if (fullTitle.includes("season 4") && cTitle.includes("season 4")) score += 40;
  if (fullTitle.includes("cour 3") && cTitle.includes("cour 3")) score += 40;
  if (fullTitle.includes("part 3") && cTitle.includes("part 3")) score += 40;

  if (String(candidate.type || "").toLowerCase() === "tv") score += 5;

  return score;
}

async function resolveAnimePaheSession(anilistId) {
  const key = `mapping:${anilistId}`;
  const cached = getCache(key);
  if (cached) return cached;

  return withInflight(key, async () => {
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
        console.log("Search failed:", q, err.message);
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
      throw new Error(
        "No matching results found. Upstream may be broken, protected, or returning incomplete data."
      );
    }

    const ranked = unique
      .map((item) => ({
        ...item,
        matchScore: scoreCandidate(item, anilist),
      }))
      .sort((a, b) => b.matchScore - a.matchScore);

    const best = ranked[0];

    const result = {
      anilistId,
      session: best.session,
      title: best.title,
      animepaheId: best.id,
      score: best.matchScore,
      anilist,
      candidates: ranked.slice(0, 8).map((x) => ({
        title: x.title,
        session: x.session,
        year: x.year,
        episodes: x.episodes,
        score: x.matchScore,
      })),
    };

    setCache(key, result, CACHE_TTL.MAPPING);
    return result;
  });
}

async function loadAllEpisodes(session) {
  const key = `episodes:${session}`;
  const cached = getCache(key);
  if (cached) return cached;

  return withInflight(key, async () => {
    let page = 1;
    let allEpisodes = [];

    while (true) {
      const res = await safeFetch(
        `${normalizeBaseUrl(BASE)}/${session}/releases?sort=episode_desc&page=${page}`
      );

      const data = Array.isArray(res.data?.data) ? res.data.data : [];

      if (!data.length) break;

      allEpisodes = [...allEpisodes, ...data];
      page++;

      if (page > 100) break;
      await sleep(250);
    }

    setCache(key, allEpisodes, CACHE_TTL.EPISODES);
    return allEpisodes;
  });
}

function detectQuality(source = {}) {
  const text = `${source.quality || ""} ${source.resolution || ""} ${source.label || ""} ${source.url || ""}`;
  const match = text.match(/(360|480|720|1080|2160)p?/i);
  if (match) return `${match[1]}p`;
  return "auto";
}

function detectAudio(source = {}) {
  const text = `${source.audio || ""} ${source.type || ""} ${source.language || ""} ${source.name || ""} ${source.label || ""} ${source.url || ""}`.toLowerCase();

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

  return {
    id: `${quality}-${audio}-${index}`,
    quality,
    audio,
    label: `Kiwi-Stream-${quality}`,
    rawUrl: source.url,
    url: PROXY + encodeURIComponent(source.url),
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
      label: `Kiwi-Stream-${quality}`,
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
    sections: {
      sub: groupByQuality(sub),
      dub: groupByQuality(dub),
    },
    all: normalized,
  };
}

function pickPreferredStreams(streamsData, audio = "sub") {
  const safeAudio = audio === "dub" ? "dub" : "sub";
  const preferred = streamsData[safeAudio] || [];

  return {
    audio: safeAudio,
    streams: preferred,
    sections: streamsData.sections?.[safeAudio] || [],
  };
}

function selectEpisode(episodes, requestedEp) {
  const sortedEpisodes = [...episodes].sort(
    (a, b) => Number(a.episode) - Number(b.episode)
  );

  const direct = sortedEpisodes.find(
    (e) => String(e.episode) === String(requestedEp)
  );

  if (direct) return direct;

  const firstEpisode = Number(sortedEpisodes[0]?.episode || 1);
  const localEp = Number(requestedEp || 1);
  const actualEpisode = firstEpisode + localEp - 1;

  return sortedEpisodes.find((e) => Number(e.episode) === actualEpisode);
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Resolver API running",
    base: normalizeBaseUrl(BASE),
    endpoints: {
      health: "/health",
      debugUpstream: "/debug/upstream",
      search: "/search?q=dr%20stone",
      resolve: "/resolve?anilistId=199221",
      watch: "/watch?anilistId=199221&ep=1&audio=sub",
      stream: "/stream?session=SESSION_ID&ep=EPISODE_SESSION&audio=sub",
      allEpisodes: "/all-episodes?session=SESSION_ID",
    },
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    cacheEntries: cacheStore.size,
    inflightRequests: inflight.size,
    base: normalizeBaseUrl(BASE),
    timestamp: Date.now(),
  });
});

app.get("/debug/upstream", async (req, res) => {
  try {
    const url = `${normalizeBaseUrl(BASE)}/search?q=naruto`;
    const response = await http.get(url);

    res.json({
      status: "ok",
      upstream: normalizeBaseUrl(BASE),
      httpStatus: response.status,
      contentType: response.headers?.["content-type"] || null,
      isHtml: isHtmlResponse(response),
      preview:
        typeof response.data === "string"
          ? response.data.slice(0, 500)
          : response.data,
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      error: "Upstream debug failed",
      reason: error.message,
    });
  }
});

app.get("/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Query missing" });

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
      reason: err.message,
    });
  }
});

app.get("/resolve", async (req, res) => {
  try {
    const { anilistId } = req.query;

    if (!anilistId) {
      return res.status(400).json({ error: "anilistId missing" });
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
      reason: err.message,
    });
  }
});

app.get("/all-episodes", async (req, res) => {
  try {
    const session = String(req.query.session || "").trim();
    if (!session) return res.status(400).json({ error: "Session missing" });

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
      reason: err.message,
    });
  }
});

app.get("/stream", async (req, res) => {
  try {
    const { session, ep } = req.query;
    const audio = String(req.query.audio || req.query.lang || "sub").toLowerCase();

    if (!session || !ep) {
      return res.status(400).json({ error: "Session or episode missing" });
    }

    const stream = await safeFetch(
      `${normalizeBaseUrl(BASE)}/play/${session}?episodeId=${ep}&downloads=false`
    );

    const sources = Array.isArray(stream.data?.sources) ? stream.data.sources : [];

    if (!sources.length) {
      return res.json({
        status: "ok",
        session,
        episodeSession: ep,
        error: "No sources found",
      });
    }

    const built = buildStreams(sources);
    const preferred = pickPreferredStreams(built, audio);

    res.json({
      status: "ok",
      session,
      episodeSession: ep,
      audio: preferred.audio,
      streams: built,
      selected: preferred,
      sections: preferred.sections,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      error: "Stream failed",
      reason: err.message,
    });
  }
});

app.get("/watch", async (req, res) => {
  try {
    const { anilistId, ep } = req.query;
    const audio = String(req.query.audio || req.query.lang || "sub").toLowerCase();

    if (!anilistId) {
      return res.status(400).json({ error: "anilistId missing" });
    }

    const resolved = await resolveAnimePaheSession(anilistId);
    const session = resolved.session;

    const episodes = await loadAllEpisodes(session);

    if (!episodes.length) {
      return res.json({
        status: "ok",
        error: "No episodes found",
        resolved,
      });
    }

    const selectedEp = selectEpisode(episodes, ep || 1);

    if (!selectedEp) {
      return res.json({
        status: "ok",
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

    const stream = await safeFetch(
      `${normalizeBaseUrl(BASE)}/play/${session}?episodeId=${selectedEp.session}&downloads=false`
    );

    const sources = Array.isArray(stream.data?.sources) ? stream.data.sources : [];

    if (!sources.length) {
      return res.json({
        status: "ok",
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
      anilistId,
      session,
      animepaheId: resolved.animepaheId,
      matchScore: resolved.score,
      requestedEpisode: ep || 1,
      actualEpisode: selectedEp.episode,
      episodeSession: selectedEp.session,
      audio: preferred.audio,
      sections: preferred.sections,
      selected: preferred,
      streams: built,
      debug: {
        totalSources: sources.length,
        subCount: built.sub.length,
        dubCount: built.dub.length,
        upstreamBase: normalizeBaseUrl(BASE),
      },
    });
  } catch (err) {
    console.error("WATCH ERROR:", err.message);

    res.status(500).json({
      status: "error",
      error: "Watch failed",
      reason: err.message,
    });
  }
});

if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log(`🔥 Resolver API running on port ${PORT}`);
  });
}
