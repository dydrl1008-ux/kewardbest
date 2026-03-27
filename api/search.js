export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const naverClientId     = process.env.NAVER_CLIENT_ID;
  const naverClientSecret = process.env.NAVER_CLIENT_SECRET;
  const elevenApiKey      = process.env.ELEVENTH_API_KEY;

  const { keyword, pages = 1 } = req.body;
  if (!keyword) return res.status(400).json({ error: 'keyword required' });

  const results = { titles: [], category: null, sources: [] };

  // ── 네이버 쇼핑 ──
  if (naverClientId && naverClientSecret) {
    try {
      const naverTitles = [];
      let naverCategory = null;
      const pageSize = 100;

      for (let page = 1; page <= Math.min(pages, 10); page++) {
        const start = (page - 1) * pageSize + 1;
        const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(keyword)}&display=${pageSize}&start=${start}&sort=sim`;
        const r = await fetch(url, {
          headers: {
            'X-Naver-Client-Id': naverClientId,
            'X-Naver-Client-Secret': naverClientSecret,
          },
        });
        if (!r.ok) break;
        const data = await r.json();
        if (!data.items || data.items.length === 0) break;

        data.items.forEach(item => {
          const title = item.title.replace(/<[^>]*>/g, '').trim();
          if (title) naverTitles.push(title);

          // 첫 번째 상품의 카테고리 추출 (가장 정밀한 카테고리)
          if (!naverCategory && item.category4) {
            naverCategory = [item.category1, item.category2, item.category3, item.category4]
              .filter(Boolean).join(' > ');
          } else if (!naverCategory && item.category3) {
            naverCategory = [item.category1, item.category2, item.category3]
              .filter(Boolean).join(' > ');
          } else if (!naverCategory && item.category1) {
            naverCategory = [item.category1, item.category2]
              .filter(Boolean).join(' > ');
          }
        });
      }

      results.titles.push(...naverTitles);
      results.sources.push(`네이버 ${naverTitles.length}개`);
      if (naverCategory) results.category = naverCategory;

    } catch (e) {
      console.error('Naver error:', e.message);
    }
  }

  // ── 11번가 ──
  if (elevenApiKey) {
    try {
      const elevenTitles = [];
      const perPage = Math.min(pages * 20, 100); // 11번가는 페이지당 최대 20개 기준
      const url = `http://openapi.11st.co.kr/openapi/OpenApiService.tmall?key=${elevenApiKey}&apiCode=ProductSearch&keyword=${encodeURIComponent(keyword)}&pageSize=${perPage}&pageNum=1`;

      const r = await fetch(url);
      if (r.ok) {
        const xml = await r.text();
        // XML에서 상품명 추출 (productName 태그)
        const matches = xml.match(/<productName>(.*?)<\/productName>/g) || [];
        matches.forEach(m => {
          const title = m.replace(/<\/?productName>/g, '').trim();
          if (title) elevenTitles.push(title);
        });
      }

      results.titles.push(...elevenTitles);
      results.sources.push(`11번가 ${elevenTitles.length}개`);

    } catch (e) {
      console.error('11st error:', e.message);
    }
  }

  return res.status(200).json(results);
}
