const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());

const BASE = "https://kkkkkkkkk-cmotakus-projects.vercel.app/api/";
const PROXY = "https://animepaheproxy.vercel.app/m3u8-proxy?url=";

const PORT = process.env.PORT || 3000;

const mappingCache = {};
const episodeCache = {};
const searchCache = {};
const anilistCache = {};

const AXIOS_CONFIG = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json,text/plain,*/*",
    Referer: "https://animepahe.pw/",
    Origin: "https://animepahe.pw",
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
        `Request failed attempt ${i + 1}/${retries + 1}:`,
        err.response?.status || err.message
      );

      if (i < retries) await sleep(2000);
    }
  }

  throw lastError;
}

async function fetchAniListInfo(anilistId) {
  if (anilistCache[anilistId]) return anilistCache[anilistId];

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

  anilistCache[anilistId] = info;
  return info;
}

async function searchAnimePahe(q) {
  const key = cleanTitle(q);

  if (searchCache[key]) return searchCache[key];

  const res = await safeFetch(`${BASE}/search?q=${encodeURIComponent(q)}`);
  const results = res.data?.data || [];

  searchCache[key] = results;
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
  if (mappingCache[anilistId]) return mappingCache[anilistId];

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

  if (!unique.length) throw new Error("AnimePahe result not found");

  const ranked = unique
    .map((item) => ({
      ...item,
      matchScore: scoreCandidate(item, anilist),
    }))
    .sort((a, b) => b.matchScore - a.matchScore);

  const best = ranked[0];

  mappingCache[anilistId] = {
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

  return mappingCache[anilistId];
}

async function loadAllEpisodes(session) {
  if (episodeCache[session]) return episodeCache[session];

  let page = 1;
  let allEpisodes = [];

  while (true) {
    const res = await safeFetch(
      `${BASE}/${session}/releases?sort=episode_desc&page=${page}`
    );

    const data = res.data?.data || [];

    if (!data.length) break;

    allEpisodes = [...allEpisodes, ...data];
    page++;

    if (page > 100) break;
  }

  episodeCache[session] = allEpisodes;
  return allEpisodes;
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

  // If API does not clearly mark audio, keep unknown in both instead of guessing wrong.
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
    message: "AnimePahe resolver running",
    endpoints: {
      search: "/search?q=dr%20stone",
      resolve: "/resolve?anilistId=199221",
      watch: "/watch?anilistId=199221&ep=1&audio=sub",
      stream: "/stream?session=SESSION_ID&ep=EPISODE_SESSION&audio=sub",
      allEpisodes: "/all-episodes?session=SESSION_ID",
    },
  });
});

app.get("/search", async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: "Query missing" });

    const results = await searchAnimePahe(q);

    res.json({
      query: q,
      results,
    });
  } catch (err) {
    res.status(500).json({
      error: "Search failed",
      reason: err.response?.data || err.message,
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
    res.json(resolved);
  } catch (err) {
    res.status(500).json({
      error: "Resolve failed",
      reason: err.response?.data || err.message,
    });
  }
});

app.get("/all-episodes", async (req, res) => {
  try {
    const session = req.query.session;
    if (!session) return res.status(400).json({ error: "Session missing" });

    const episodes = await loadAllEpisodes(session);
    res.json(episodes);
  } catch (err) {
    res.status(500).json({
      error: "All episodes failed",
      reason: err.response?.data || err.message,
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
      `${BASE}/play/${session}?episodeId=${ep}&downloads=false`
    );

    const sources = stream.data?.sources || [];

    if (!sources.length) {
      return res.json({ error: "No sources found" });
    }

    const built = buildStreams(sources);
    const preferred = pickPreferredStreams(built, audio);

    res.json({
      session,
      episodeSession: ep,
      audio: preferred.audio,
      streams: built,
      selected: preferred,
      sections: preferred.sections,
    });
  } catch (err) {
    res.status(500).json({
      error: "Stream failed",
      reason: err.response?.data || err.message,
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
        error: "No episodes found",
        resolved,
      });
    }

    const selectedEp = selectEpisode(episodes, ep || 1);

    if (!selectedEp) {
      return res.json({
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
      `${BASE}/play/${session}?episodeId=${selectedEp.session}&downloads=false`
    );

    const sources = stream.data?.sources || [];

    if (!sources.length) {
      return res.json({
        error: "No stream found",
        resolved,
        episode: selectedEp,
      });
    }

    const built = buildStreams(sources);
    const preferred = pickPreferredStreams(built, audio);

    res.json({
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
        allQualities: built.all.map((x) => ({
          quality: x.quality,
          audio: x.audio,
          url: x.rawUrl,
        })),
      },
    });
  } catch (err) {
    console.error("WATCH ERROR:", err.response?.data || err.message);

    res.status(500).json({
      error: "Watch failed",
      reason: err.response?.data || err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`🔥 AnimePahe API running on port ${PORT}`);
});
