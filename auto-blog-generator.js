export default {
  async fetch(request, env) {
    return await generateAndPublish(env);
  },

  async scheduled(event, env, ctx) {
    await generateAndPublish(env);
  }
}

async function generateAndPublish(env) {
  try {
    // Step 1: Fetch nature/travel related news for topic inspiration
    const newsRes = await fetch(`https://gnews.io/api/v4/search?q=natural+wonders+travel+destination&lang=en&token=${env.GNEWS_KEY}`);
    const newsData = await newsRes.json();
    const topicNews = newsData.articles[0];
    const topicTitle = topicNews.title;

    // Step 2: Fetch a matching nature image from Pexels
    const imgRes = await fetch(`https://api.pexels.com/v1/search?query=nature+landscape&per_page=1`, {
      headers: { Authorization: env.PEXELS_KEY }
    });
    const imgData = await imgRes.json();
    const imageUrl = imgData.photos?.[0]?.src?.large || "";

    // Step 3: Generate title, meta description, and full article using Gemini
    const prompt = `Based on this topic: "${topicTitle}", write a nature/travel blog post. Return STRICT JSON only, no extra text:
{
  "title": "SEO-friendly catchy title under 70 characters",
  "meta_description": "SEO meta description under 160 characters",
  "article": "A complete 2000-word English blog article in HTML format with <h2> subheadings, covering location details, best time to visit, attractions, travel tips, and a conclusion. Write in an engaging, descriptive tone."
}`;

    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 8000 }
      })
    });
    const geminiData = await geminiRes.json();
    let rawText = geminiData.candidates[0].content.parts[0].text;
    rawText = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(rawText);

    // Step 4: Get fresh Blogger access token using refresh token
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.CLIENT_ID,
        client_secret: env.CLIENT_SECRET,
        refresh_token: env.REFRESH_TOKEN,
        grant_type: "refresh_token"
      })
    });
    const tokenData = await tokenRes.json();

    // Step 5: Publish the post to Blogger
    const postBody = {
      kind: "blogger#post",
      title: parsed.title,
      content: `<img src="${imageUrl}" style="width:100%;border-radius:8px;"/><br><br>${parsed.article}`,
      searchDescription: parsed.meta_description
    };

    const publishRes = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${env.BLOG_ID}/posts/`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(postBody)
    });
    const publishData = await publishRes.json();

    return new Response(JSON.stringify({
      status: "success",
      published_title: parsed.title,
      post_url: publishData.url || "check Blogger dashboard"
    }, null, 2), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ er
