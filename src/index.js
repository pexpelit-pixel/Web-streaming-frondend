// worker.js – XStreaming (Netflix-style + API Proxy + Upload + SEO)
// Binding: DOOD_API (text), DOOD_KEY (secret), METADATA (KV optional)

const corsHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
};

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
  return (
    data?.result?.files ||
    data?.result?.data ||
    data?.files ||
    data?.result ||
    []
  );
}

// Helper untuk panggil DoodStream API (GET / query string)
async function doodFetch(env, path, params = {}) {
  const base = env.DOOD_API || "https://doodapi.co";
  const url = new URL(path, base);

  if (env.DOOD_KEY) url.searchParams.set("key", env.DOOD_KEY);

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v) !== "") {
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url, {
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

// Helper untuk POST ke DoodStream API (JSON body)
async function doodPost(env, path, body = {}) {
  const base = env.DOOD_API || "https://doodapi.co";
  const url = new URL(path, base);

  if (env.DOOD_KEY) url.searchParams.set("key", env.DOOD_KEY);

  const res = await fetch(url, {
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

// ---------- API Proxy Handlers ----------
async function handleApi(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;

  try {
    // GET /api/files
    if (path === "/api/files") {
      const data = await doodFetch(env, "/api/file/list", {
        page: url.searchParams.get("page") || "1",
        per_page: url.searchParams.get("per_page") || "50",
        fld_id: url.searchParams.get("fld_id") || "",
        created: url.searchParams.get("created") || "",
      });
      return new Response(JSON.stringify(data), { headers: corsHeaders });
    }

    // GET /api/file/info
    if (path === "/api/file/info") {
      const code = url.searchParams.get("file_code");
      if (!code) throw new Error("file_code required");
      const data = await doodFetch(env, "/api/file/info", { file_code: code });
      return new Response(JSON.stringify(data), { headers: corsHeaders });
    }

    // GET /api/file/check
    if (path === "/api/file/check") {
      const code = url.searchParams.get("file_code");
      if (!code) throw new Error("file_code required");
      const data = await doodFetch(env, "/api/file/check", { file_code: code });
      return new Response(JSON.stringify(data), { headers: corsHeaders });
    }

    // GET /api/search
    if (path === "/api/search") {
      const q = url.searchParams.get("q") || "";
      const data = await doodFetch(env, "/api/search/videos", { search_term: q });
      return new Response(JSON.stringify(data), { headers: corsHeaders });
    }

    // GET /api/folders
    if (path === "/api/folders") {
      const data = await doodFetch(env, "/api/folder/list", {
        only_folders: "1",
      });
      return new Response(JSON.stringify(data), { headers: corsHeaders });
    }

    // POST /api/upload/url
    if (path === "/api/upload/url" && req.method === "POST") {
      const body = await req.json();
      if (!body.url) throw new Error("url required");

      const data = await doodFetch(env, "/api/upload/url", {
        url: body.url,
        fld_id: body.fld_id || "0",
        new_title: body.new_title || body.title || "",
      });

      return new Response(JSON.stringify(data), { headers: corsHeaders });
    }

    // GET /api/upload/server
    if (path === "/api/upload/server") {
      const data = await doodFetch(env, "/api/upload/server");
      return new Response(JSON.stringify(data), { headers: corsHeaders });
    }

    // POST /api/upload/file
    if (path === "/api/upload/file" && req.method === "POST") {
      const form = await req.formData();
      const file = form.get("file");
      if (!file) throw new Error("file required");

      // 1. Dapatkan server upload
      const serverRes = await doodFetch(env, "/api/upload/server");
      const uploadUrl = serverRes?.result || serverRes?.upload_url || serverRes?.url;
      if (!uploadUrl) throw new Error("Could not get upload server");

      // 2. Forward file ke server upload Dood
      const doodForm = new FormData();
      if (env.DOOD_KEY) doodForm.append("api_key", env.DOOD_KEY);
      doodForm.append("file", file, file.name);
      doodForm.append("fld_id", form.get("fld_id") || "0");
      if (form.get("new_title")) doodForm.append("file_title", form.get("new_title"));

      const uploadRes = await fetch(uploadUrl, {
        method: "POST",
        body: doodForm,
      });

      const text = await uploadRes.text();
      let uploadData;
      try {
        uploadData = JSON.parse(text);
      } catch {
        uploadData = { raw: text, status: uploadRes.status };
      }

      return new Response(JSON.stringify(uploadData), { headers: corsHeaders });
    }

    // GET /api/upload/list
    if (path === "/api/upload/list") {
      const data = await doodFetch(env, "/api/urlupload/list");
      return new Response(JSON.stringify(data), { headers: corsHeaders });
    }

    // GET /api/upload/status
    if (path === "/api/upload/status") {
      const code = url.searchParams.get("file_code");
      if (!code) throw new Error("file_code required");
      const data = await doodFetch(env, "/api/urlupload/status", { file_code: code });
      return new Response(JSON.stringify(data), { headers: corsHeaders });
    }

    // POST /api/folder/create
    if (path === "/api/folder/create" && req.method === "POST") {
      const body = await req.json();
      if (!body.name) throw new Error("name required");
      const data = await doodFetch(env, "/api/folder/create", {
        name: body.name,
        parent_id: body.parent_id || "0",
      });
      return new Response(JSON.stringify(data), { headers: corsHeaders });
    }

    // POST /api/file/rename
    if (path === "/api/file/rename" && req.method === "POST") {
      const body = await req.json();
      if (!body.file_code || !body.title) {
        throw new Error("file_code & title required");
      }
      const data = await doodFetch(env, "/api/file/rename", {
        file_code: body.file_code,
        title: body.title,
      });
      return new Response(JSON.stringify(data), { headers: corsHeaders });
    }

    // POST /api/file/move
    if (path === "/api/file/move" && req.method === "POST") {
      const body = await req.json();
      if (!body.file_code || !body.fld_id) {
        throw new Error("file_code & fld_id required");
      }
      const data = await doodFetch(env, "/api/file/move", {
        file_code: body.file_code,
        fld_id: body.fld_id,
      });
      return new Response(JSON.stringify(data), { headers: corsHeaders });
    }

    // GET /api/dmca
    if (path === "/api/dmca") {
      const last = url.searchParams.get("last") || "24";
      const data = await doodFetch(env, "/api/file/dmca", { last });
      return new Response(JSON.stringify(data), { headers: corsHeaders });
    }

    // GET /api/encodings
    if (path === "/api/encodings") {
      const code = url.searchParams.get("file_code") || "";
      const data = await doodFetch(env, "/api/file/encodings", { file_code: code });
      return new Response(JSON.stringify(data), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: corsHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}

// ---------- Halaman Publik ----------
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
    <a class="nav-btn" href="/upload">Upload</a>
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

function videoCard(v) {
  return `
    <div class="video-card" onclick="location.href='/watch?file_code=${encodeURIComponent(v.file_code || "")}'">
      <img src="${escapeHtml(v.single_img || v.splash_img || "")}" onerror="this.src='https://picsum.photos/200/130'">
      <div class="title">${escapeHtml(v.title || "Untitled")}</div>
      <div class="meta">${escapeHtml(v.views || "0")} views • ${escapeHtml(v.length || "0")}s</div>
    </div>`;
}

function uploadFormsHtml() {
  return `
  <section class="uploader" id="upload-section">
    <div class="wrap">
      <h2 style="text-align:center;margin:1rem 0 0">📤 Upload Video</h2>
      <p class="upload-note" style="text-align:center;margin-top:.5rem">
        Upload lewat URL atau upload file langsung ke server.
      </p>

      <div class="grid">
        <div class="card">
          <h3>Via URL</h3>
          <div class="form">
            <input id="urlInput" placeholder="URL video langsung">
            <input id="urlTitle" placeholder="Judul">
            <select id="urlFolder"></select>
            <button onclick="uploadUrl()">Upload URL</button>
          </div>
        </div>

        <div class="card">
          <h3>File Langsung</h3>
          <div class="form">
            <input type="file" id="fileInput" accept="video/*">
            <input id="fileTitle" placeholder="Judul">
            <select id="fileFolder"></select>
            <div class="progress"><div class="progress-fill" id="progressFill"></div></div>
            <button onclick="uploadFile()">Upload File</button>
          </div>
        </div>
      </div>

      <pre id="result" style="margin-top:1rem;background:rgba(255,255,255,.05);padding:1rem;border-radius:8px;max-height:320px;overflow:auto;white-space:pre-wrap"></pre>
    </div>

    <script>
      const result = document.getElementById('result');
      function show(obj) {
        result.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
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
        const fld = document.getElementById('urlFolder').value.trim() || '0';
        if (!url) return alert('URL wajib');
        show({ status: 'uploading...' });

        try {
          const res = await fetch('/api/upload/url', {
            method:'POST',
            headers:{'content-type':'application/json'},
            body: JSON.stringify({ url, fld_id: fld, new_title: title })
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
        const fld = document.getElementById('fileFolder').value.trim() || '0';

        const form = new FormData();
        form.append('file', file);
        form.append('fld_id', fld);
        form.append('new_title', title);

        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = (e.loaded / e.total) * 100;
            document.getElementById('progressFill').style.width = pct + '%';
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

async function homePage(req, env) {
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const category = url.searchParams.get("category") || "all";
  const perPage = 24;

  const foldersRes = await doodFetch(env, "/api/folder/list", { only_folders: "1" });
  const folders = extractFolders(foldersRes);

  const fileParams = { page: String(page), per_page: String(perPage) };
  if (category !== "all") fileParams.fld_id = category;

  const filesRes = await doodFetch(env, "/api/file/list", fileParams);
  const files = extractFiles(filesRes);
  const totalPages = parseInt(filesRes?.result?.total_pages || filesRes?.total_pages || "1", 10) || 1;

  const byViews = [...asArray(files)].sort((a, b) => parseInt(b?.views || "0", 10) - parseInt(a?.views || "0", 10));
  const heroVideo = byViews[0];
  const trending = byViews.slice(0, 10);

  const folderMap = new Map();
  folders.forEach(f => folderMap.set(String(f.fld_id), f.name));

  const categorized = new Map();
  files.forEach(v => {
    const fid = String(v.fld_id || "0");
    const name = folderMap.get(fid) || (fid === "0" ? "Uncategorized" : "Unknown");
    if (!categorized.has(name)) categorized.set(name, []);
    categorized.get(name).push(v);
  });

  let rows = "";
  for (const [catName, vids] of categorized) {
    const cards = vids.slice(0, 15).map(videoCard).join("");
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

  const trendingCards = trending.map(videoCard).join("");

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
    `),
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

  let meta = null;
  if (env.METADATA) {
    try {
      meta = await env.METADATA.get(`meta:${code}`, { type: "json" });
    } catch {}
  }

  const title = meta?.title || video.title || "Video";
  const description = meta?.description || `Uploaded ${video.uploaded || "-"} • ${video.views || 0} views`;
  const extraHead = `<meta name="description" content="${escapeHtml(description)}">`;

  return new Response(
    baseHtml(title, `
      <div class="watch-container">
        <iframe src="https://dood.wf/e/${encodeURIComponent(video.filecode || code)}" allowfullscreen></iframe>
        <div class="watch-info">
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(description)}</p>
          <p>👁 ${escapeHtml(video.views || "0")} views • ⏱ ${escapeHtml(video.length || "0")}s</p>
        </div>
      </div>
    `, extraHead),
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

async function searchPage(req, env) {
  const q = new URL(req.url).searchParams.get("q") || "";
  const data = await doodFetch(env, "/api/search/videos", { search_term: q });
  const results = extractFiles(data);

  const grid = results.length
    ? results.map(videoCard).join("")
    : `<p style="padding:2rem;color:var(--muted)">Tidak ada hasil untuk "${escapeHtml(q)}"</p>`;

  return new Response(
    baseHtml(`Search: ${escapeHtml(q)}`, `
      <h2 style="padding:2rem 2rem 0">Hasil untuk "${escapeHtml(q)}"</h2>
      <div class="search-grid">${grid}</div>
      <div class="search-upload-cta">
        <div class="box">
          <strong>Belum ketemu videonya?</strong><br>
          Upload langsung atau upload via URL dari sini.
          <br>
          <a href="/upload">Buka halaman upload</a>
        </div>
      </div>
      ${uploadFormsHtml()}
    `),
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function uploadPage() {
  return new Response(
    baseHtml("Upload Video", `
      ${uploadFormsHtml()}
    `),
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function embedPage(path) {
  const code = path.split("/").pop();
  if (!code) return new Response("Invalid", { status: 400 });
  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Embed</title><style>body{margin:0;background:#000}iframe{width:100%;height:100vh;border:none}</style></head>
<body><iframe src="https://dood.wf/e/${encodeURIComponent(code)}" allowfullscreen></iframe></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function sitemapPage(env, origin) {
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

// ---------- Main Worker ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // API proxy
      if (path.startsWith("/api/")) {
        return handleApi(req, env);
      }

      // Public pages
      if (path === "/") return homePage(req, env);
      if (path === "/watch") return watchPage(req, env);
      if (path === "/search") return searchPage(req, env);
      if (path === "/upload" || path === "/uploader") return uploadPage();
      if (path.startsWith("/embed/")) return embedPage(path);

      // SEO (KV required)
      if (path.startsWith("/video/") && env.METADATA) {
        const slug = path.replace("/video/", "");
        const data = await env.METADATA.get(`slug:${slug}`, { type: "json" });
        if (data?.file_code) {
          return Response.redirect(url.origin + `/watch?file_code=${encodeURIComponent(data.file_code)}`, 301);
        }
        return new Response("Not found", { status: 404 });
      }

      if (path === "/sitemap.xml" && env.METADATA) {
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
