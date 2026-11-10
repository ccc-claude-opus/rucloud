// markpedia 的 Cloudflare Worker：
//   /api/*  百科條目的新增、修改、刪除、查詢（D1；每個條目有 zh 繁中版與 en 英文版）
//   其他    靜態檔案（public/，由 Assets 提供）
//   資料表第一次使用時，會自動把 public/seed/ 的範例條目灌進去（見 ensureSeed）

// 分類樹：天、地、文、法、商、理、工、醫、農九大學門 → 三十六個次分類 → 各分類底下的條目。
const SEED = [
  { slug: 'markpedia', lang: 'zh', title: 'Markpedia' },
  { slug: 'markpedia', lang: 'en', title: 'Markpedia' },
  { slug: 'cat-tian', lang: 'zh', title: '天學門' },
  { slug: 'cat-tian', lang: 'en', title: 'Astronomy and Space' },
  { slug: 'cat-astronomy', lang: 'zh', title: '天文' },
  { slug: 'cat-astronomy', lang: 'en', title: 'Observational astronomy' },
  { slug: 'cat-space', lang: 'zh', title: '太空科技' },
  { slug: 'cat-space', lang: 'en', title: 'Space technology' },
  { slug: 'cat-meteorology', lang: 'zh', title: '氣象大氣' },
  { slug: 'cat-meteorology', lang: 'en', title: 'Meteorology and atmospheric science' },
  { slug: 'cat-planetary', lang: 'zh', title: '行星科學' },
  { slug: 'cat-planetary', lang: 'en', title: 'Planetary science' },
  { slug: 'telescope', lang: 'zh', title: '望遠鏡' },
  { slug: 'telescope', lang: 'en', title: 'Telescope' },
  { slug: 'constellation', lang: 'zh', title: '星座' },
  { slug: 'constellation', lang: 'en', title: 'Constellation' },
  { slug: 'astrometry', lang: 'zh', title: '天體測量' },
  { slug: 'astrometry', lang: 'en', title: 'Astrometry' },
  { slug: 'rocket', lang: 'zh', title: '火箭' },
  { slug: 'rocket', lang: 'en', title: 'Rocket' },
  { slug: 'satellite', lang: 'zh', title: '人造衛星' },
  { slug: 'satellite', lang: 'en', title: 'Satellite' },
  { slug: 'space-probe', lang: 'zh', title: '探測器' },
  { slug: 'space-probe', lang: 'en', title: 'Space probe' },
  { slug: 'weather-system', lang: 'zh', title: '天氣系統' },
  { slug: 'weather-system', lang: 'en', title: 'Weather system' },
  { slug: 'weather-forecast', lang: 'zh', title: '天氣預報' },
  { slug: 'weather-forecast', lang: 'en', title: 'Weather forecasting' },
  { slug: 'atmospheric-science', lang: 'zh', title: '大氣科學' },
  { slug: 'atmospheric-science', lang: 'en', title: 'Atmospheric science' },
  { slug: 'solar-system', lang: 'zh', title: '太陽系' },
  { slug: 'solar-system', lang: 'en', title: 'Solar System' },
  { slug: 'asteroid', lang: 'zh', title: '小行星' },
  { slug: 'asteroid', lang: 'en', title: 'Asteroid' },
  { slug: 'exoplanet', lang: 'zh', title: '系外行星' },
  { slug: 'exoplanet', lang: 'en', title: 'Exoplanet' },
  { slug: 'cat-di', lang: 'zh', title: '地學門' },
  { slug: 'cat-di', lang: 'en', title: 'Earth and Ocean' },
  { slug: 'cat-geology', lang: 'zh', title: '地質' },
  { slug: 'cat-geology', lang: 'en', title: 'Geology' },
  { slug: 'cat-ocean', lang: 'zh', title: '海洋' },
  { slug: 'cat-ocean', lang: 'en', title: 'Oceanography' },
  { slug: 'cat-geography', lang: 'zh', title: '地理' },
  { slug: 'cat-geography', lang: 'en', title: 'Geography' },
  { slug: 'cat-hazard', lang: 'zh', title: '自然災害' },
  { slug: 'cat-hazard', lang: 'en', title: 'Natural hazards' },
  { slug: 'rock', lang: 'zh', title: '岩石' },
  { slug: 'rock', lang: 'en', title: 'Rock' },
  { slug: 'plate-tectonics', lang: 'zh', title: '板塊構造' },
  { slug: 'plate-tectonics', lang: 'en', title: 'Plate tectonics' },
  { slug: 'geologic-history', lang: 'zh', title: '地史' },
  { slug: 'geologic-history', lang: 'en', title: 'Geologic history' },
  { slug: 'ocean-current', lang: 'zh', title: '洋流' },
  { slug: 'ocean-current', lang: 'en', title: 'Ocean current' },
  { slug: 'tide', lang: 'zh', title: '潮汐' },
  { slug: 'tide', lang: 'en', title: 'Tide' },
  { slug: 'marine-ecology', lang: 'zh', title: '海洋生態' },
  { slug: 'marine-ecology', lang: 'en', title: 'Marine ecology' },
  { slug: 'map', lang: 'zh', title: '地圖' },
  { slug: 'map', lang: 'en', title: 'Map' },
  { slug: 'landform', lang: 'zh', title: '地形' },
  { slug: 'landform', lang: 'en', title: 'Landform' },
  { slug: 'human-geography', lang: 'zh', title: '人文地理' },
  { slug: 'human-geography', lang: 'en', title: 'Human geography' },
  { slug: 'earthquake', lang: 'zh', title: '地震' },
  { slug: 'earthquake', lang: 'en', title: 'Earthquake' },
  { slug: 'typhoon', lang: 'zh', title: '颱風' },
  { slug: 'typhoon', lang: 'en', title: 'Typhoon' },
  { slug: 'volcano', lang: 'zh', title: '火山' },
  { slug: 'volcano', lang: 'en', title: 'Volcano' },
  { slug: 'cat-wen', lang: 'zh', title: '文學門' },
  { slug: 'cat-wen', lang: 'en', title: 'Humanities and Languages' },
  { slug: 'cat-literature', lang: 'zh', title: '文學' },
  { slug: 'cat-literature', lang: 'en', title: 'Literature' },
  { slug: 'cat-languages', lang: 'zh', title: '語言' },
  { slug: 'cat-languages', lang: 'en', title: 'Languages' },
  { slug: 'cat-history', lang: 'zh', title: '歷史' },
  { slug: 'cat-history', lang: 'en', title: 'History' },
  { slug: 'cat-philosophy', lang: 'zh', title: '哲學' },
  { slug: 'cat-philosophy', lang: 'en', title: 'Philosophy' },
  { slug: 'poetry', lang: 'zh', title: '詩' },
  { slug: 'poetry', lang: 'en', title: 'Poetry' },
  { slug: 'novel', lang: 'zh', title: '小說' },
  { slug: 'novel', lang: 'en', title: 'Novel' },
  { slug: 'drama', lang: 'zh', title: '戲劇' },
  { slug: 'drama', lang: 'en', title: 'Drama' },
  { slug: 'syntax', lang: 'zh', title: '句法' },
  { slug: 'syntax', lang: 'en', title: 'Syntax' },
  { slug: 'phonology', lang: 'zh', title: '音韻' },
  { slug: 'phonology', lang: 'en', title: 'Phonology' },
  { slug: 'linguistics', lang: 'zh', title: '語言學' },
  { slug: 'linguistics', lang: 'en', title: 'Linguistics' },
  { slug: 'periodization', lang: 'zh', title: '斷代史' },
  { slug: 'periodization', lang: 'en', title: 'Periodization' },
  { slug: 'civilization', lang: 'zh', title: '文明史' },
  { slug: 'civilization', lang: 'en', title: 'Civilization' },
  { slug: 'historiography', lang: 'zh', title: '史學方法' },
  { slug: 'historiography', lang: 'en', title: 'Historiography' },
  { slug: 'logic', lang: 'zh', title: '邏輯' },
  { slug: 'logic', lang: 'en', title: 'Logic' },
  { slug: 'ethics', lang: 'zh', title: '倫理' },
  { slug: 'ethics', lang: 'en', title: 'Ethics' },
  { slug: 'philosophy-school', lang: 'zh', title: '哲學流派' },
  { slug: 'philosophy-school', lang: 'en', title: 'School of philosophy' },
  { slug: 'cat-fa', lang: 'zh', title: '法學門' },
  { slug: 'cat-fa', lang: 'en', title: 'Law and Politics' },
  { slug: 'cat-law', lang: 'zh', title: '法律' },
  { slug: 'cat-law', lang: 'en', title: 'Law' },
  { slug: 'cat-politics', lang: 'zh', title: '政治' },
  { slug: 'cat-politics', lang: 'en', title: 'Politics' },
  { slug: 'cat-policy', lang: 'zh', title: '公共政策' },
  { slug: 'cat-policy', lang: 'en', title: 'Public policy' },
  { slug: 'cat-sociology', lang: 'zh', title: '社會學' },
  { slug: 'cat-sociology', lang: 'en', title: 'Sociology' },
  { slug: 'statute', lang: 'zh', title: '法條' },
  { slug: 'statute', lang: 'en', title: 'Statute' },
  { slug: 'precedent', lang: 'zh', title: '判例' },
  { slug: 'precedent', lang: 'en', title: 'Precedent' },
  { slug: 'jurisprudence', lang: 'zh', title: '法學思想' },
  { slug: 'jurisprudence', lang: 'en', title: 'Jurisprudence' },
  { slug: 'election', lang: 'zh', title: '選舉' },
  { slug: 'election', lang: 'en', title: 'Election' },
  { slug: 'political-system', lang: 'zh', title: '政體' },
  { slug: 'political-system', lang: 'en', title: 'Political system' },
  { slug: 'international-relations', lang: 'zh', title: '國際關係' },
  { slug: 'international-relations', lang: 'en', title: 'International relations' },
  { slug: 'education-policy', lang: 'zh', title: '教育政策' },
  { slug: 'education-policy', lang: 'en', title: 'Education policy' },
  { slug: 'welfare', lang: 'zh', title: '福利政策' },
  { slug: 'welfare', lang: 'en', title: 'Welfare policy' },
  { slug: 'urban-policy', lang: 'zh', title: '都市政策' },
  { slug: 'urban-policy', lang: 'en', title: 'Urban policy' },
  { slug: 'social-structure', lang: 'zh', title: '社會結構' },
  { slug: 'social-structure', lang: 'en', title: 'Social structure' },
  { slug: 'ethnicity', lang: 'zh', title: '族群' },
  { slug: 'ethnicity', lang: 'en', title: 'Ethnicity' },
  { slug: 'demography', lang: 'zh', title: '人口' },
  { slug: 'demography', lang: 'en', title: 'Demography' },
  { slug: 'cat-shang', lang: 'zh', title: '商學門' },
  { slug: 'cat-shang', lang: 'en', title: 'Business and Economics' },
  { slug: 'cat-economics', lang: 'zh', title: '經濟' },
  { slug: 'cat-economics', lang: 'en', title: 'Economics' },
  { slug: 'cat-management', lang: 'zh', title: '經營管理' },
  { slug: 'cat-management', lang: 'en', title: 'Management' },
  { slug: 'cat-finance', lang: 'zh', title: '金融投資' },
  { slug: 'cat-finance', lang: 'en', title: 'Finance and investment' },
  { slug: 'cat-accounting', lang: 'zh', title: '會計商法' },
  { slug: 'cat-accounting', lang: 'en', title: 'Accounting and commercial law' },
  { slug: 'microeconomics', lang: 'zh', title: '個體經濟' },
  { slug: 'microeconomics', lang: 'en', title: 'Microeconomics' },
  { slug: 'macroeconomics', lang: 'zh', title: '總體經濟' },
  { slug: 'macroeconomics', lang: 'en', title: 'Macroeconomics' },
  { slug: 'trade', lang: 'zh', title: '貿易' },
  { slug: 'trade', lang: 'en', title: 'Trade' },
  { slug: 'strategy', lang: 'zh', title: '策略' },
  { slug: 'strategy', lang: 'en', title: 'Strategy' },
  { slug: 'organization', lang: 'zh', title: '組織' },
  { slug: 'organization', lang: 'en', title: 'Organization' },
  { slug: 'marketing', lang: 'zh', title: '行銷' },
  { slug: 'marketing', lang: 'en', title: 'Marketing' },
  { slug: 'money', lang: 'zh', title: '貨幣' },
  { slug: 'money', lang: 'en', title: 'Money' },
  { slug: 'securities', lang: 'zh', title: '證券' },
  { slug: 'securities', lang: 'en', title: 'Securities' },
  { slug: 'personal-finance', lang: 'zh', title: '個人理財' },
  { slug: 'personal-finance', lang: 'en', title: 'Personal finance' },
  { slug: 'financial-statement', lang: 'zh', title: '財務報表' },
  { slug: 'financial-statement', lang: 'en', title: 'Financial statement' },
  { slug: 'audit', lang: 'zh', title: '審計' },
  { slug: 'audit', lang: 'en', title: 'Audit' },
  { slug: 'business-law', lang: 'zh', title: '商業法規' },
  { slug: 'business-law', lang: 'en', title: 'Business law' },
  { slug: 'cat-li', lang: 'zh', title: '理學門' },
  { slug: 'cat-li', lang: 'en', title: 'Natural Sciences' },
  { slug: 'cat-math', lang: 'zh', title: '數學' },
  { slug: 'cat-math', lang: 'en', title: 'Mathematics' },
  { slug: 'cat-physics', lang: 'zh', title: '物理學' },
  { slug: 'cat-physics', lang: 'en', title: 'Physics' },
  { slug: 'cat-chemistry', lang: 'zh', title: '化學' },
  { slug: 'cat-chemistry', lang: 'en', title: 'Chemistry' },
  { slug: 'cat-statistics', lang: 'zh', title: '統計資料' },
  { slug: 'cat-statistics', lang: 'en', title: 'Statistics and data analysis' },
  { slug: 'algebra', lang: 'zh', title: '代數' },
  { slug: 'algebra', lang: 'en', title: 'Algebra' },
  { slug: 'geometry', lang: 'zh', title: '幾何' },
  { slug: 'geometry', lang: 'en', title: 'Geometry' },
  { slug: 'math-analysis', lang: 'zh', title: '數學分析' },
  { slug: 'math-analysis', lang: 'en', title: 'Mathematical analysis' },
  { slug: 'matter', lang: 'zh', title: '物質' },
  { slug: 'matter', lang: 'en', title: 'Matter' },
  { slug: 'energy', lang: 'zh', title: '能量' },
  { slug: 'energy', lang: 'en', title: 'Energy' },
  { slug: 'spacetime', lang: 'zh', title: '時空' },
  { slug: 'spacetime', lang: 'en', title: 'Spacetime' },
  { slug: 'mass-energy-equivalence', lang: 'zh', title: '質能等價' },
  { slug: 'mass-energy-equivalence', lang: 'en', title: 'Mass–energy equivalence' },
  { slug: 'element', lang: 'zh', title: '元素' },
  { slug: 'element', lang: 'en', title: 'Element' },
  { slug: 'chemical-reaction', lang: 'zh', title: '化學反應' },
  { slug: 'chemical-reaction', lang: 'en', title: 'Chemical reaction' },
  { slug: 'materials-chemistry', lang: 'zh', title: '材料化學' },
  { slug: 'materials-chemistry', lang: 'en', title: 'Materials chemistry' },
  { slug: 'probability', lang: 'zh', title: '機率' },
  { slug: 'probability', lang: 'en', title: 'Probability' },
  { slug: 'inference', lang: 'zh', title: '統計推論' },
  { slug: 'inference', lang: 'en', title: 'Statistical inference' },
  { slug: 'data-analysis', lang: 'zh', title: '資料分析' },
  { slug: 'data-analysis', lang: 'en', title: 'Data analysis' },
  { slug: 'cat-gong', lang: 'zh', title: '工學門' },
  { slug: 'cat-gong', lang: 'en', title: 'Engineering and Technology' },
  { slug: 'cat-info-tech', lang: 'zh', title: '資訊技術' },
  { slug: 'cat-info-tech', lang: 'en', title: 'Information technology' },
  { slug: 'cat-mechanic', lang: 'zh', title: '機械製造' },
  { slug: 'cat-mechanic', lang: 'en', title: 'Mechanical engineering' },
  { slug: 'cat-electrical', lang: 'zh', title: '電機電子' },
  { slug: 'cat-electrical', lang: 'en', title: 'Electrical and electronic engineering' },
  { slug: 'cat-civil', lang: 'zh', title: '土木建築' },
  { slug: 'cat-civil', lang: 'en', title: 'Civil engineering and architecture' },
  { slug: 'software-engineering', lang: 'zh', title: '軟體工程' },
  { slug: 'software-engineering', lang: 'en', title: 'Software engineering' },
  { slug: 'computer-network', lang: 'zh', title: '電腦網路' },
  { slug: 'computer-network', lang: 'en', title: 'Computer network' },
  { slug: 'web-development', lang: 'zh', title: '網頁開發' },
  { slug: 'web-development', lang: 'en', title: 'Web development' },
  { slug: 'markdown', lang: 'zh', title: 'Markdown 記法' },
  { slug: 'markdown', lang: 'en', title: 'Markdown syntax' },
  { slug: 'mermaid', lang: 'zh', title: 'Mermaid 圖表' },
  { slug: 'mermaid', lang: 'en', title: 'Mermaid diagrams' },
  { slug: 'cloudflare-workers', lang: 'zh', title: 'Cloudflare Workers' },
  { slug: 'cloudflare-workers', lang: 'en', title: 'Cloudflare Workers' },
  { slug: 'machine', lang: 'zh', title: '機械' },
  { slug: 'machine', lang: 'en', title: 'Machine' },
  { slug: 'engineering-material', lang: 'zh', title: '工程材料' },
  { slug: 'engineering-material', lang: 'en', title: 'Engineering material' },
  { slug: 'manufacturing-process', lang: 'zh', title: '製造製程' },
  { slug: 'manufacturing-process', lang: 'en', title: 'Manufacturing process' },
  { slug: 'circuit', lang: 'zh', title: '電路' },
  { slug: 'circuit', lang: 'en', title: 'Circuit' },
  { slug: 'semiconductor', lang: 'zh', title: '半導體' },
  { slug: 'semiconductor', lang: 'en', title: 'Semiconductor' },
  { slug: 'telecommunications', lang: 'zh', title: '通訊' },
  { slug: 'telecommunications', lang: 'en', title: 'Telecommunications' },
  { slug: 'structure', lang: 'zh', title: '結構工程' },
  { slug: 'structure', lang: 'en', title: 'Structural engineering' },
  { slug: 'construction', lang: 'zh', title: '營造工法' },
  { slug: 'construction', lang: 'en', title: 'Construction method' },
  { slug: 'infrastructure', lang: 'zh', title: '基礎建設' },
  { slug: 'infrastructure', lang: 'en', title: 'Infrastructure' },
  { slug: 'cat-yi', lang: 'zh', title: '醫學門' },
  { slug: 'cat-yi', lang: 'en', title: 'Medicine and Health' },
  { slug: 'cat-medicine', lang: 'zh', title: '醫學' },
  { slug: 'cat-medicine', lang: 'en', title: 'Medicine' },
  { slug: 'cat-public-health', lang: 'zh', title: '公共衛生' },
  { slug: 'cat-public-health', lang: 'en', title: 'Public health' },
  { slug: 'cat-pharmacy', lang: 'zh', title: '藥學' },
  { slug: 'cat-pharmacy', lang: 'en', title: 'Pharmacy' },
  { slug: 'cat-nutrition', lang: 'zh', title: '營養健康' },
  { slug: 'cat-nutrition', lang: 'en', title: 'Nutrition and health' },
  { slug: 'diagnosis', lang: 'zh', title: '診斷' },
  { slug: 'diagnosis', lang: 'en', title: 'Diagnosis' },
  { slug: 'treatment', lang: 'zh', title: '治療' },
  { slug: 'treatment', lang: 'en', title: 'Treatment' },
  { slug: 'medication', lang: 'zh', title: '用藥' },
  { slug: 'medication', lang: 'en', title: 'Medication' },
  { slug: 'epidemic-control', lang: 'zh', title: '防疫' },
  { slug: 'epidemic-control', lang: 'en', title: 'Epidemic control' },
  { slug: 'health-insurance', lang: 'zh', title: '健保' },
  { slug: 'health-insurance', lang: 'en', title: 'Health insurance' },
  { slug: 'epidemiology', lang: 'zh', title: '流行病學' },
  { slug: 'epidemiology', lang: 'en', title: 'Epidemiology' },
  { slug: 'drug-action', lang: 'zh', title: '藥物作用' },
  { slug: 'drug-action', lang: 'en', title: 'Drug action' },
  { slug: 'dosage-form', lang: 'zh', title: '劑型' },
  { slug: 'dosage-form', lang: 'en', title: 'Dosage form' },
  { slug: 'medication-safety', lang: 'zh', title: '安全用藥' },
  { slug: 'medication-safety', lang: 'en', title: 'Medication safety' },
  { slug: 'nutrient', lang: 'zh', title: '營養素' },
  { slug: 'nutrient', lang: 'en', title: 'Nutrient' },
  { slug: 'diet', lang: 'zh', title: '飲食' },
  { slug: 'diet', lang: 'en', title: 'Diet' },
  { slug: 'lifestyle-health', lang: 'zh', title: '生活健康' },
  { slug: 'lifestyle-health', lang: 'en', title: 'Lifestyle and health' },
  { slug: 'cat-nong', lang: 'zh', title: '農學門' },
  { slug: 'cat-nong', lang: 'en', title: 'Agriculture and Biology' },
  { slug: 'cat-farming', lang: 'zh', title: '農業' },
  { slug: 'cat-farming', lang: 'en', title: 'Farming' },
  { slug: 'cat-biology', lang: 'zh', title: '生物' },
  { slug: 'cat-biology', lang: 'en', title: 'Biology' },
  { slug: 'cat-forestry', lang: 'zh', title: '林漁牧' },
  { slug: 'cat-forestry', lang: 'en', title: 'Forestry, fisheries and animal husbandry' },
  { slug: 'cat-biotech', lang: 'zh', title: '生命科技' },
  { slug: 'cat-biotech', lang: 'en', title: 'Biotechnology' },
  { slug: 'crop', lang: 'zh', title: '作物' },
  { slug: 'crop', lang: 'en', title: 'Crop' },
  { slug: 'cultivation', lang: 'zh', title: '耕作' },
  { slug: 'cultivation', lang: 'en', title: 'Cultivation' },
  { slug: 'food-system', lang: 'zh', title: '糧食體系' },
  { slug: 'food-system', lang: 'en', title: 'Food system' },
  { slug: 'cell', lang: 'zh', title: '細胞' },
  { slug: 'cell', lang: 'en', title: 'Cell' },
  { slug: 'genetics', lang: 'zh', title: '遺傳' },
  { slug: 'genetics', lang: 'en', title: 'Genetics' },
  { slug: 'ecology', lang: 'zh', title: '生態' },
  { slug: 'ecology', lang: 'en', title: 'Ecology' },
  { slug: 'forestry', lang: 'zh', title: '林業' },
  { slug: 'forestry', lang: 'en', title: 'Forestry' },
  { slug: 'fishery', lang: 'zh', title: '漁業' },
  { slug: 'fishery', lang: 'en', title: 'Fishery' },
  { slug: 'livestock', lang: 'zh', title: '畜牧' },
  { slug: 'livestock', lang: 'en', title: 'Livestock farming' },
  { slug: 'genetic-engineering', lang: 'zh', title: '基因工程' },
  { slug: 'genetic-engineering', lang: 'en', title: 'Genetic engineering' },
  { slug: 'biotechnology', lang: 'zh', title: '生物技術' },
  { slug: 'biotechnology', lang: 'en', title: 'Biotechnology' },
];


