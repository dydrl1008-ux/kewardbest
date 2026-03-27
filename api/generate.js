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

  // ── 토큰화 (숫자+한글 조합 유지) ──
  const tokenize = (str) =>
    (str || '').split(/\s+/).map(w => w.replace(/[^\uAC00-\uD7A3a-zA-Z0-9]/g, '')).filter(w => w.length >= 2);

  const productTokens = tokenize(productName);
  const mainTokens    = tokenize(mainKw);
  const allTokens     = [...new Set([...productTokens, ...mainTokens])];

  // ── 숫자 규격 계열 감지 ──
  // 상품명에 N인용/N인/Nx이 있으면 같은 계열 전부 블랙리스트
  const UNIT_PATTERNS = [
    /^\d+인용$/, /^\d+인$/, /^\d+단$/, /^\d+층$/,
    /^\d+단계$/, /^\d+cm$/, /^\d+mm$/, /^\d+kg$/,
  ];
  const hasUnitWord = (tok) => UNIT_PATTERNS.some(p => p.test(tok));
  const productHasUnit = productTokens.some(hasUnitWord);

  // ── 브랜드명 패턴 감지 ──
  const isBrand = (word) => {
    if (/^[A-Za-z]+\d+$/.test(word)) return true;  // ABC123
    if (/^\d+[A-Za-z]+$/.test(word)) return true;  // 123ABC
    // 상품명 첫 번째 토큰 = 브랜드일 가능성 높음
    if (productTokens[0] && word === productTokens[0]) return true;
    return false;
  };

  // ── 구매의도 없는 단어 블랙리스트 ──
  const BLACKLIST = new Set([
    '추천','후기','리뷰','비교','순위','인기','베스트','최저가','할인','특가',
    '이벤트','쿠폰','정품','공식','신상','한정','품절','무료','선물','구매',
    '배송','당일','익일','정가','판매','브랜드','국내','해외','수입','정식',
  ]);

  // ── 초성 추출 (유사어 감지용) ──
  const getChosung = (str) => {
    const CHOSUNGS = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
    return [...str].map(ch => {
      const code = ch.charCodeAt(0) - 0xAC00;
      return (code >= 0 && code <= 11171) ? CHOSUNGS[Math.floor(code / 588)] : ch;
    }).join('');
  };

  const isSimilar = (a, b) => {
    const na = a.replace(/\s/g, '').toLowerCase();
    const nb = b.replace(/\s/g, '').toLowerCase();
    if (na === nb) return true;
    if (na.includes(nb) || nb.includes(na)) return true;
    if (getChosung(na) === getChosung(nb)) return true;
    return false;
  };

  // ── 경쟁사 단어 빈도 분석 (보완용) ──
  const freq = {};
  titles.forEach(title => {
    tokenize(title.replace(/<[^>]*>/g, '')).forEach(word => {
      if (BLACKLIST.has(word)) return;
      if (isBrand(word)) return;
      if (allTokens.some(t => isSimilar(word, t))) return;
      if (productHasUnit && hasUnitWord(word)) return;
      if (/^\d+$/.test(word)) return;
      if (word.length < 2 || word.length > 7) return;
      freq[word] = (freq[word] || 0) + 1;
    });
  });

  const topCompetitor = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([w, c]) => `${w}(${c})`)
    .join(', ');

  // ── 프롬프트: AI가 먼저 생성 → 경쟁사로 보완 ──
  const kwPrompt = `당신은 네이버 쇼핑 상품명 SEO 전문가입니다.

[내 상품]
- 상품명: "${productName}"
- 메인키워드: "${mainKw}"
- 카테고리: ${categoryStr}

[경쟁사 고빈도 단어 - 참고만, 검증 후 사용]
${topCompetitor}

[작업]
다음 두 단계로 키워드 ${kwCount}개를 뽑으세요.

STEP 1. 상품 이해 기반 생성
이 상품이 정확히 무엇인지 파악하고, 소비자가 검색할 만한 키워드를 직접 생성하세요.
(용도, 대상, 특징, 재질, 사이즈 등)

STEP 2. 경쟁사 보완
경쟁사 고빈도 단어 중 STEP 1 목록에 없고, 이 상품에 실제로 맞는 것만 추가하세요.
맞지 않으면 경쟁사 단어는 무시하세요.

[절대 금지]
- 상품명에 이미 있는 단어 및 유사어/동의어 금지
  예) 돌쇼파 있으면 → 돌소파, 흙소파, 석재소파 전부 금지
- 메인키워드("${mainKw}") 및 유사어 금지
- 브랜드명, 모델번호 금지
- 구매의도 없는 단어 금지 (추천, 후기, 인기 등)
- 상품과 직접 관련 없는 단어 금지

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
          system: 'JSON만 출력. 설명 없음.',
          messages: [{ role: 'user', content: prompt }],
        }),
      }).then(r => r.json());

    const [kwData, acqData] = await Promise.all([
      callClaude(kwPrompt, 500),
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

    // JS 최종 필터
    const mainNorm = mainKw.toLowerCase().replace(/\s/g, '');

    keywords = keywords.filter(w => {
      if (BLACKLIST.has(w)) return false;
      if (isBrand(w)) return false;
      if (allTokens.some(t => isSimilar(w, t))) return false;
      if (productHasUnit && hasUnitWord(w)) return false;
      if (/^\d+$/.test(w)) return false;
      const wn = w.toLowerCase().replace(/\s/g, '');
      if (mainNorm.length >= 2 && wn.includes(mainNorm)) return false;
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
