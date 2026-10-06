const POSTS_PER_CRON_RUN = 1;

export default {
  // Visiting the URL publishes only 1 post (for testing).
  async fetch(request, env) {
    return await generateAndPublish(env, getTopicTitle());
  },
  // Cron run publishes 3 posts, each with a different topic.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBatch(env));
  }
}

async function runBatch(env) {
  const topics = pickDistinctTopics(POSTS_PER_CRON_RUN);
  for (const topic of topics) {
    const res = await generateAndPublish(env, topic);
    console.log(await res.text());
  }
}

// Fixed nature/travel topic pool (GNews removed so posts always stay on-topic).
// Add or remove topics anytime.
const TOPICS = [
  "a breathtaking waterfall in India that most tourists don't know about",
  "a hidden valley in the Himalayas perfect for trekking",
  "an unexplored hill station in North East India",
  "a mysterious cave system in India worth visiting",
  "a stunning lake in India surrounded by mountains",
  "an offbeat beach destination in India",
  "a lesser-known wildlife sanctuary in India",
  "a scenic road trip route through the Western Ghats",
  "a breathtaking natural wonder outside India, like a waterfall, canyon, or fjord",
  "an ancient forest or national park known for biodiversity",
  "a high-altitude trek in Uttarakhand or Himachal Pradesh",
  "a spectacular river gorge or canyon in India",
  "a serene backwater or wetland destination in India",
  "a desert landscape with unique natural formations",
  "a volcanic landscape or hot spring destination",
  "a beautiful alpine meadow or bugyal in the Indian Himalayas",
  "a lesser-known national park in Central India known for tigers or birds",
  "a spectacular sunrise or sunset viewpoint in the mountains",
  "a glacier or snow-covered destination worth visiting",
  "a coastal cliff or island destination with pristine nature",
];

function getTopicTitle() {
  return TOPICS[Math.floor(Math.random() * TOPICS.length)];
}

function pickDistinctTopics(n) {
  const pool = [...TOPICS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

// Gemini sometimes returns 503/429 (temporary overload). Retry a few times,
// and fall back to the lighter flash-lite model if the main model keeps failing.
// JSON mode + schema guarantees valid JSON (no broken quotes/newlines in HTML).
async function callGeminiWithRetry(env, prompt) {
  const models = ["gemini-3.5-flash", "gemini-3.5-flash-lite"];
  let lastError;
  let useThinkingCfg = true; // turned off automatically if the model rejects it

  const schema = {
    type: "OBJECT",
    properties: {
      title: { type: "STRING" },
      meta_description: { type: "STRING" },
      place_name: { type: "STRING" },
      labels: { type: "ARRAY", items: { type: "STRING" } },
      image_query: { type: "STRING" },
      article: { type: "STRING" },
    },
    required: ["title", "meta_description", "place_name", "labels", "image_query", "article"],
  };

  for (const model of models) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              maxOutputTokens: 32000,
              temperature: 1.0,
              responseMimeType: "application/json",
              responseSchema: schema,
              ...(useThinkingCfg ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
            },
          }),
        }
      );
      const data = await res.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      const text = parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
      if (res.ok && text) {
        return { text, finishReason: data.candidates?.[0]?.finishReason };
      }
      lastError = data;
      if (data.error?.code === 400 && useThinkingCfg && /think/i.test(data.error?.message || "")) {
        useThinkingCfg = false; // model does not accept thinkingConfig, retry without it
        attempt--;
        continue;
      }
      if (data.error?.code === 503 || data.error?.code === 429) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      break; // other error, no point retrying this model
    }
  }
  return { error: lastError };
}

// ---------- IMAGE HELPERS ----------

const escAttr = (s) => String(s || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// Fetch up to `count` landscape photos from Pexels for a search query.
// Returns { images, error } so a failure is never silent.
async function searchPexels(env, query, count, page) {
  try {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=landscape&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: (env.PEXELS_KEY || "").trim() } });
    if (!res.ok) return { images: [], error: `Pexels HTTP ${res.status}` };
    const data = await res.json();
    const images = (data.photos || [])
      .map((p) => ({
        url: p.src?.large2x || p.src?.large || "",
        alt: p.alt || "",
        photographer: p.photographer || "Pexels",
        pageUrl: p.url || "https://www.pexels.com",
      }))
      .filter((i) => i.url);
    return { images, error: null };
  } catch (e) {
    return { images: [], error: `Pexels fetch failed: ${e.message}` };
  }
}