const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const LANGS = ['zh', 'en'];

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readJson(request) {
  try { return await request.json(); } catch (e) { throw new HttpError(400, 'JSON 格式不正確'); }
}

async function handle(fn) {
  try { return await fn(); } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    return json({ error: `伺服器錯誤：${e.message}` }, 500);
  }
}

function failIfInvalid(slug, lang, title, body) {
  if (!SLUG_RE.test(slug)) throw new HttpError(400, 'slug 只能用小寫英文、數字與 -，長度 1～80');
  if (!LANGS.includes(lang)) throw new HttpError(400, 'lang 必須是 zh 或 en');
  if (!title || title.length > 200) throw new HttpError(400, 'title 需要 1～200 字');
  if (typeof body !== 'string' || !body.trim()) throw new HttpError(400, '內容不能是空的');
  if (body.length > 100_000) throw new HttpError(400, '內容最長 100000 字');
}

// 資料表是空的才灌範例條目；內容從 public/seed/ 的原始檔讀來。
// 分批播種：免費方案每個請求最多 50 個 subrequest（資產 fetch + D1 查詢都算），
// 一次灌 51 個 seed 檔會被砍，所以每次請求只補一批，多個請求接力灌完。
// want 是這次請求要的條目代稱：把它排到這一批的最前面，
// 這樣直接開某一條網址的讀者不必等到整批灌完才看得到內容。
const SEED_CHUNK = 40;
async function ensureSeed(db, assets, want) {
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM entries').first();
  if (n >= SEED.length) return;
  const { results: have } = await db.prepare('SELECT slug, lang FROM entries').all();
  const done = new Set(have.map((r) => `${r.slug}:${r.lang}`));
  let todo = SEED.filter((d) => !done.has(`${d.slug}:${d.lang}`));
  if (want) {
    const first = todo.filter((d) => d.slug === want);
    todo = [...first, ...todo.filter((d) => d.slug !== want)];
  }
  todo = todo.slice(0, SEED_CHUNK);
  if (!todo.length) return;
  const stmts = [];
  for (const doc of todo) {
    const res = await assets.fetch(new Request(`https://self/seed/${doc.slug}.${doc.lang}.md`));
    const body = await res.text();
    stmts.push(db.prepare('INSERT INTO entries (slug, lang, title, body) VALUES (?, ?, ?, ?)')
      .bind(doc.slug, doc.lang, doc.title, body));
  }
  await db.batch(stmts);
}

