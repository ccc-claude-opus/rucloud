// 開店模板：選了模板就依這裡的清單產生商品。價格單位是台幣整數。
export const TEMPLATES = {
  bubbletea: [
    ['珍珠奶茶', 50], ['波霸奶茶', 55], ['紅茶', 30], ['綠茶', 30], ['奶茶', 40],
    ['冬瓜茶', 35], ['檸檬綠茶', 45], ['鮮奶紅茶', 45],
  ].map(([name, price], i) => ({ name, price, category: '飲料', sort: i })),

  barbershop: [
    ['剪髮', 300], ['洗髮', 200], ['剪髮＋洗髮', 450], ['護髮', 500],
    ['染髮', 1200], ['燙髮', 1500], ['修鬍', 150],
  ].map(([name, price], i) => ({ name, price, category: '服務', sort: i })),

  grocery: [
    ['礦泉水', 20], ['泡麵', 45], ['雞蛋（一盒）', 80], ['牛奶', 65],
    ['洗髮精', 150], ['衛生紙', 95], ['餅乾', 35], ['可樂', 30], ['米（一包）', 220],
  ].map(([name, price], i) => ({ name, price, category: '商品', sort: i })),

  cafe: [
    ['美式咖啡', 80], ['拿鐵', 110], ['卡布奇諾', 110], ['焦糖瑪奇朵', 130],
    ['義式濃縮', 60], ['手工餅乾', 45], ['布朗尼', 60],
  ].map(([name, price], i) => ({ name, price, category: '咖啡', sort: i })),
};

// 給前端選單用的清單
export const TEMPLATE_LIST = [
  { key: 'bubbletea', name: '珍珠奶茶店', icon: '🧋', items: TEMPLATES.bubbletea },
  { key: 'barbershop', name: '理髮店', icon: '💈', items: TEMPLATES.barbershop },
  { key: 'grocery', name: '雜貨店', icon: '🛒', items: TEMPLATES.grocery },
  { key: 'cafe', name: '咖啡店', icon: '☕', items: TEMPLATES.cafe },
];