// Re-host a Pexels image on ImgBB (ImgBB downloads it from the URL itself).
// If ImgBB fails, the caller keeps the original Pexels URL so the post never loses its image.
async function uploadToImgBB(env, imageUrl) {
  try {
    const key = (env.IMGBB_KEY || "").trim();
    if (!key) return { url: null, error: "IMGBB_KEY missing" };
    const form = new FormData();
    form.append("image", imageUrl);
    const res = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(key)}`, { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    const url = data?.data?.url || data?.data?.display_url;
    if (!res.ok || !url) return { url: null, error: `ImgBB HTTP ${res.status}` };
    return { url, error: null };
  } catch (e) {
    return { url: null, error: `ImgBB failed: ${e.message}` };
  }
}

async function hostImagesOnImgBB(env, images) {
  let uploaded = 0;
  let lastError = null;
  const hosted = await Promise.all(
    images.map(async (img) => {
      const { url, error } = await uploadToImgBB(env, img.url);
      if (url) { uploaded++; return { ...img, url }; }
      lastError = error;
      return img; // fallback: keep Pexels URL
    })
  );
  return { images: hosted, uploaded, error: lastError };
}

// Try the topic-specific query first, then progressively safer fallbacks,
// so the post always ends up with images.
async function getImagesForPost(env, imageQuery, count) {
  const attempts = [
    { q: imageQuery, page: Math.floor(Math.random() * 2) + 1 },
    { q: imageQuery, page: 1 },
    { q: "nature landscape", page: Math.floor(Math.random() * 10) + 1 },
    { q: "nature landscape", page: 1 },
  ];
  let lastError = null;
  for (const a of attempts) {
    if (!a.q) continue;
    const { images, error } = await searchPexels(env, a.q, count, a.page);
    if (images.length) {
      const hosted = await hostImagesOnImgBB(env, images);
      const host = hosted.uploaded === images.length
        ? "imgbb ok"
        : `imgbb ${hosted.uploaded}/${images.length}${hosted.error ? " (" + hosted.error + ")" : ""}`;
      return { images: hosted.images, status: `ok (query: ${a.q}, ${host})` };
    }
    if (error) lastError = error;
  }
  return { images: [], status: lastError || "no images found" };
}

function figureHtml(img, fallbackAlt) {
  const alt = escAttr(img.alt || fallbackAlt);
  return `<figure style="margin:24px 0;text-align:center;"><img src="${img.url}" alt="${alt}" loading="lazy" style="width:100%;max-width:100%;border-radius:8px;"/><figcaption style="font-size:12px;color:#777;margin-top:6px;">Photo by <a href="${img.pageUrl}" target="_blank" rel="nofollow noopener">${escAttr(img.photographer)}</a> on Pexels</figcaption></figure>`;
}

// Blogger-standard image markup for the FIRST image in the post.
// Blogger and most themes pick the first <img> in the post body as the
// post thumbnail (homepage, label pages, related posts, social previews).
function thumbnailHtml(img, alt) {
  const safeAlt = escAttr(alt || img.alt);
  return `<div class="separator" style="clear:both;text-align:center;margin-bottom:16px;"><a href="${img.url}" style="margin-left:1em;margin-right:1em;"><img border="0" src="${img.url}" alt="${safeAlt}" title="${safeAlt}" style="width:100%;max-width:100%;border-radius:8px;"/></a></div><p style="font-size:12px;color:#777;text-align:center;margin-top:-8px;">Photo by <a href="${img.pageUrl}" target="_blank" rel="nofollow noopener">${escAttr(img.photographer)}</a> on Pexels</p>`;
}

// Insert images after the 2nd, 4th and 6th <h2> section of the article.
function injectInlineImages(articleHtml, images, fallbackAlt) {
  if (!images.length) return articleHtml;
  const sections = articleHtml.split(/(?=<h2)/i);
  const slots = [1, 3, 5];
  let out = "";
  let idx = 0;
  sections.forEach((section, i) => {
    out += section;
    if (slots.includes(i) && idx < images.length) {
      out += figureHtml(images[idx++], fallbackAlt);
    }
  });
  return out;
}

// ---------- MAIN ----------

// Location map for the post.
// 1) With GEOAPIFY_KEY secret: Geoapify geocoding + static map image (free plan, no JS needed).
// 2) Fallback (no key / any error): keyless Google Maps embed.
async function mapHtml(env, placeName) {
  const place = String(placeName || "").trim();
  if (!place) return "";
  const safe = place.replace(/"/g, "");
  const gLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;
  const key = (env.GEOAPIFY_KEY || "").trim();

  if (key) {
    try {
      const geo = await fetch(`https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(place)}&limit=1&format=json&apiKey=${encodeURIComponent(key)}`);
      const gd = await geo.json();
      const r = gd.results && gd.results[0];
      if (geo.ok && r && typeof r.lat === "number" && typeof r.lon === "number") {
        const img = `https://maps.geoapify.com/v1/staticmap?style=osm-bright&width=800&height=420&center=lonlat:${r.lon},${r.lat}&zoom=9&marker=lonlat:${r.lon},${r.lat};type:awesome;color:%23e53935;size:large&apiKey=${encodeURIComponent(key)}`;
        return `<h2>Location Map: ${safe}</h2><div style="margin:20px 0;text-align:center"><a href="${gLink}" target="_blank" rel="noopener"><img src="${img}" alt="Map of ${safe}" style="width:100%;max-width:800px;border-radius:10px" loading="lazy"></a><p><a href="${gLink}" target="_blank" rel="noopener">Open ${safe} in Google Maps</a></p></div>`;
      }
    } catch (e) {}
  }

  const src = `https://maps.google.com/maps?q=${encodeURIComponent(place)}&output=embed`;
  return `<h2>Location Map: ${safe}</h2><div style="margin:20px 0"><iframe width="100%" height="380" style="border:0;border-radius:10px" loading="lazy" allowfullscreen referrerpolicy="no-referrer-when-downgrade" src="${src}" title="Map of ${safe}"></iframe></div>`;
}