const entryOut = (row) => ({
  slug: row.slug,
  lang: row.lang,
  title: row.title,
  body: row.body,
  updatedAt: row.updated_at,
});

async function listEntries(db, params) {
  const conds = [];
  const binds = [];
  const lang = params.get('lang');
  if (lang) {
    if (!LANGS.includes(lang)) throw new HttpError(400, 'lang 必須是 zh 或 en');
    conds.push('lang = ?');
    binds.push(lang);
  }
  const q = (params.get('q') || '').trim();
  if (q) {
    conds.push('(title LIKE ? OR body LIKE ?)');
    binds.push(`%${q}%`, `%${q}%`);
  }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  const { results } = await db.prepare(
    `SELECT slug, lang, title, updated_at FROM entries${where} ORDER BY slug, lang`,
  ).bind(...binds).all();
  return json({
    entries: results.map((r) => ({
      slug: r.slug,
      lang: r.lang,
      title: r.title,
      updatedAt: r.updated_at,
    })),
  });
}

async function getEntry(db, slug, params) {
  let row = await db.prepare(
    'SELECT slug, lang, title, body, updated_at FROM entries WHERE slug = ? AND lang = ?',
  ).bind(slug, params.get('lang') || 'zh').first();
  if (!row) {
    // 指定的語言版本不存在時，退回這個條目現存的任一語言版本
    row = await db.prepare(
      'SELECT slug, lang, title, body, updated_at FROM entries WHERE slug = ? ORDER BY lang LIMIT 1',
    ).bind(slug).first();
  }
  if (!row) throw new HttpError(404, '找不到條目');
  const { results: langRows } = await db.prepare('SELECT lang, title FROM entries WHERE slug = ?')
    .bind(slug).all();
  return json({
    entry: entryOut(row),
    langs: Object.fromEntries(langRows.map((r) => [r.lang, r.title])),
  });
}

