// ========== Cloudflare Worker: Streaming Frontend ala Netflix ==========
// API backend: https://web-streaming.hanadrophtml.workers.dev
// Binding KV (opsional): METADATA → untuk SEO slug & sitemap

const API = "https://web-streaming.hanadrophtml.workers.dev";

const CSS = `
:root{--bg:#0a0a0a;--panel:#1a1a2e;--line:rgba(255,255,255,.08);--text:#fff;--muted:#aaa;--accent:#e50914}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:'Poppins',sans-serif;min-height:100vh}
a{color:inherit;text-decoration:none}
.nav{position:sticky;top:0;z-index:100;display:flex;align-items:center;gap:2rem;padding:1rem 2rem;background:rgba(0,0,0,.85);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.nav .logo{font-size:1.8rem;font-weight:800;color:#e50914}
.nav input{flex:1;padding:.7rem 1rem;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,.07);color:var(--text);font-size:1rem}
.nav input::placeholder{color:#888}
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
.video-card img{width:100%;height:130px;border-radius:8px;object-fit:cover;background:#1a1a2e}
.video-card .title{font-weight:600;margin-top:.5rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.video-card .meta{font-size:.8rem;color:var(--muted);margin-top:.2rem}
.search-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:1.2rem;padding:2rem}
.watch-container{max-width:1200px;margin:2rem auto;padding:0 1rem}
.watch-container iframe{width:100%;height:70vh;border:none;border-radius:12px;background:#000}
.watch-info{margin-top:1.5rem}
.watch-info h1{font-size:2rem;margin-bottom:.5rem}
.watch-info p{color:var(--muted)}
.footer{text-align:center;padding:2rem;color:var(--muted);border-top:1px solid var(--line);margin-top:3rem}
@media(max-width:768px){.hero{height:50vh}.hero h1{font-size:2rem}}
`;

function escapeHtml(s) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function api(path) {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error("API error: " + res.status);
  return res.json();
}

// Ambil semua video & folder (paralel)
async function loadData() {
  const [filesRes, foldersRes] = await Promise.all([
    api("/files?per_page=100"),
    api("/folder/list?only_folders=1")
  ]);
  const files = filesRes.result?.files ?? [];
  const folders = foldersRes.result?.folders ?? [];
  return { files, folders };
}

// ---------- PAGE RENDERER ----------
function page(title, body) {
  return `<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${escapeHtml(title)}</title><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800&display=swap" rel="stylesheet"><style>${CSS}</style></head><body><nav class="nav"><a href="/" class="logo">XPANAS</a><input type="text" id="q" placeholder="Cari video..." onkeydown="if(event.key==='Enter')location.href='/search?q='+encodeURIComponent(this.value)"></nav>${body}<div class="footer">© 2026 XPANAS · Powered by DoodStream</div></body></html>`;
}

function card(v) {
  return `<div class="video-card" onclick="location.href='/watch?file_code=${v.file_code}'"><img src="${v.single_img||''}" onerror="this.src='https://picsum.photos/200/130'"><div class="title">${escapeHtml(v.title)}</div><div class="meta">${v.views} views · ${v.length}s</div></div>`;
}

function homePage(hero, trending, categories) {
  const rows = categories.map(c => {
    const cards = c.videos.map(card).join("");
    return `<div class="row-container"><h2>📁 ${escapeHtml(c.name)}</h2><div class="scroll-row">${cards}</div></div>`;
  }).join("");

  const heroHTML = hero ? `<div class="hero" style="background-image:url(${hero.single_img||''})"><div class="hero-content"><h1>${escapeHtml(hero.title)}</h1><p>🔥 Trending #1 · ${hero.views} views</p><button onclick="location.href='/watch?file_code=${hero.file_code}'">▶ Play</button><button class="secondary" onclick="location.href='/watch?file_code=${hero.file_code}'">ℹ Info</button></div></div>` : "";

  const trendingCards = trending.map(card).join("");
  return page("XPANAS · Streaming", `${heroHTML}<div class="row-container"><h2>🔥 Trending Now</h2><div class="scroll-row">${trendingCards}</div></div>${rows}`);
}

function searchPage(query, results) {
  const grid = results.map(card).join("") || "<p style='padding:2rem'>Tidak ditemukan.</p>";
  return page(`Search: ${escapeHtml(query)}`, `<h2 style="padding:2rem 2rem 0">Hasil untuk "${escapeHtml(query)}"</h2><div class="search-grid">${grid}</div>`);
}

function watchPage(video) {
  return page(video.title, `<div class="watch-container"><iframe src="https://dood.wf/e/${video.filecode}" allowfullscreen></iframe><div class="watch-info"><h1>${escapeHtml(video.title)}</h1><p>Uploaded ${video.uploaded} · 👁 ${video.views} views · ⏱ ${video.length}s</p></div></div>`);
}

// ---------- MAIN FETCH ----------
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const p = u.pathname;

    try {
      // --- Home ---
      if (p === "/") {
        const { files, folders } = await loadData();
        const byViews = [...files].sort((a, b) => parseInt(b.views) - parseInt(a.views));
        const hero = byViews[0];
        const trending = byViews.slice(0, 10);

        // Kategori: tiap folder
        const categories = await Promise.all(folders.map(async f => {
          const vids = files.filter(v => v.fld_id === f.fld_id).slice(0, 15);
          return { name: f.name, id: f.fld_id, videos: vids };
        }));
        // Video tanpa folder
        const root = files.filter(v => v.fld_id === "0");
        if (root.length) categories.unshift({ name: "Uncategorized", id: "0", videos: root.slice(0, 15) });

        return new Response(homePage(hero, trending, categories), {
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }

      // --- Watch ---
      if (p === "/watch") {
        const fc = u.searchParams.get("file_code");
        if (!fc) return new Response("Missing file_code", { status: 400 });
        const info = await api("/file/info?file_code=" + fc);
        const video = info.result?.[0];
        if (!video) return new Response("Not found", { status: 404 });
        return new Response(watchPage(video), {
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }

      // --- Search ---
      if (p === "/search") {
        const q = u.searchParams.get("q") || "";
        const data = await api("/search?q=" + encodeURIComponent(q));
        const results = data.result ?? [];
        return new Response(searchPage(q, results), {
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }

      // --- SEO slug redirect (optional KV) ---
      if (p.startsWith("/video/") && env.METADATA) {
        const slug = p.replace("/video/", "");
        const meta = await env.METADATA.get(`slug:${slug}`, { type: "json" });
        if (meta?.file_code) return Response.redirect(u.origin + `/watch?file_code=${meta.file_code}`, 301);
        return new Response("Not found", { status: 404 });
      }

      // --- Sitemap (optional KV) ---
      if (p === "/sitemap.xml" && env.METADATA) {
        const list = await env.METADATA.list({ prefix: "slug:" });
        let urls = "";
        for (const k of list.keys) {
          const data = await env.METADATA.get(k.name, { type: "json" });
          if (data?.file_code) urls += `<url><loc>https://${u.host}/video/${k.name.replace("slug:","")}</loc></url>`;
        }
        return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, { headers: { "content-type": "application/xml" } });
      }

      if (p === "/robots.txt") {
        return new Response(`User-agent: *\nAllow: /\nSitemap: https://${u.host}/sitemap.xml`, { headers: { "content-type": "text/plain" } });
      }

      return new Response("Not Found", { status: 404 });
    } catch (e) {
      return new Response("Error: " + e.message, { status: 500 });
    }
  }
};