// ---------- NO-REPEAT HELPERS ----------

const REGIONS = [
  "Kerala", "Karnataka", "Tamil Nadu", "Andhra Pradesh", "Telangana", "Maharashtra", "Goa", "Gujarat",
  "Rajasthan", "Madhya Pradesh", "Chhattisgarh", "Odisha", "West Bengal", "Sikkim", "Assam", "Meghalaya",
  "Arunachal Pradesh", "Nagaland", "Manipur", "Mizoram", "Tripura", "Uttarakhand", "Himachal Pradesh",
  "Jammu and Kashmir", "Ladakh", "Jharkhand", "Bihar", "Uttar Pradesh", "Andaman and Nicobar",
];
const ANGLES = [
  "hidden history and legends", "trekking and adventure guide", "budget travel plan", "best season and weather guide",
  "photography spots and sunrise views", "family trip itinerary", "local culture and food nearby", "offbeat facts most tourists miss",
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function getBloggerToken(env) {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, refresh_token: env.REFRESH_TOKEN, grant_type: "refresh_token" })
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(tokenData)}`);
  }
  return tokenData.access_token;
}

// Titles already published on this blog (read straight from Blogger, no KV needed).
async function getRecentTitles(env, accessToken) {
  try {
    const res = await fetch(
      `https://www.googleapis.com/blogger/v3/blogs/${env.BLOG_ID}/posts?fetchBodies=false&maxResults=100&fields=items(id,title,url,labels)`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return [];
    const d = await res.json();
    return (d.items || []).filter((p) => p.title && p.url);
  } catch (e) {
    return [];
  }
}

