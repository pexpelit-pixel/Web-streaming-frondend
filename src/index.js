// worker.js – XStreaming (Netflix-style + API Proxy + Upload + SEO)
// Binding: DOOD_API (text), DOOD_KEY (secret), METADATA (KV optional)

const corsHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
};

const SEARCH_MAX_PAGES = 5;
const SEARCH_PER_PAGE = 100;
const SEARCH_RESULT_LIMIT = 250;
const SEARCH_CACHE_TTL = 600;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: corsHeaders,
  });
}

function escapeHtml(str = "") {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeRegExp(str = "") {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  return [v];
}

function extractFolders(data) {
  return (
    data?.result?.folders ||
    data?.result?.data ||
    data?.folders ||
    data?.result ||
    []
  );
}

function extractFiles(data) {
  const r = data?.result;
  if (Array.isArray(r?.files)) return r.files;
  if (Array.isArray(r?.data)) return r.data;
  if (Array.isArray(data?.files)) return data.files;
  if (Array.isArray(data?.result)) return data.result;
  if (r && typeof r === "object" && (r.file_code || r.title)) return [r];
  return [];
}

function pickUploadUrl(serverRes) {
  return (
    serverRes?.result?.url ||
    serverRes?.result?.upload_url ||
    serverRes?.result ||
    serverRes?.upload_url ||
    serverRes?.url ||
    ""
  );
}

function parseTags(tags = "") {
  if (Array.isArray(tags)) {
    return [...new Set(tags.map(t => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 12);
  }
  return [...new Set(
    String(tags)
      .split(/[,;\n]+/g)
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  )].slice(0, 12);
}

function normalizeText(str = "") {
  return String(str)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a = "", b = "") {
  a = normalizeText(a);
  b = normalizeText(b);

  if (!a) return b.length;
  if (!b) return a.length;

  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    const ac = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[m][n];
}

function similarity(a = "", b = "") {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  const maxLen = Math.max(na.length, nb.length);
  if (!maxLen) return 0;
  const dist = levenshtein(na, nb);
  return Math.max(0, 1 - dist / maxLen);
}

function highlightHtml(text = "", query = "") {
  const safe = escapeHtml(text);
  const q = normalizeText(query);
  if (!q) return safe;

  const tokens = [...new Set(q.split(" ").filter(Boolean))].filter(t => t.length > 1);
  if (!tokens.length) return safe;

  let out = safe;
  for (const token of tokens.sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(${escapeRegExp(token)})`, "ig");
    out = out.replace(re, '<mark class="kw">$1</mark>');
  }
  return out;
}

function renderTags(tags = [], query = "") {
  if (!Array.isArray(tags) || !tags.length) return "";
  return `<div class="tags">${tags
    .slice(0, 6)
    .map(t => `<span class="tag">#${highlightHtml(t, query)}</span>`)
    .join("")}</div>`;
}

function dedupeByFileCode(list = []) {
  const map = new Map();
  for (const item of list) {
    const key = item?.file_code || item?.filecode || item?.id || JSON.stringify(item);
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}

function extractFileCodeFromUploadResponse(data) {
  return (
    data?.result?.file_code ||
    data?.result?.filecode ||
    data?.file_code ||
    data?.filecode ||
    data?.result?.[0]?.file_code ||
    data?.result?.[0]?.filecode ||
    ""
  );
}

function slugify(str = "") {
  return String(str)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function doodFetch(env, path, params = {}) {
  const base = env.DOOD_API || "https://doodapi.co";
  const url = new URL(path, base);

  if (env.DOOD_KEY) url.searchParams.set("key", env.DOOD_KEY);

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v) !== "") {
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "application/json,text/plain,*/*",
    },
  });

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: "Invalid JSON from upstream", raw: text, status: res.status };
  }
}

async function doodPost(env, path, body = {}) {
  const base = env.DOOD_API || "https://doodapi.co";
  const url = new URL(path, base);

  if (env.DOOD_KEY) url.searchParams.set("key", env.DOOD_KEY);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0",
      accept: "application/json,text/plain,*/*",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: "Invalid JSON from upstream", raw: text, status: res.status };
  }
}

async function getMeta(env, fileCode) {
  if (!env.METADATA || !fileCode) return null;
  try {
    return await env.METADATA.get(`meta:${fileCode}`, { type: "json" });
  } catch {
    return null;
  }
}

async function saveMeta(env, fileCode, payload) {
  if (!env.METADATA || !fileCode) return false;
  try {
    await env.METADATA.put(`meta:${fileCode}`, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

async function getSearchCache(env, key) {
  if (!env.METADATA) return null;
  try {
    return await env.METADATA.get(key, { type: "json" });
  } catch {
    return null;
  }
}

async function setSearchCache(env, key, payload) {
  if (!env.METADATA) return false;
  try {
    await env.METADATA.put(key, JSON.stringify(payload), {
      expirationTtl: SEARCH_CACHE_TTL,
    });
    return true;
  } catch {
    return false;
  }
}

async function enrichVideos(env, videos = [], folderMap = new Map()) {
  if (!Array.isArray(videos) || !videos.length) return [];
  if (!env.METADATA) {
    return videos.map(v => ({
      ...v,
      __folderName: folderMap.get(String(v.fld_id || "0")) || "",
      __meta: null,
    }));
  }

  return Promise.all(
    videos.map(async (v) => {
      const meta = await getMeta(env, v.file_code);
      return {
        ...v,
        __meta: meta,
        __folderName: folderMap.get(String(v.fld_id || "0")) || "",
      };
    })
  );
}

function hotScore(video) {
  const now = Date.now();

  const uploadedAt =
    new Date(
      video.uploaded ||
      video.upload_date ||
      video.created_at ||
      video.created ||
      video.date ||
      now
    ).getTime() || now;

  const ageHours = Math.max(1, (now - uploadedAt) / 3600000);
  const views = Math.max(0, parseInt(video.views || "0", 10) || 0);

  const freshnessBoost = Math.max(0, 96 - ageHours) / 96;
  const viewsBoost = Math.min(1, Math.log10(views + 1) / 6);
  const randomBoost = Math.random() * 0.08;

  return freshnessBoost * 0.62 + viewsBoost * 0.20 + randomBoost;
}

async function buildRecommendations(env, currentVideo, limit = 18) {
  const pages = [1, 2, 3];

  const [foldersRes, ...listPages] = await Promise.all([
    doodFetch(env, "/api/folder/list", { only_folders: "1" }),
    ...pages.map(page =>
      doodFetch(env, "/api/file/list", {
        page: String(page),
        per_page: "100",
      })
    ),
  ]);

  const folders = extractFolders(foldersRes);
  const folderMap = new Map();
  folders.forEach(f => folderMap.set(String(f.fld_id), f.name));

  const files = dedupeByFileCode(listPages.flatMap(extractFiles));
  const enriched = await enrichVideos(env, files, folderMap);

  const currentTitle = currentVideo?.title || "";
  const currentFolder = String(currentVideo?.fld_id || "0");
  const currentTags = Array.isArray(currentVideo?.__meta?.tags) ? currentVideo.__meta.tags : [];

  const ranked = enriched
    .filter(v => String(v.file_code || "") !== String(currentVideo.file_code || ""))
    .map(v => {
      let score = 0;

      score += scoreVideo(currentTitle, v) * 0.58;

      if (String(v.fld_id || "0") === currentFolder) {
        score += 0.20;
      }

      const tags = Array.isArray(v.__meta?.tags) ? v.__meta.tags : [];
      const overlap = tags.filter(t => currentTags.includes(t)).length;
      score += overlap * 0.16;

      score += hotScore(v);

      return { video: v, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.video);

  return ranked;
}

function scoreVideo(query, video) {
  const q = normalizeText(query);
  if (!q) return 0;

  const meta = video.__meta || {};
  const folderName = normalizeText(video.__folderName || "");
  const title = normalizeText(video.title || "");
  const desc = normalizeText(meta.description || "");
  const tags = normalizeText(Array.isArray(meta.tags) ? meta.tags.join(" ") : meta.tags || "");
  const code = normalizeText(video.file_code || "");
  const blob = [title, folderName, tags, desc, code].filter(Boolean).join(" ");

  if (!blob) return 0;

  let score = 0;

  if (title === q) score += 1.40;
  if (title.includes(q)) score += 0.65;
  if (tags && tags.includes(q)) score += 0.38;
  if (folderName && folderName.includes(q)) score += 0.26;
  if (desc && desc.includes(q)) score += 0.12;
  if (blob === q) score += 0.90;

  const qTokens = q.split(" ").filter(Boolean);
  const titleTokens = new Set(title.split(" ").filter(Boolean));
  const folderTokens = new Set(folderName.split(" ").filter(Boolean));
  const tagTokens = new Set(tags.split(" ").filter(Boolean));
  const descTokens = new Set(desc.split(" ").filter(Boolean));
  const blobTokens = new Set(blob.split(" ").filter(Boolean));

  let hitTitle = 0;
  let hitFolder = 0;
  let hitTags = 0;
  let hitDesc = 0;
  let hitAny = 0;

  for (const t of qTokens) {
    if (titleTokens.has(t)) hitTitle++;
    if (folderTokens.has(t)) hitFolder++;
    if (tagTokens.has(t)) hitTags++;
    if (descTokens.has(t)) hitDesc++;
    if (blobTokens.has(t)) hitAny++;
  }

  if (qTokens.length) {
    score += (hitTitle / qTokens.length) * 0.36;
    score += (hitTags / qTokens.length) * 0.24;
    score += (hitFolder / qTokens.length) * 0.14;
    score += (hitDesc / qTokens.length) * 0.07;
    score += (hitAny / qTokens.length) * 0.08;
  }

  const simTitle = similarity(q, title);
  const simBlob = similarity(q, blob);
  score += simTitle * 0.34;
  score += simBlob * 0.08;

  const views = Math.max(0, parseInt(video.views || "0", 10) || 0);
  const popularity = Math.min(1, Math.log10(views + 1) / 6);
  score += popularity * 0.03;

  return Math.min(1.8, score);
}

async function buildSmartSearch(env, query) {
  const q = String(query || "").trim();
  const normalized = normalizeText(q);

  const cacheKey = `search:${encodeURIComponent(normalized || q).slice(0, 120)}:v4`;
  const cached = await getSearchCache(env, cacheKey);
  if (cached && Array.isArray(cached.results)) return cached;

  const pages = Array.from({ length: SEARCH_MAX_PAGES }, (_, i) => i + 1);

  const [foldersRes, ...listPages] = await Promise.all([
    doodFetch(env, "/api/folder/list", { only_folders: "1" }),
    ...pages.map(page =>
      doodFetch(env, "/api/file/list", {
        page: String(page),
        per_page: String(SEARCH_PER_PAGE),
      })
    ),
  ]);

  const folders = extractFolders(foldersRes);
  const folderMap = new Map();
  folders.forEach(f => folderMap.set(String(f.fld_id), f.name));

  const allFiles = dedupeByFileCode(listPages.flatMap(extractFiles));
  const enriched = await enrichVideos(env, allFiles, folderMap);

  const ranked = enriched
    .map(v => ({ v, score: scoreVideo(q, v) }))
    .filter(x => x.score > 0.18)
    .sort((a, b) => b.score - a.score)
    .map(x => x.v)
    .slice(0, SEARCH_RESULT_LIMIT);

  const allTags = [...new Set(
    ranked.flatMap(v => Array.isArray(v.__meta?.tags) ? v.__meta.tags : [])
  )];

  const payload = {
    q,
    totalCorpus: enriched.length,
    total: ranked.length,
    allTags,
    results: ranked,
    created_at: new Date().toISOString(),
  };

  await setSearchCache(env, cacheKey, payload);
  return payload;
}

function videoCard(v, query = "") {
  const tags = v.__meta?.tags || [];
  return `
    <div class="video-card" onclick="location.href='/watch?file_code=${encodeURIComponent(v.file_code || "")}'">
      <img src="${escapeHtml(v.single_img || v.splash_img || "")}" onerror="this.src='https://picsum.photos/200/130'">
      <div class="title">${highlightHtml(v.title || "Untitled", query)}</div>
      <div class="meta">${escapeHtml(v.views || "0")} views • ${escapeHtml(v.length || "0")}s${v.__folderName ? ` • ${highlightHtml(v.__folderName, query)}` : ""}</div>
      ${renderTags(tags, query)}
    </div>`;
}

const CSS = `
:root{--bg:#0a0a0a;--panel:#1a1a2e;--line:rgba(255,255,255,.08);--text:#fff;--muted:#aaa;--accent:#e50914}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:'Poppins',sans-serif;min-height:100vh}
a{color:inherit;text-decoration:none}
.nav{position:sticky;top:0;z-index:100;display:flex;align-items:center;gap:1rem;padding:1rem 2rem;background:rgba(0,0,0,.85);backdrop-filter:blur(10px);border-bottom:1px solid var(--line);flex-wrap:wrap}
.nav .logo{font-size:1.8rem;font-weight:800;color:#e50914}
.nav input, .nav select{padding:.7rem 1rem;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,.07);color:var(--text);font-size:1rem;outline:none}
.nav input{flex:1;min-width:220px}
.nav select{width:auto;min-width:160px}
.nav .nav-btn{padding:.7rem 1rem;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid var(--line);font-weight:600}
.hero{position:relative;height:70vh;display:flex;align-items:flex-end;padding:2rem;border-radius:0 0 20px 20px;background-size:cover;background-position:center;margin-bottom:2rem}
.hero::before{content:'';position:absolute;inset:0;background:linear-gradient(0deg,var(--bg) 0%,transparent 60%,rgba(0,0,0,.4) 100%)}
.hero-content{position:relative;z-index:1;max-width:600px}
.hero h1{font-size:3rem;margin-bottom:.5rem}
.hero p{color:var(--muted);margin-bottom:1.5rem}
.hero button{padding:.8rem 2rem;border:none;border-radius:6px;background:#e50914;color:#fff;font-weight:700;cursor:pointer;font-size:1.1rem;margin-right:1rem}
.hero button.secondary{background:rgba(255,255,255,.15)}
.row-container{margin:1.5rem 0}
.row-container h2{padding:0 2rem;margin-bottom:.8rem}
.scroll-row{display:flex;gap:1rem;overflow-x:auto;padding:0 2rem;scroll-behavior:smooth}
.scroll-row::-webkit-scrollbar{display:none}
.video-card{flex:0 0 220px;cursor:pointer;transition:transform .2s}
.video-card:hover{transform:scale(1.05)}
.video-card img{width:100%;height:130px;border-radius:8px;object-fit:cover;background:#1a1a2e;display:block}
.video-card .title{font-weight:600;margin-top:.5rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.video-card .meta{font-size:.8rem;color:var(--muted);margin-top:.2rem}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.tag{display:inline-block;padding:4px 8px;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid var(--line);color:var(--muted);font-size:.72rem}
.tag-cloud{display:flex;flex-wrap:wrap;gap:8px;padding:0 2rem 1rem}
.tag-chip{padding:.45rem .8rem;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,.06);color:var(--muted)}
.kw{background:rgba(229,9,20,.28);color:inherit;padding:0 .18em;border-radius:4px}
.search-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:1.2rem;padding:2rem}
.pagination{display:flex;justify-content:center;align-items:center;gap:1rem;padding:2rem;flex-wrap:wrap}
.pagination button{padding:.5rem 1rem;border:none;border-radius:4px;background:var(--accent);color:white;cursor:pointer}
.watch-container{max-width:1200px;margin:2rem auto;padding:0 1rem}
.watch-container iframe{width:100%;height:70vh;border:none;border-radius:12px;background:#000}
.watch-info{margin-top:1.5rem}
.watch-info h1{font-size:2rem;margin-bottom:.5rem}
.footer{text-align:center;padding:2rem;color:var(--muted);border-top:1px solid var(--line);margin-top:3rem}
.uploader{padding:1rem 0 2rem}
.uploader .wrap{max-width:980px;margin:0 auto;padding:0 1rem}
.uploader .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1.2rem;margin-top:1rem}
.uploader .card{background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:16px;padding:1rem;box-shadow:0 10px 30px rgba(0,0,0,.18)}
.uploader .card h3{margin-bottom:1rem}
.uploader .form{display:flex;flex-direction:column;gap:1rem}
.uploader input, .uploader select, .uploader button{padding:.8rem;border-radius:8px;border:1px solid var(--line);background:rgba(255,255,255,.05);color:var(--text)}
.uploader button{background:var(--accent);font-weight:bold;cursor:pointer}
.progress{height:20px;background:rgba(255,255,255,.1);border-radius:10px;margin-top:1rem;overflow:hidden}
.progress-fill{height:100%;width:0%;background:var(--accent);transition:width .3s}
.upload-note{margin-top:1rem;color:var(--muted);line-height:1.6}
.search-upload-cta{max-width:980px;margin:1rem auto 0;padding:0 1rem}
.search-upload-cta .box{background:linear-gradient(135deg, rgba(229,9,20,.15), rgba(255,255,255,.05));border:1px solid var(--line);border-radius:16px;padding:1rem 1.2rem}
.search-upload-cta .box a{display:inline-block;margin-top:.8rem;padding:.7rem 1rem;border-radius:999px;background:var(--accent);font-weight:700}
@media(max-width:768px){.hero{height:50vh}.hero h1{font-size:2rem}}
.kw{background:rgba(229,9,20,.28);color:inherit;padding:0 .18em;border-radius:4px;}
.player-wrap{position:relative;width:100%;padding-top:56.25%;background:#000;border-radius:16px;overflow:hidden;margin-bottom:1rem}.player-wrap iframe{position:absolute;inset:0;width:100%;height:100%;border:none}
`;

function baseHtml(title, body, extraHead = "") {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  ${extraHead}
  <title>${escapeHtml(title)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>${CSS}</style>
</head>
<body>
  <nav class="nav">
    <a href="/" class="logo">XSTREAMING</a>
    <div style="display:flex;align-items:center;gap:0.5rem;flex:1;min-width:260px;">
      <input type="text" id="globalSearch" placeholder="Cari video..." onkeydown="if(event.key==='Enter') doSearch()">
      <button onclick="doSearch()" class="nav-btn">🔍</button>
    </div>
    <select id="categoryFilter" onchange="applyFilter()">
      <option value="all">All Categories</option>
    </select>
  </nav>

  ${body}

  <div class="footer">© 2026 XStreaming · Powered by DoodStream</div>

  <script>
    function doSearch() {
      const el = document.getElementById('globalSearch');
      const q = el ? el.value.trim() : '';
      if (q) window.location.href = '/search?q=' + encodeURIComponent(q);
    }

    async function loadFilterOptions() {
      try {
        const res = await fetch('/api/folders');
        const data = await res.json();
        const folders = (data && data.result && data.result.folders) ? data.result.folders : (data.result || []);
        const select = document.getElementById('categoryFilter');
        if (!select) return;

        folders.forEach(f => {
          if (!f || f.fld_id === undefined) return;
          const opt = document.createElement('option');
          opt.value = String(f.fld_id);
          opt.textContent = f.name || ('Folder ' + f.fld_id);
          select.appendChild(opt);
        });

        const params = new URLSearchParams(window.location.search);
        const cat = params.get('category') || 'all';
        select.value = cat;
      } catch(e) {
        console.error(e);
      }
    }

    function applyFilter() {
      const cat = document.getElementById('categoryFilter').value;
      const url = new URL(window.location);
      url.searchParams.set('category', cat);
      url.searchParams.set('page', '1');
      window.location = url.toString();
    }

    loadFilterOptions();
  </script>
</body>
</html>`;
}

async function getMetaBySlug(env, slug) {
  if (!env.METADATA || !slug) return null;
  try {
    return await env.METADATA.get(`slug:${slug}`, { type: "json" });
  } catch {
    return null;
  }
}

async function homePage(req, env) {
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const category = url.searchParams.get("category") || "all";
  const perPage = 24;

  const [foldersRes, filesRes] = await Promise.all([
    doodFetch(env, "/api/folder/list", { only_folders: "1" }),
    doodFetch(env, "/api/file/list", {
      page: String(page),
      per_page: String(perPage),
      ...(category !== "all" ? { fld_id: category } : {}),
    }),
  ]);

  const folders = extractFolders(foldersRes);
  const files = extractFiles(filesRes);
  const totalPages = parseInt(filesRes?.result?.total_pages || filesRes?.total_pages || "1", 10) || 1;

  const folderMap = new Map();
  folders.forEach(f => folderMap.set(String(f.fld_id), f.name));

  const enriched = await enrichVideos(env, files, folderMap);

  const byViews = [...asArray(enriched)].sort((a, b) => parseInt(b?.views || "0", 10) - parseInt(a?.views || "0", 10));
  const heroVideo = byViews[0];
  const trending = byViews.slice(0, 10);

  const categorized = new Map();
  enriched.forEach(v => {
    const fid = String(v.fld_id || "0");
    const name = folderMap.get(fid) || (fid === "0" ? "Uncategorized" : "Unknown");
    if (!categorized.has(name)) categorized.set(name, []);
    categorized.get(name).push(v);
  });

  let rows = "";
  for (const [catName, vids] of categorized) {
    const cards = vids.slice(0, 15).map(v => videoCard(v)).join("");
    rows += `<div class="row-container"><h2>📁 ${escapeHtml(catName)}</h2><div class="scroll-row">${cards}</div></div>`;
  }

  const heroHtml = heroVideo ? `
    <div class="hero" style="background-image:url(${escapeHtml(heroVideo.single_img || heroVideo.splash_img || "")})">
      <div class="hero-content">
        <h1>${escapeHtml(heroVideo.title || "Untitled")}</h1>
        <p>🔥 Trending #1 · ${escapeHtml(heroVideo.views || "0")} views</p>
        <button onclick="location.href='/watch?file_code=${encodeURIComponent(heroVideo.file_code || "")}'">▶ Play</button>
        <button class="secondary" onclick="location.href='/watch?file_code=${encodeURIComponent(heroVideo.file_code || "")}'">ℹ Info</button>
      </div>
    </div>` : "";

  const trendingCards = trending.map(v => videoCard(v)).join("");

  const paginationHtml = totalPages > 1 ? `<div class="pagination">
    ${page > 1 ? `<button onclick="location.href='?page=${page - 1}&category=${encodeURIComponent(category)}'">‹ Prev</button>` : ""}
    <span>${page} / ${totalPages}</span>
    ${page < totalPages ? `<button onclick="location.href='?page=${page + 1}&category=${encodeURIComponent(category)}'">Next ›</button>` : ""}
  </div>` : "";

  return new Response(
    baseHtml("XStreaming · Home", `
      ${heroHtml}
      <div class="row-container"><h2>🔥 Trending Now</h2><div class="scroll-row">${trendingCards}</div></div>
      ${rows}
      ${paginationHtml}
    `, `
      <meta name="description" content="XStreaming home">
      <meta name="robots" content="index,follow">
    `),
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

async function uploadFormsHtml() {
  return `
  <section class="uploader" id="upload-section">
    <div class="wrap">
      <h2 style="text-align:center;margin:1rem 0 0">📤 Video Management</h2>
      <p class="upload-note" style="text-align:center;margin-top:.5rem">
        Upload lewat URL atau upload file langsung ke server, lalu beri tag agar video lebih gampang dicari.
      </p>

      <div class="grid">
        <div class="card">
          <h3>🌐 Upload via URL</h3>
          <div class="form">
            <input id="urlInput" placeholder="URL video langsung">
            <input id="urlTitle" placeholder="Judul">
            <input id="urlDesc" placeholder="Deskripsi singkat">
            <input id="urlTags" placeholder="Tag, contoh: anime, action, subtitle indo">
            <select id="urlFolder"></select>
            <button onclick="uploadUrl()">Upload URL</button>
          </div>
        </div>

        <div class="card">
          <h3>📁 Upload File Langsung</h3>
          <div class="form">
            <input type="file" id="fileInput" accept="video/*">
            <input id="fileTitle" placeholder="Judul">
            <input id="fileDesc" placeholder="Deskripsi singkat">
            <input id="fileTags" placeholder="Tag, contoh: comedy, viral, short">
            <select id="fileFolder"></select>
            <div class="progress"><div class="progress-fill" id="progressFill"></div></div>
            <button onclick="uploadFile()">Upload File</button>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <h3>Tag cepat</h3>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
          <span class="tag-chip" onclick="addTag('anime')">anime</span>
          <span class="tag-chip" onclick="addTag('action')">action</span>
          <span class="tag-chip" onclick="addTag('drama')">drama</span>
          <span class="tag-chip" onclick="addTag('comedy')">comedy</span>
          <span class="tag-chip" onclick="addTag('music')">music</span>
          <span class="tag-chip" onclick="addTag('sports')">sports</span>
          <span class="tag-chip" onclick="addTag('viral')">viral</span>
          <span class="tag-chip" onclick="addTag('education')">education</span>
        </div>
      </div>

      <pre id="result" style="margin-top:1rem;background:rgba(255,255,255,.05);padding:1rem;border-radius:8px;max-height:320px;overflow:auto;white-space:pre-wrap"></pre>
    </div>

    <script>
      const result = document.getElementById('result');
      function show(obj) {
        result.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
      }

      function normalizeTags(s) {
        return String(s || '')
          .split(/[,;\\n]+/g)
          .map(x => x.trim().toLowerCase())
          .filter(Boolean);
      }

      function mergeTag(targetId, tag) {
        const el = document.getElementById(targetId);
        if (!el) return;
        const current = normalizeTags(el.value);
        if (!current.includes(tag)) current.push(tag);
        el.value = current.join(', ');
      }

      function addTag(tag) {
        const active = document.activeElement;
        if (active && active.id === 'fileTags') {
          mergeTag('fileTags', tag);
        } else {
          mergeTag('urlTags', tag);
        }
      }

      async function loadUploadFolders() {
        try {
          const res = await fetch('/api/folders');
          const data = await res.json();
          const folders = (data && data.result && data.result.folders) ? data.result.folders : (data.result || []);
          const urlSelect = document.getElementById('urlFolder');
          const fileSelect = document.getElementById('fileFolder');

          const options = [];
          options.push('<option value="0">0 / Root</option>');
          folders.forEach(f => {
            if (!f) return;
            const fid = f.fld_id !== undefined ? String(f.fld_id) : '0';
            const name = (f.name || ('Folder ' + fid)).replaceAll('<','&lt;').replaceAll('>','&gt;');
            options.push('<option value="' + fid + '">' + name + '</option>');
          });

          if (urlSelect) urlSelect.innerHTML = options.join('');
          if (fileSelect) fileSelect.innerHTML = options.join('');
        } catch (e) {
          console.error(e);
          show({ error: 'Gagal load folder', detail: String(e) });
        }
      }

      async function uploadUrl() {
        const url = document.getElementById('urlInput').value.trim();
        const title = document.getElementById('urlTitle').value.trim();
        const description = document.getElementById('urlDesc').value.trim();
        const tags = document.getElementById('urlTags').value.trim();
        const fld = document.getElementById('urlFolder').value.trim() || '0';
        if (!url) return alert('URL wajib');
        show({ status: 'uploading...' });

        try {
          const res = await fetch('/api/upload/url', {
            method:'POST',
            headers:{'content-type':'application/json'},
            body: JSON.stringify({ url, fld_id: fld, new_title: title, description, tags })
          });
          show(await res.json());
        } catch (e) {
          show({ error: String(e) });
        }
      }

      function uploadFile() {
        const file = document.getElementById('fileInput').files[0];
        if(!file) return alert('Pilih file');
        const title = document.getElementById('fileTitle').value.trim();
        const description = document.getElementById('fileDesc').value.trim();
        const tags = document.getElementById('fileTags').value.trim();
        const fld = document.getElementById('fileFolder').value.trim() || '0';

        const form = new FormData();
        form.append('file', file);
        form.append('fld_id', fld);
        form.append('new_title', title);
        form.append('description', description);
        form.append('tags', tags);

        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = (e.loaded / e.total) * 100;
            document.getElementById('progressFill').style.width = pct + '%';
            show({ status: 'uploading', progress: pct.toFixed(1) + '%' });
          }
        };
        xhr.onload = () => {
          try { show(JSON.parse(xhr.responseText)); }
          catch { show(xhr.responseText); }
        };
        xhr.onerror = () => show({ error: 'Network error' });
        xhr.open('POST', '/api/upload/file');
        xhr.send(form);
      }

      loadUploadFolders();
    </script>
  </section>`;
}

async function uploadPage() {
  return new Response(
    baseHtml("Upload Video", `
      ${await uploadFormsHtml()}
    `, `
      <meta name="robots" content="noindex,nofollow">
    `),
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

async function searchPage(req, env) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") || "";
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const perPage = 24;

  if (!q.trim()) {
    return new Response(
      baseHtml("Search", `
        <div style="padding:2rem">
          <h2>Masukkan kata pencarian</h2>
          <p class="muted">Contoh: anime, action, music, tutorial, vlog</p>
        </div>
      `, `<meta name="robots" content="noindex,nofollow">`),
      { headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }

  const data = await buildSmartSearch(env, q);
  const results = data.results || [];
  const total = data.total || 0;
  const allTags = data.allTags || [];

  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const pageResults = results.slice((page - 1) * perPage, page * perPage);

  const grid = pageResults.length
    ? pageResults.map(v => videoCard(v, q)).join("")
    : `<p style="padding:2rem;color:var(--muted)">Tidak ada hasil yang mendekati "${escapeHtml(q)}"</p>`;

  const paginationHtml = total > perPage ? `
    <div class="pagination">
      ${page > 1 ? `<button onclick="location.href='?q=${encodeURIComponent(q)}&page=${page - 1}'">‹ Prev</button>` : ""}
      <span>${page} / ${pageCount}</span>
      ${page < pageCount ? `<button onclick="location.href='?q=${encodeURIComponent(q)}&page=${page + 1}'">Next ›</button>` : ""}
    </div>
  ` : "";

  const extraHead = `
    <meta name="description" content="Hasil pencarian video untuk ${escapeHtml(q)} di XStreaming">
    <meta name="keywords" content="${escapeHtml([q, ...allTags].filter(Boolean).join(", "))}">
    <meta name="robots" content="index,follow">
    <link rel="canonical" href="${escapeHtml(url.origin + url.pathname + "?q=" + encodeURIComponent(q))}">
  `;

  return new Response(
    baseHtml(`Search: ${escapeHtml(q)}`, `
      <div style="padding:2rem 2rem 0">
        <h2 style="margin-bottom:.4rem">Hasil untuk "${escapeHtml(q)}"</h2>
        <p class="muted">${total} video yang mirip ditemukan dari ${data.totalCorpus || 0} data</p>
      </div>

      ${allTags.length ? `<div class="tag-cloud">${allTags.slice(0, 18).map(t => `<span class="tag-chip">#${escapeHtml(t)}</span>`).join("")}</div>` : ""}

      <div class="search-grid">${grid}</div>
      ${paginationHtml}
    `, extraHead),
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

async function watchPage(req, env) {
  const url = new URL(req.url);
  const code = url.searchParams.get("file_code");
  if (!code) return new Response("Missing file_code", { status: 400 });

  const info = await doodFetch(env, "/api/file/info", { file_code: code });
  const video = info?.result?.[0] || info?.result || null;

  if (!video) {
    return new Response(
      baseHtml("Video not found", `<div class="watch-container"><p>Video not found.</p></div>`),
      { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }

  const meta = await getMeta(env, code);
  video.__meta = meta || {};

  const embedUrl =
    video?.protected_embed ||
    video?.embed_url ||
    video?.embed ||
    `https://myvidplay.com/e/${encodeURIComponent(video.filecode || code)}`;

  const title = meta?.title || video.title || "Video";

  const description =
    meta?.description ||
    `Uploaded ${video.uploaded || "-"} • ${video.views || 0} views`;

  const tags = meta?.tags || [];

  const extraHead = `
    <meta name="description" content="${escapeHtml(description)}">
    <meta name="keywords" content="${escapeHtml([title, ...tags].filter(Boolean).join(", "))}">
    <meta name="robots" content="index,follow">
  `;

  const recommendations = await buildRecommendations(env, video, 18);

  const recommendationHtml = recommendations.length
    ? `
      <div class="row-container">
        <h2>🔥 Recommended For You</h2>
        <div class="scroll-row">
          ${recommendations.map(v => videoCard(v, title)).join("")}
        </div>
      </div>
    `
    : "";

  return new Response(
    baseHtml(title, `
      <div class="watch-container">

        <div class="player-wrap">
          <iframe
            src="${escapeHtml(embedUrl)}"
            scrolling="no"
            frameborder="0"
            allowfullscreen="true">
          </iframe>
        </div>

        <div class="watch-info">
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(description)}</p>
          ${renderTags(tags)}
          <p>👁 ${escapeHtml(video.views || "0")} views • ⏱ ${escapeHtml(video.length || "0")}s</p>
        </div>

        ${recommendationHtml}

      </div>
    `, extraHead),
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}
function embedPage(path) {
  const code = path.split("/").pop();
  if (!code) return new Response("Invalid", { status: 400 });
  const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Embed</title>
  <style>body{margin:0;background:#000}iframe{width:100%;height:100vh;border:none}</style>
</head>
<body>
  <iframe src="https://dood.wf/e/${encodeURIComponent(code)}" allowfullscreen></iframe>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function sitemapPage(env, origin) {
  if (!env.METADATA) {
    return new Response("", { status: 404 });
  }
  const list = await env.METADATA.list({ prefix: "slug:" });
  let urls = "";
  for (const key of list.keys) {
    const slug = key.name.replace("slug:", "");
    const data = await env.METADATA.get(key.name, { type: "json" });
    if (data?.file_code) {
      urls += `<url><loc>${origin}/video/${slug}</loc></url>`;
    }
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
}

async function handleApi(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;

  try {
    if (path === "/api/files") {
      const data = await doodFetch(env, "/api/file/list", {
        page: url.searchParams.get("page") || "1",
        per_page: url.searchParams.get("per_page") || "50",
        fld_id: url.searchParams.get("fld_id") || "",
        created: url.searchParams.get("created") || "",
      });
      return json(data);
    }

    if (path === "/api/file/info") {
      const code = url.searchParams.get("file_code");
      if (!code) throw new Error("file_code required");
      const data = await doodFetch(env, "/api/file/info", { file_code: code });
      return json(data);
    }

    if (path === "/api/file/check") {
      const code = url.searchParams.get("file_code");
      if (!code) throw new Error("file_code required");
      const data = await doodFetch(env, "/api/file/check", { file_code: code });
      return json(data);
    }

    if (path === "/api/search") {
      const q = url.searchParams.get("q") || "";
      if (!q.trim()) return json({ q, total: 0, results: [] });

      const data = await buildSmartSearch(env, q);
      return json({
        q: data.q,
        total: data.total,
        totalCorpus: data.totalCorpus,
        allTags: data.allTags,
        results: data.results,
      });
    }

    if (path === "/api/folders") {
      const data = await doodFetch(env, "/api/folder/list", {
        only_folders: "1",
      });
      return json(data);
    }

    if (path === "/api/upload/url" && req.method === "POST") {
      const body = await req.json();
      if (!body.url) throw new Error("url required");

      const data = await doodFetch(env, "/api/upload/url", {
        url: body.url,
        fld_id: body.fld_id || "0",
        new_title: body.new_title || body.title || "",
      });

      const fileCode = extractFileCodeFromUploadResponse(data);
      const tags = parseTags(body.tags || "");

      if (fileCode) {
        const folderId = String(body.fld_id || "0");
        const meta = {
          title: body.new_title || body.title || "",
          description: body.description || "",
          tags,
          folder_id: folderId,
          folder_name: body.folder_name || "",
          source: "url",
          created_at: new Date().toISOString(),
          slug: slugify(body.new_title || body.title || fileCode),
        };
        await saveMeta(env, fileCode, meta);
        if (meta.slug) {
          try {
            await env.METADATA.put(`slug:${meta.slug}`, JSON.stringify({ file_code: fileCode }));
          } catch {}
        }
      }

      return json({ ok: true, result: data, file_code: fileCode || null });
    }

    if (path === "/api/upload/server") {
      const data = await doodFetch(env, "/api/upload/server");
      return json(data);
    }

    if (path === "/api/upload/file" && req.method === "POST") {
      const form = await req.formData();
      const file = form.get("file");

      if (!file) {
        return json({ error: "file required" }, 400);
      }

      const fld_id = form.get("fld_id") || "0";
      const new_title = form.get("new_title") || "";
      const tags = parseTags(form.get("tags") || "");
      const description = String(form.get("description") || "");
      const folder_name = String(form.get("folder_name") || "");

      const serverRes = await doodFetch(env, "/api/upload/server");
      const uploadUrl = pickUploadUrl(serverRes);

      if (!uploadUrl) {
        return json(
          {
            error: "Could not get upload server",
            debug: serverRes,
          },
          500
        );
      }

      const doodForm = new FormData();
      if (env.DOOD_KEY) doodForm.append("api_key", env.DOOD_KEY);
      doodForm.append("file", file, file.name || "upload.mp4");
      doodForm.append("fld_id", fld_id);
      if (new_title) doodForm.append("file_title", new_title);

      const uploadRes = await fetch(uploadUrl, {
        method: "POST",
        body: doodForm,
      });

      const text = await uploadRes.text();
      let uploadData;
      try {
        uploadData = JSON.parse(text);
      } catch {
        uploadData = {
          error: "Upload response not JSON",
          raw: text.slice(0, 1000),
          status: uploadRes.status,
        };
      }

      if (!uploadRes.ok) {
        return json(
          {
            error: "Upload failed",
            upstream: uploadData,
            status: uploadRes.status,
          },
          500
        );
      }

      const fileCode = extractFileCodeFromUploadResponse(uploadData);

      if (fileCode) {
        const meta = {
          title: new_title || uploadData?.title || file.name || "",
          description,
          tags,
          folder_id: String(fld_id || "0"),
          folder_name,
          source: "file",
          filename: file.name || "",
          created_at: new Date().toISOString(),
          slug: slugify(new_title || file.name || fileCode),
        };
        await saveMeta(env, fileCode, meta);
        if (meta.slug) {
          try {
            await env.METADATA.put(`slug:${meta.slug}`, JSON.stringify({ file_code: fileCode }));
          } catch {}
        }
      }

      return json({
        ok: true,
        result: uploadData,
        file_code: fileCode || null,
      });
    }

    if (path === "/api/upload/list") {
      const data = await doodFetch(env, "/api/urlupload/list");
      return json(data);
    }

    if (path === "/api/upload/status") {
      const code = url.searchParams.get("file_code");
      if (!code) throw new Error("file_code required");
      const data = await doodFetch(env, "/api/urlupload/status", { file_code: code });
      return json(data);
    }

    if (path === "/api/folder/create" && req.method === "POST") {
      const body = await req.json();
      if (!body.name) throw new Error("name required");
      const data = await doodFetch(env, "/api/folder/create", {
        name: body.name,
        parent_id: body.parent_id || "0",
      });
      return json(data);
    }

    if (path === "/api/file/rename" && req.method === "POST") {
      const body = await req.json();
      if (!body.file_code || !body.title) {
        throw new Error("file_code & title required");
      }
      const data = await doodFetch(env, "/api/file/rename", {
        file_code: body.file_code,
        title: body.title,
      });

      if (body.file_code) {
        const meta = (await getMeta(env, body.file_code)) || {};
        meta.title = body.title;
        await saveMeta(env, body.file_code, meta);
      }

      return json(data);
    }

    if (path === "/api/file/move" && req.method === "POST") {
      const body = await req.json();
      if (!body.file_code || !body.fld_id) {
        throw new Error("file_code & fld_id required");
      }
      const data = await doodFetch(env, "/api/file/move", {
        file_code: body.file_code,
        fld_id: body.fld_id,
      });

      if (body.file_code) {
        const meta = (await getMeta(env, body.file_code)) || {};
        meta.folder_id = String(body.fld_id);
        await saveMeta(env, body.file_code, meta);
      }

      return json(data);
    }

    if (path === "/api/dmca") {
      const last = url.searchParams.get("last") || "24";
      const data = await doodFetch(env, "/api/file/dmca", { last });
      return json(data);
    }

    if (path === "/api/encodings") {
      const code = url.searchParams.get("file_code") || "";
      const data = await doodFetch(env, "/api/file/encodings", { file_code: code });
      return json(data);
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    return json(
      {
        error: err.message,
        stack: err.stack,
      },
      500
    );
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (path.startsWith("/api/")) {
        return handleApi(req, env);
      }

      if (path === "/") return homePage(req, env);
      if (path === "/watch") return watchPage(req, env);
      if (path === "/search") return searchPage(req, env);
      if (path === "/upload" || path === "/uploader") return uploadPage();
      if (path.startsWith("/embed/")) return embedPage(path);

      if (path.startsWith("/video/") && env.METADATA) {
        const slug = path.replace("/video/", "");
        const data = await getMetaBySlug(env, slug);
        if (data?.file_code) {
          return Response.redirect(url.origin + `/watch?file_code=${encodeURIComponent(data.file_code)}`, 301);
        }
        return new Response("Not found", { status: 404 });
      }

      if (path === "/sitemap.xml") {
        return sitemapPage(env, url.origin);
      }

      if (path === "/robots.txt") {
        const robots = `User-agent: *\nAllow: /\nSitemap: ${url.origin}/sitemap.xml`;
        return new Response(robots, { headers: { "content-type": "text/plain; charset=utf-8" } });
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      return new Response(`Error: ${err.message}\n${err.stack}`, {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  },
};
