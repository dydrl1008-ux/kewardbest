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
  const mainKw        = mainKeyword || productTokens[0] || '';
  const categoryStr   = category || '미확인';

  // 경쟁사 상품명 샘플 (참고용)
  const titleSample = titles.slice(0, 30).join('\n');

  // ── 키워드 프롬프트 ──
  const kwPrompt = `당신은 네이버 쇼핑 상품명 SEO 전문가입니다.

[내 상품]
- 상품명: "${productName}"
- 메인키워드: "${mainKw}"
- 카테고리: ${categoryStr}

[경쟁사 상품명 샘플 (참고용 - 트렌드 파악만)]
${titleSample}

━━━━━━━━━━━━━━━━━━━━━
[STEP 1] 상품 분석
위 상품명을 보고 아래를 파악하세요:
- 이 상품이 정확히 무엇인지
- 상품명에 이미 있는 모든 단어/의미 목록
- 브랜드명, 모델명 식별

[STEP 2] 추가 키워드 생성
이 상품을 사려는 소비자가 검색할 만한 키워드 ${kwCount}개를 생성하세요.

[절대 금지 - 하나라도 어기면 실패]
1. 상품명에 이미 있는 단어 금지 (표기만 다른 유사어도 금지)
   - 예) "돌쇼파" 있으면 → "돌소파", "석재소파", "흙소파", "돌카우치" 전부 금지
   - 예) "무선" 있으면 → "코드리스", "와이어리스" 금지
2. 메인키워드("${mainKw}") 및 그 유사어/합성어 금지
3. 브랜드명, 업체명, 모델번호 금지
4. 구매의도 없는 단어 금지: 추천, 후기, 리뷰, 인기, 최저가, 할인, 특가
5. 이 상품과 직접 관련 없는 단어 금지
   - 예) 돌소파면 → 맥반석, 참숯, 게르마늄, 편백 같은 재료명 단독으로 금지
   - 예) 미역국이면 → 톳, 다시마, 된장 금지

[추가 가능한 키워드 유형]
- 이 상품의 용도/장소: 거실용, 베란다용, 사무실용 등
- 구매 대상: 노인용, 1인용, 커플용 등  
- 상품 특징 중 아직 미표기된 것: 방수, 접이식, 높이조절 등
- 사이즈/수량 관련: 대형, 소형, 세트 등

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
이 상품 구매자가 "${mainKw}" 검색 전에 입력할 사전 탐색 키워드 ${acqCount}개.

예시: 메인키워드 "돌소파" → "거실소파추천", "온열소파", "천연소재소파"

[규칙]
1. 메인키워드("${mainKw}") 자체 및 유사어, 합성어 절대 금지
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
          system: '네이버 쇼핑 SEO 전문가. 요청한 JSON만 출력. 설명 절대 없음.',
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

    // JS단 보조 필터
    const prodNorms = new Set(productTokens.map(w => w.toLowerCase()));
    const mainNorm  = mainKw.toLowerCase().replace(/\s/g, '');
    const NO_INTENT = new Set(['추천','후기','리뷰','비교','순위','인기','베스트',
                               '최저가','할인','특가','이벤트','쿠폰','정품','공식']);

    keywords = keywords.filter(w => {
      const wn = w.toLowerCase().replace(/\s/g, '');
      if (prodNorms.has(w.toLowerCase())) return false;
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