// Auto internal links: "Read More" block with the most relevant older posts
// (same labels first, then random fill). Links come from Blogger itself, so they are always real.
function relatedPostsHtml(existing, newLabels, count) {
  if (!existing.length) return "";
  const want = new Set((newLabels || []).map((l) => String(l).toLowerCase()));
  const scored = existing.map((p) => ({
    p,
    score: (p.labels || []).filter((l) => want.has(String(l).toLowerCase())).length + Math.random() * 0.5,
  }));
  scored.sort((a, b) => b.score - a.score);
  const chosen = scored.slice(0, count).map((x) => x.p);
  const items = chosen
    .map((p) => `<li style="margin:6px 0;"><a href="${p.url}">${escAttr(p.title)}</a></li>`)
    .join("");
  return `<h2>Read More Nature &amp; Travel Guides</h2><ul>${items}</ul>`;
}

// Two-way linking: add the NEW post's link into 2 related OLD posts
// (inside a small "Latest from our blog" box, newest first, max 3 links per box).
async function backlinkOldPosts(env, accessToken, existing, newLabels, newTitle, newUrl) {
  const done = [];
  try {
    if (!newUrl || !existing.length) return done;
    const want = new Set((newLabels || []).map((l) => String(l).toLowerCase()));
    const targets = existing
      .filter((p) => p.id)
      .map((p) => ({ p, score: (p.labels || []).filter((l) => want.has(String(l).toLowerCase())).length + Math.random() * 0.5 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((x) => x.p);

    const newLi = `<li style="margin:6px 0;"><a href="${newUrl}">${escAttr(newTitle)}</a></li>`;
    for (const t of targets) {
      try {
        const base = `https://www.googleapis.com/blogger/v3/blogs/${env.BLOG_ID}/posts/${t.id}`;
        const auth = { Authorization: `Bearer ${accessToken}` };
        const gr = await fetch(`${base}?fields=content`, { headers: auth });
        if (!gr.ok) continue;
        const content = (await gr.json()).content || "";
        if (content.includes(newUrl)) continue;

        const boxRe = /<div class="latest-links"[^>]*>[\s\S]*?<\/div>/i;
        const m = content.match(boxRe);
        let oldLis = [];
        if (m) oldLis = m[0].match(/<li[\s\S]*?<\/li>/gi) || [];
        const lis = [newLi, ...oldLis].slice(0, 3).join("");
        const box = `<div class="latest-links" style="margin-top:28px;padding:14px;border:1px solid #ddd;border-radius:8px;"><h3 style="margin-top:0;">Latest from our blog</h3><ul>${lis}</ul></div>`;
        const updated = m ? content.replace(boxRe, box) : content + box;

        const pr = await fetch(base, {
          method: "PATCH",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({ content: updated }),
        });
        if (pr.ok) done.push(t.title);
      } catch (e) {}
    }
  } catch (e) {}
  return done;
}

// True if the new place/title is already covered by an existing post title.
function isDuplicate(parsed, usedTitles) {
  const place = String(parsed.place_name || "").split(",")[0].trim().toLowerCase();
  const title = String(parsed.title || "").trim().toLowerCase();
  return usedTitles.some((t) => {
    const u = String(t).toLowerCase();
    return u === title || (place.length > 3 && u.includes(place));
  });
}

async function generateAndPublish(env, topicTitle) {
  try {
    // 0) Blogger token + already-published titles (so Gemini never repeats a place).
    const accessToken = await getBloggerToken(env);
    const existingPosts = await getRecentTitles(env, accessToken);
    const usedTitles = existingPosts.map((p) => p.title);
    const avoid = [];

    // 1) Write the article first, so Gemini can also tell us what photos to search for.
    let parsed;
    let lastInfo = "";
    for (let tryNo = 1; tryNo <= 3; tryNo++) {
      const region = pick(REGIONS);
      const angle = pick(ANGLES);
      const seed = Math.floor(Math.random() * 1000000);
      const extra = `\n\nIMPORTANT - AVOID REPEATS: These posts are already published, so you MUST choose a DIFFERENT place (not one of these, and not the same place with a new title):\n${[...usedTitles, ...avoid].slice(0, 120).join(" | ") || "(none yet)"}\nPick a lesser-known place, preferably around: ${region} (ignore this hint if the topic says outside India). Writing angle: ${angle}. Variation seed: ${seed}.`;

      const prompt = `Based on this topic: "${topicTitle}", write a nature/travel blog post.${extra} Return STRICT JSON only, no extra text, no markdown fences: {"title": "SEO-friendly catchy title under 70 characters", "meta_description": "SEO meta description under 160 characters", "place_name": "the exact main place or destination name with state and country for a Google Maps search, e.g. Ziro Valley, Arunachal Pradesh, India", "labels": ["4 to 5 short SEO keyword labels, e.g. Waterfalls, India Travel, Trekking"], "image_query": "a 2 to 4 word English stock-photo search phrase describing the main scenery of this topic, using generic visual words only (e.g. 'himalayan valley', 'forest waterfall', 'tropical beach cliff'), no place names", "article": "A complete, detailed English blog article of at least 2000 words (aim for 2000-2300) in HTML format. Use at least 8 <h2> sections covering: introduction, location and how to reach, best time to visit, top attractions (with several <h3> items), things to do, local culture and food, where to stay, budget and packing tips, safety and responsible travel, and a conclusion. Do not stop early or summarize. Write in an engaging, descriptive tone."}`;

      const g = await callGeminiWithRetry(env, prompt);
      if (!g.text) {
        throw new Error(`Gemini returned no content: ${JSON.stringify(g.error)}`);
      }
      // Cut-off answer (token limit etc.) -> try again instead of parsing half JSON.
      if (g.finishReason && g.finishReason !== "STOP") {
        lastInfo = `finish=${g.finishReason} (answer cut off), len=${g.text.length}`;
        continue;
      }
      const raw = g.text.replace(/```json|```/g, "").trim();
      let candidate;
      try {
        candidate = JSON.parse(raw);
      } catch (e) {
        lastInfo = `finish=${g.finishReason}, len=${raw.length}, start=${raw.slice(0, 150)}, END=${raw.slice(-200)}`;
        continue;
      }
      if (!candidate.article || !candidate.title) {
        lastInfo = "missing fields";
        continue;
      }
      if (isDuplicate(candidate, usedTitles)) {
        avoid.push(`${candidate.title} (${candidate.place_name})`);
        lastInfo = `duplicate place: ${candidate.place_name}`;
        continue;
      }
      parsed = candidate;
      break;
    }
    if (!parsed) {
      throw new Error(`Could not get a valid NEW article after 3 tries: ${lastInfo}`);
    }

    // 2) Fetch topic-matched images (1 hero + up to 3 inline).
    const { images, status: imageStatus } = await getImagesForPost(env, parsed.image_query, 4);
    const safeTitle = String(parsed.title).replace(/"/g, "");
    const hero = images[0];
    const inlineImages = images.slice(1);

    // 4) Build post: hero image on top, inline images inside the article.
    const labels = Array.isArray(parsed.labels) ? parsed.labels.slice(0, 5) : ["Nature", "Travel"];
    const heroHtml = hero ? thumbnailHtml(hero, safeTitle) : "";
    const articleWithImages = injectInlineImages(parsed.article, inlineImages, safeTitle);

    const postBody = {
      kind: "blogger#post",
      title: parsed.title,
      labels: labels,
      searchDescription: String(parsed.meta_description).slice(0, 150),
      content: heroHtml + `<p><em>${parsed.meta_description}</em></p>` + articleWithImages + relatedPostsHtml(existingPosts, labels, 4) + (await mapHtml(env, parsed.place_name)),
    };

    const publishRes = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${env.BLOG_ID}/posts/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(postBody)
    });
    const publishData = await publishRes.json();
    if (!publishRes.ok) {
      throw new Error(`Blogger publish failed: ${JSON.stringify(publishData)}`);
    }

    const backlinked = await backlinkOldPosts(env, accessToken, existingPosts, labels, parsed.title, publishData.url);

    return new Response(JSON.stringify({
      status: "success",
      published_title: parsed.title,
      post_url: publishData.url || "check Blogger dashboard",
      images_used: images.length,
      image_status: imageStatus,
      backlinked_old_posts: backlinked,
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ status: "error", error: err.message }, null, 2), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
