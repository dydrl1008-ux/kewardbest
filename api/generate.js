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

  const mainKw      = mainKeyword || '';
  const categoryStr = category || '미확인';

  // ── 유틸: 한글 자모 분해 (유사어 감지용) ──
  const decomposeHangul = (str) => {
    const CHOSUNGS = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
    let result = '';
    for (const ch of str) {
      const code = ch.charCodeAt(0) - 0xAC00;
      if (code >= 0 && code <= 11171) {
        result += CHOSUNGS[Math.floor(code / 588)];
      } else {
        result += ch;
      }
    }
    return result;
  };

  // ── 초성 기반 유사도 체크 ──
  const isSimilar = (a, b) => {
    const na = a.replace(/\s/g, '').toLowerCase();
    const nb = b.replace(/\s/g, '').toLowerCase();
    if (na === nb) return true;
    // 한쪽이 다른 쪽을 포함
    if (na.includes(nb) || nb.includes(na)) return true;
    // 초성 비교
    const ca = decomposeHangul(na);
    const cb = decomposeHangul(nb);
    if (ca === cb) return true;
    return false;
  };

  // ── 상품명 토큰 추출 ──
  const tokenize = (str) =>
    (str || '').replace(/[^\uAC00-\uD7A3a-zA-Z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 2);

  const productTokens = tokenize(productName);
  const mainTokens    = tokenize(mainKw);
  const allTokens     = [...new Set([...productTokens, ...mainTokens])];

  // ── 블랙리스트 ──
  const BLACKLIST = new Set([
    '추천','후기','리뷰','비교','순위','인기','베스트','최저가','할인','특가',
    '이벤트','쿠폰','정품','공식','신상','한정','품절','무료','선물','구매',
    '배송','당일','익일','정가','판매','브랜드','국내','해외','수입','정식',
  ]);

  // ── 브랜드명 패턴 감지 (숫자 포함 고유명사) ──
  const isBrand = (word) => {
    // 숫자+한글 조합 (예: 202, 3인용 제외하고 모델명 같은 것)
    if (/^[A-Za-z]+\d+$/.test(word)) return true;
    if (/^\d+[A-Za-z]+$/.test(word)) return true;
    return false;
  };

  // ── 경쟁사 상품명에서 단어 추출 + JS 필터링 ──
  const freq = {};
  titles.forEach(title => {
    const clean = title.replace(/<[^>]*>/g, '');
    const words = clean.split(/\s+/).map(w => w.replace(/[^\uAC00-\uD7A3a-zA-Z0-9]/g, '')).filter(w => w.length >= 2);

    words.forEach(word => {
      // 1. 블랙리스트 제거
      if (BLACKLIST.has(word)) return;
      // 2. 브랜드명 패턴 제거
      if (isBrand(word)) return;
      // 3. 상품명/메인키워드 단어와 유사한 것 제거
      if (allTokens.some(t => isSimilar(word, t))) return;
      // 4. 너무 짧거나 긴 단어 제거
      if (word.length < 2 || word.length > 7) return;
      // 5. 숫자만인 단어 제거
      if (/^\d+$/.test(word)) return;

      freq[word] = (freq[word] || 0) + 1;
    });
  });

  // 빈도 상위 후보군 (kwCount * 5배 = AI가 고를 풀)
  const candidates = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, kwCount * 5)
    .map(([w]) => w);

  if (candidates.length === 0) {
    return res.status(200).json({ keywords: [], acq: [] });
  }

  // ── AI: 후보 중에서 선택만 (생성 X) ──
  const kwPrompt = `당신은 네이버 쇼핑 SEO 전문가입니다.

[내 상품]
- 상품명: "${productName}"
- 메인키워드: "${mainKw}"
- 카테고리: ${categoryStr}

[후보 키워드 목록]
${candidates.join(', ')}

위 후보 목록에서만 골라서, 이 상품명에 추가하면 검색 노출에 도움되는 키워드 ${kwCount}개를 선택하세요.

[선택 기준]
- 이 상품과 직접 관련된 단어만
- 소비자가 실제로 검색하는 단어 우선
- 상품의 용도/특징/대상/재질 관련 단어

[절대 금지]
- 목록에 없는 단어 새로 만들기 금지
- 상품명에 이미 있는 단어 선택 금지
- 메인키워드("${mainKw}") 및 유사어 선택 금지

[출력] JSON만:
{"keywords": ["단어1", "단어2", ...]}`;

  const acqPrompt = `당신은 네이버 쇼핑 검색 행동 전문가입니다.

[상품]
- 상품명: "${productName}"
- 메인키워드: "${mainKw}"
- 카테고리: ${categoryStr}

소비자가 "${mainKw}" 검색 전에 입력할 사전 탐색 키워드 ${acqCount}개.

[규칙]
1. 메인키워드("${mainKw}") 자체 및 유사어/합성어 절대 금지
2. 이 상품 카테고리 안에서만
3. 실제 소비자 탐색 패턴 기반 (1~4어절)

[출력] JSON만:
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
          system: 'JSON만 출력. 설명 없음. 목록에 없는 단어 생성 금지.',
          messages: [{ role: 'user', content: prompt }],
        }),
      }).then(r => r.json());

    const [kwData, acqData] = await Promise.all([
      callClaude(kwPrompt, 300),
      callClaude(acqPrompt, 800),
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

    // JS 최종 검증: 후보 목록에 있는 것만 통과
    const candidateSet = new Set(candidates);
    keywords = keywords.filter(w => candidateSet.has(w)).slice(0, kwCount);

    // ACQ 필터
    const mainNorm = mainKw.toLowerCase().replace(/\s/g, '');
    acq = acq.filter(w => {
      const wn = w.toLowerCase().replace(/\s/g, '');
      return !(mainNorm.length >= 2 && wn.includes(mainNorm));
    });

    return res.status(200).json({ keywords, acq });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