async function createEntry(request, db) {
  const data = await readJson(request);
  failIfInvalid(data.slug, data.lang, data.title, data.body);
  const exists = await db.prepare('SELECT 1 AS x FROM entries WHERE slug = ? AND lang = ?')
    .bind(data.slug, data.lang).first();
  if (exists) throw new HttpError(409, `條目已存在：${data.slug}（${data.lang} 版）`);
  const row = await db.prepare(
    'INSERT INTO entries (slug, lang, title, body) VALUES (?, ?, ?, ?) RETURNING slug, lang, title, body, updated_at',
  ).bind(data.slug, data.lang, data.title, data.body).first();
  return json(entryOut(row), 201);
}

async function updateEntry(request, db, slug) {
  const data = await readJson(request);
  failIfInvalid(slug, data.lang, data.title, data.body);
  const row = await db.prepare(
    "UPDATE entries SET title = ?, body = ?, updated_at = datetime('now') WHERE slug = ? AND lang = ? RETURNING slug, lang, title, body, updated_at",
  ).bind(data.title, data.body, slug, data.lang).first();
  if (!row) throw new HttpError(404, '找不到要修改的條目');
  return json(entryOut(row));
}

async function deleteEntry(db, slug, params) {
  const lang = params.get('lang');
  if (lang && LANGS.includes(lang)) {
    const r = await db.prepare('DELETE FROM entries WHERE slug = ? AND lang = ?').bind(slug, lang).run();
    return json({ deleted: r.meta.changes });
  }
  // 沒指定 lang 就刪掉整個條目（所有語言版本）
  const r = await db.prepare('DELETE FROM entries WHERE slug = ?').bind(slug).run();
  return json({ deleted: r.meta.changes });
}

