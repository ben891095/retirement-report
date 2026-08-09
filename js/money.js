// 金額格式化 / 解析：表單與報表共用，避免兩處各寫一份格式化邏輯。

const nf = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 });

// 數字 → 顯示字串（千分位、不帶小數）。非有限數回傳 '—'，避免把 NaN 印到畫面上。
export function formatAmount(value) {
  if (!Number.isFinite(value)) return '—';
  return nf.format(Math.round(value));
}

// 半形逗號、全形逗號、各種空白（含全形空白）都要去掉。
const SEPARATORS = /[,，\s　]/g;

// 字串 → 數字。空字串視為 0；無法解析回 NaN，讓呼叫端能分辨
// 「解析失敗」與「值為 0」這兩種情況。
export function parseAmount(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : NaN;
  const cleaned = String(text ?? '').replace(SEPARATORS, '');
  if (cleaned === '') return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

// 輸入框過濾用：只留數字（小數點在金額欄不需要，一併濾掉）。
export function digitsOnly(text) {
  return String(text ?? '').replace(/\D/g, '');
}

// 純數字字串 → 千分位字串。空字串維持空字串，讓使用者可以清空欄位。
export function formatDigits(digits) {
  if (digits === '') return '';
  return nf.format(Number(digits));
}
