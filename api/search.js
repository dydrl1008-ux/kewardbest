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
      const allItems = [];
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
        allItems.push(...data.items);
      }

      if (allItems.length === 0) {
        results.sources.push('네이버 0개');
      } else {
        // 1. 상위 상품에서 기준 카테고리 결정 (가장 많이 나오는 카테고리)
        const catFreq = {};
        allItems.forEach(item => {
          const cat = [item.category1, item.category2, item.category3]
            .filter(Boolean).join('>');
          if (cat) catFreq[cat] = (catFreq[cat] || 0) + 1;
        });

        // 최빈 카테고리 = 기준 카테고리
        const baseCategory = Object.entries(catFreq)
          .sort((a, b) => b[1] - a[1])[0]?.[0] || '';

        const [baseCat1, baseCat2, baseCat3] = baseCategory.split('>');

        // 2. 기준 카테고리와 같은 상품만 필터링 (category1+2 일치)
        const filtered = allItems.filter(item => {
          if (!baseCat1) return true;
          if (item.category1 !== baseCat1) return false;
          if (baseCat2 && item.category2 !== baseCat2) return false;
          return true;
        });

        // 3. 필터링된 상품명만 수집
        const naverTitles = filtered.map(item =>
          item.title.replace(/<[^>]*>/g, '').trim()
        ).filter(Boolean);

        // 4. 카테고리 문자열 (4단계까지)
        const repItem = filtered[0] || allItems[0];
        const naverCategory = [repItem.category1, repItem.category2, repItem.category3, repItem.category4]
          .filter(Boolean).join(' > ');

        results.titles.push(...naverTitles);
        results.category = naverCategory;
        results.sources.push(`네이버 ${naverTitles.length}개 (전체 ${allItems.length}개 중 카테고리 필터)`);
      }

    } catch (e) {
      console.error('Naver error:', e.message);
    }
  }

  // ── 11번가 ──
  if (elevenApiKey) {
    try {
      const elevenTitles = [];
      const perPage = Math.min(pages * 20, 100);
      const url = `http://openapi.11st.co.kr/openapi/OpenApiService.tmall?key=${elevenApiKey}&apiCode=ProductSearch&keyword=${encodeURIComponent(keyword)}&pageSize=${perPage}&pageNum=1`;

      const r = await fetch(url);
      if (r.ok) {
        const xml = await r.text();
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