async function randomEntry(db) {
  let row = await db.prepare("SELECT slug FROM entries WHERE lang = 'zh' ORDER BY RANDOM() LIMIT 1").first();
  if (!row) row = await db.prepare('SELECT slug FROM entries ORDER BY RANDOM() LIMIT 1').first();
  if (!row) throw new HttpError(404, '還沒有任何條目');
  return json(row);
}

export default {
  async fetch(request, env) {
    return handle(async () => {
      const url = new URL(request.url);
      const path = url.pathname;
      if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);

      // 這次請求要的條目（/api/entry/{slug}）會被優先灌進 seed，
      // 讀者直接開某一條網址時立刻看得到內容。
      const segs = path.split('/').filter(Boolean);
      const want = segs.length === 3 && segs[1] === 'entry' ? segs[2] : null;

      await ensureSeed(env.DB, env.ASSETS, want);

      switch (`${request.method} ${path}`) {
        case 'GET /api/entries': return listEntries(env.DB, url.searchParams);
        case 'POST /api/entries': return createEntry(request, env.DB);
        case 'GET /api/random': return randomEntry(env.DB);
      }
      if (segs.length === 3 && segs[1] === 'entry') {
        const slug = segs[2];
        if (!SLUG_RE.test(slug)) throw new HttpError(404, '找不到這個 API');
        switch (request.method) {
          case 'GET': return getEntry(env.DB, slug, url.searchParams);
          case 'PUT': return updateEntry(request, env.DB, slug);
          case 'DELETE': return deleteEntry(env.DB, slug, url.searchParams);
        }
      }
      throw new HttpError(404, '找不到這個 API');
    });
  },
};
