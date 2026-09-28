const POSTS_PER_CRON_RUN = 3;

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

// Gemini sometimes returns 503 (temporary overload). Retry a few times
// with a short delay, and fall back to the lighter flash-lite model if
// the main flash model keeps failing.
async function callGeminiWithRetry(env, prompt) {
  const models = ["gemini-3.5-flash", "gemini-3.5-flash-lite"];
  let lastError;

  for (const model of models) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 16000 } }),
        }
      );
      const data = await res.json();
      if (res.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
        return data;
      }
      lastError = data;
      if (data.error?.code === 503) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      break; // non-503 error, no point retrying this model
    }
  }
  return lastError;
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

async function generateAndPublish(env, topicTitle) {
  try {
    // 1) Write the article first, so Gemini can also tell us what photos to search for.
    const prompt = `Based on this topic: "${topicTitle}", write a nature/travel blog post. Return STRICT JSON only, no extra text, no markdown fences: {"title": "SEO-friendly catchy title under 70 characters", "meta_description": "SEO meta description under 160 characters", "labels": ["4 to 5 short SEO keyword labels, e.g. Waterfalls, India Travel, Trekking"], "image_query": "a 2 to 4 word English stock-photo search phrase describing the main scenery of this topic, using generic visual words only (e.g. 'himalayan valley', 'forest waterfall', 'tropical beach cliff'), no place names", "article": "A complete, detailed English blog article of at least 2000 words (aim for 2000-2300) in HTML format. Use at least 8 <h2> sections covering: introduction, location and how to reach, best time to visit, top attractions (with several <h3> items), things to do, local culture and food, where to stay, budget and packing tips, safety and responsible travel, and a conclusion. Do not stop early or summarize. Write in an engaging, descriptive tone."}`;

    const geminiData = await callGeminiWithRetry(env, prompt);
    const candidate = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!candidate) {
      throw new Error(`Gemini returned no content: ${JSON.stringify(geminiData)}`);
    }
    let rawText = candidate.replace(/```json|```/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      throw new Error(`Failed to parse Gemini JSON: ${rawText.slice(0, 500)}`);
    }

    // 2) Fetch topic-matched images (1 hero + up to 3 inline).
    const { images, status: imageStatus } = await getImagesForPost(env, parsed.image_query, 4);
    const safeTitle = String(parsed.title).replace(/"/g, "");
    const hero = images[0];
    const inlineImages = images.slice(1);

    // 3) Blogger access token.
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, refresh_token: env.REFRESH_TOKEN, grant_type: "refresh_token" })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      throw new Error(`Token refresh failed: ${JSON.stringify(tokenData)}`);
    }

    // 4) Build post: hero image on top, inline images inside the article.
    const labels = Array.isArray(parsed.labels) ? parsed.labels.slice(0, 5) : ["Nature", "Travel"];
    const heroHtml = hero ? thumbnailHtml(hero, safeTitle) : "";
    const articleWithImages = injectInlineImages(parsed.article, inlineImages, safeTitle);

    const postBody = {
      kind: "blogger#post",
      title: parsed.title,
      labels: labels,
      searchDescription: String(parsed.meta_description).slice(0, 150),
      content: heroHtml + `<p><em>${parsed.meta_description}</em></p>` + articleWithImages,
    };

    const publishRes = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${env.BLOG_ID}/posts/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenData.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(postBody)
    });
    const publishData = await publishRes.json();
    if (!publishRes.ok) {
      throw new Error(`Blogger publish failed: ${JSON.stringify(publishData)}`);
    }

    return new Response(JSON.stringify({
      status: "success",
      published_title: parsed.title,
      post_url: publishData.url || "check Blogger dashboard",
      images_used: images.length,
      image_status: imageStatus,
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ status: "error", error: err.message }, null, 2), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
