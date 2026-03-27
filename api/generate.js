export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Anthropic API key not configured' });

  const { productName, mainKeyword, titles, category, kwCount = 5, acqCount = 30 } = req.body;
  if (!productName || !titles) return res.status(400).json({ error: 'productName, titles required' });

  const tokenize = (str) =>
    (str || '').replace(/[^\uAC00-\uD7A3a-zA-Z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 2);

  const productTokens = tokenize(productName);
  const mainTokens    = tokenize(mainKeyword);
  const allExisting   = [...new Set([...productTokens, ...mainTokens])];
  const mainKw        = mainKeyword || productTokens[0] || '';
  const categoryStr   = category || '미확인';

  // 빈도 분석
  const freq = {};
  titles.forEach(title => {
    title.replace(/<[^>]*>/g, '').split(/\s+/).forEach(w => {
      const clean = w.replace(/[^\uAC00-\uD7A3a-zA-Z0-9]/g, '');
      if (clean.length >= 2) {
        const lower = clean.toLowerCase();
        if (!allExisting.some(e => e.toLowerCase() === lower))
          freq[clean] = (freq[clean] || 0) + 1;
      }
    });
  });

  const topFreq = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 80)
    .map(([w, c]) => `${w}(${c})`)
    .join(', ');

  // ── 키워드 프롬프트 ──
  const kwPrompt = `당신은 네이버 쇼핑 상품명 SEO 전문가입니다.

[내 상품 정보]
- 상품명: "${productName}"
- 메인키워드: "${mainKw}"
- 카테고리: ${categoryStr}

[경쟁사 고빈도 단어 (${titles.length}개 분석)]
${topFreq}

[임무]
내 상품명에 추가할 키워드 정확히 ${kwCount}개를 골라주세요.

[제거 기준 - 엄격히 적용]
1. 브랜드명 제거: 상품명에 있는 고유 브랜드/업체명 (예: "스페이스집", "레인보우", "삼성" 등 고유명사)
2. 의미 중복 제거: 상품명에 이미 있는 단어와 뜻이 같거나 유사한 단어
   - 예) 상품명에 "돌쇼파" 있으면 → "돌소파", "석재소파", "흙소파" 전부 제거
   - 예) 상품명에 "무선" 있으면 → "코드리스", "와이어리스" 제거
3. 메인키워드 중복 제거: 메인키워드("${mainKw}") 자체 및 유사어, 합성어 전부 제거
4. 구매의도 없는 단어 제거: 추천, 후기, 리뷰, 인기, 순위, 최저가, 할인, 특가, 브랜드
5. 카테고리 무관 단어 제거: "${categoryStr}" 와 직접 관련 없는 단어
   - 같은 대분류여도 다른 세부 상품이면 제거

[추출 기준]
- 소비자가 네이버 쇼핑에서 실제로 검색하는 단어
- 내 상품의 용도, 재질, 대상, 특징, 사이즈 관련 단어
- 단독 명사만 (2~6글자)
- 고빈도 단어 우선

[출력]
JSON만. 설명/마크다운 없이:
{"keywords": ["단어1", "단어2", ...]}`;

  // ── ACQ 프롬프트 ──
  const acqPrompt = `당신은 네이버 쇼핑 검색 행동 전문가입니다.

[상품 정보]
- 상품명: "${productName}"
- 메인키워드: "${mainKw}"
- 카테고리: ${categoryStr}

[요청]
이 상품을 구매하려는 소비자가 "${mainKw}"를 검색하기 전에 먼저 입력할 사전 탐색 키워드(ACQ) ${acqCount}개 추출.

예시: 메인키워드 "무선선풍기" → "선풍기추천", "거실선풍기", "저소음선풍기"

[규칙]
1. 메인키워드("${mainKw}") 자체 및 유사어, 포함 합성어 절대 금지
2. 이 상품 카테고리 안에서만
3. 실제 소비자 탐색 패턴 기반
4. 1~4 어절 이내

[출력]
JSON만:
{"acq": ["키워드1", "키워드2", ...]}`;

  try {
    const callClaude = (prompt, maxTokens) =>
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-5',
          max_tokens: maxTokens,
          system: '네이버 쇼핑 SEO 전문가. 요청한 JSON만 출력. 설명 없음.',
          messages: [{ role: 'user', content: prompt }],
        }),
      }).then(r => r.json());

    const [kwData, acqData] = await Promise.all([
      callClaude(kwPrompt, 500),
      callClaude(acqPrompt, 1000),
    ]);

    const parseKey = (data, key) => {
      try {
        const text  = (data.content || []).map(c => c.text || '').join('');
        const clean = text.replace(/```json|```/g, '').trim();
        return JSON.parse(clean)[key] || [];
      } catch { return []; }
    };

    let keywords = parseKey(kwData, 'keywords');
    let acq      = parseKey(acqData, 'acq');

    // JS단 필터: 중복 + 메인키워드 합성어 + 구매의도 없는 단어
    const existingNorms = new Set(allExisting.map(w => w.toLowerCase()));
    const mainNorm      = mainKw.toLowerCase().replace(/\s/g, '');
    const NO_INTENT     = new Set(['추천','후기','리뷰','비교','순위','인기','베스트',
                                    '최저가','할인','특가','이벤트','쿠폰','정품','공식']);

    keywords = keywords.filter(w => {
      const wn = w.toLowerCase().replace(/\s/g, '');
      if (existingNorms.has(wn)) return false;
      if (mainNorm.length >= 2 && wn.includes(mainNorm)) return false;
      if (NO_INTENT.has(w)) return false;
      return true;
    });

    acq = acq.filter(w => {
      const wn = w.toLowerCase().replace(/\s/g, '');
      return !(mainNorm.length >= 2 && wn.includes(mainNorm));
    });

    return res.status(200).json({ keywords, acq });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
