export default {
  async fetch(request, env) {
    return await generateAndPublish(env);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(generateAndPublish(env));
  }
}

async function generateAndPublish(env) {
  try {
    const newsRes = await fetch(`https://gnews.io/api/v4/search?q=natural+wonders+travel+destination&lang=en&token=${env.GNEWS_KEY}`);
    const newsData = await newsRes.json();
    if (!newsData.articles || newsData.articles.length === 0) {
      throw new Error(`GNews returned no articles: ${JSON.stringify(newsData)}`);
    }
    const topicNews = newsData.articles[Math.floor(Math.random() * newsData.articles.length)];
    const topicTitle = topicNews.title;

    const imgRes = await fetch(`https://api.pexels.com/v1/search?query=nature+landscape&per_page=1`, { headers: { Authorization: env.PEXELS_KEY } });
    const imgData = await imgRes.json();
    const imageUrl = imgData.photos?.[0]?.src?.large || "";

    const prompt = `Based on this topic: "${topicTitle}", write a nature/travel blog post. Return STRICT JSON only, no extra text, no markdown fences: {"title": "SEO-friendly catchy title under 70 characters", "meta_description": "SEO meta description under 160 characters", "article": "A complete 1200-1500 word English blog article in HTML format with <h2> subheadings, covering location details, best time to visit, attractions, travel tips, and a conclusion. Write in an engaging, descriptive tone."}`;

    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 8000 } })
    });
    const geminiData = await geminiRes.json();
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

    const postBody = {
      kind: "blogger#post",
      title: parsed.title,
      content: imageUrl ? `<img src="${imageUrl}" style="width:100%;border-radius:8px;"/><br><br>${parsed.article}` : parsed.article,
      searchDescription: parsed.meta_description
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
