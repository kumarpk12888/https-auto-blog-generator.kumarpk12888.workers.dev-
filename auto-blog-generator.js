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

async function generateAndPublish(env, topicTitle) {
  try {

    const imgRes = await fetch(`https://api.pexels.com/v1/search?query=nature+landscape&per_page=1&page=${Math.floor(Math.random() * 40) + 1}`, { headers: { Authorization: env.PEXELS_KEY } });
    const imgData = await imgRes.json();
    const imageUrl = imgData.photos?.[0]?.src?.large || "";

    const prompt = `Based on this topic: "${topicTitle}", write a nature/travel blog post. Return STRICT JSON only, no extra text, no markdown fences: {"title": "SEO-friendly catchy title under 70 characters", "meta_description": "SEO meta description under 160 characters", "labels": ["4 to 5 short SEO keyword labels, e.g. Waterfalls, India Travel, Trekking"], "article": "A complete, detailed English blog article of at least 2000 words (aim for 2000-2300) in HTML format. Use at least 8 <h2> sections covering: introduction, location and how to reach, best time to visit, top attractions (with several <h3> items), things to do, local culture and food, where to stay, budget and packing tips, safety and responsible travel, and a conclusion. Do not stop early or summarize. Write in an engaging, descriptive tone."}`;

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

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, refresh_token: env.REFRESH_TOKEN, grant_type: "refresh_token" })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      throw new Error(`Token refresh failed: ${JSON.stringify(tokenData)}`);
    }

    const safeAlt = String(parsed.title).replace(/"/g, "");
    const labels = Array.isArray(parsed.labels) ? parsed.labels.slice(0, 5) : ["Nature", "Travel"];
    const postBody = {
      kind: "blogger#post",
      title: parsed.title,
      labels: labels,
      searchDescription: String(parsed.meta_description).slice(0, 150),
      content: (imageUrl ? `<img src="${imageUrl}" alt="${safeAlt}" style="width:100%;border-radius:8px;"/><br><br>` : "") + `<p><em>${parsed.meta_description}</em></p>` + parsed.article,
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

    return new Response(JSON.stringify({ status: "success", published_title: parsed.title, post_url: publishData.url || "check Blogger dashboard" }, null, 2), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ status: "error", error: err.message }, null, 2), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
