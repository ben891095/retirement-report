// 純計算，不碰 DOM。
//
// 核心假設（不得自行更改）：
// 1. 投資報酬不複利——報酬存入現金，投資本金除非被提領否則恆定。
// 2. 總資產可以為負——不夾在 0，耗盡後繼續往下累積缺口。
// 3. 負值由現金承接——現金不足時先提領投資至 0，之後現金一路往負走；投資永不為負。
// 4. 資金缺口不計利息。
// 5. 每月支出一律全額扣除，不需要「還款與生活費誰先扣」的優先序規則。

// input = {
//   years, cash, investment, annualRatePercent, monthlyExpense,
//   debts: [{ id, payment, months }]
// }
export function simulate(input) {
  const N = Math.round(input.years) * 12;
  const monthlyRate = input.annualRatePercent / 100 / 12;

  let cash = Math.round(input.cash);
  let investment = Math.round(input.investment);

  // 複製一份負債狀態，不動到呼叫端的資料。
  const debts = input.debts.map((d) => ({
    id: d.id,
    payment: Math.round(d.payment),
    months: Math.round(d.months),
  }));

  const months = [];
  let exhaustMonth = null; // 總資產首次 < 0
  let cashExhaustMonth = null; // 現金首次不足以支應當月支出、開始提領投資
  const payoffs = []; // [{ id, month }]

  for (let m = 1; m <= N; m++) {
    const startCash = cash;
    const startInvestment = investment;

    // 報酬基礎為「上月月末投資金額」；投資為 0 之後不再產生報酬。
    const ret = Math.round(Math.max(startInvestment, 0) * monthlyRate);
    // 月付為 0 或剩餘月份為 0 的列不計入還款。
    const repay = debts.reduce((sum, d) => (d.months > 0 ? sum + d.payment : sum), 0);
    const expense = Math.round(input.monthlyExpense);
    const spend = repay + expense;

    const cashAfterSpend = startCash + ret - spend;
    let withdrawal = 0;

    if (cashAfterSpend < 0) {
      // 現金不足以支應當月支出：先賣投資補，投資不為負；提領不夠時現金仍為負。
      if (cashExhaustMonth === null) cashExhaustMonth = m;
      withdrawal = Math.min(startInvestment, -cashAfterSpend);
      investment = Math.round(startInvestment - withdrawal);
      cash = Math.round(cashAfterSpend + withdrawal);
    } else {
      investment = startInvestment;
      cash = Math.round(cashAfterSpend);
    }

    const total = cash + investment;
    if (exhaustMonth === null && total < 0) exhaustMonth = m;

    // 剩餘月份於扣款後才遞減；歸 0 的那個月即結清月，次月起不再扣該筆月付。
    const payoffIds = [];
    for (const d of debts) {
      if (d.months > 0) {
        d.months -= 1;
        if (d.months === 0) {
          payoffIds.push(d.id);
          payoffs.push({ id: d.id, month: m });
        }
      }
    }

    const remainingDebtTotal = debts.reduce((sum, d) => sum + d.payment * d.months, 0);

    months.push({
      m,
      startCash,
      startInvestment,
      ret,
      expense,
      repay,
      withdrawal,
      endCash: cash,
      endInvestment: investment,
      total,
      remainingDebtTotal,
      payoffIds,
    });
  }

  // 期末仍未結清的負債（剩餘月份 > 試算月數的情況）。
  const unsettled = debts
    .filter((d) => d.months > 0 && d.payment > 0)
    .map((d) => ({ id: d.id, monthsLeft: d.months, payment: d.payment }));

  // 有剩餘月份但沒設月付的列：不會計入還款，需要提醒。
  const zeroPaymentRows = input.debts
    .filter((d) => Math.round(d.months) > 0 && Math.round(d.payment) === 0)
    .map((d) => d.id);

  const startTotalDebt = input.debts.reduce(
    (sum, d) => sum + Math.round(d.payment) * Math.round(d.months),
    0
  );

  return {
    N,
    months,
    startCash: Math.round(input.cash),
    startInvestment: Math.round(input.investment),
    startTotalDebt,
    exhaustMonth,
    cashExhaustMonth,
    payoffs,
    unsettled,
    zeroPaymentRows,
    finalCash: cash,
    finalInvestment: investment,
    finalTotal: cash + investment,
  };
}

// 最高可支撐月開銷：其他輸入不變，期末總資產仍 ≥ 0 的最大每月開銷。
// 連每月開銷 0 都撐不過時回傳 null（＝無解），讓結論卡能區分兩種狀態。
export function maxSustainableExpense(input) {
  const feasible = (expense) =>
    simulate({ ...input, monthlyExpense: expense }).finalTotal >= 0;

  if (!feasible(0)) return null;

  const N = Math.round(input.years) * 12;
  const totalReturn = input.investment * (input.annualRatePercent / 100 / 12) * N;
  // 上界取「現金 + 投資金額 + 全期投資報酬」除以總月數後向上取整，再加 1 確保不可行。
  const upper = Math.ceil((input.cash + input.investment + Math.max(totalReturn, 0)) / N) + 1;

  let lo = 0;
  let hi = Math.max(upper - 1, 0);
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (feasible(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// 第 m 個月 → 「第 1 年 01 月」
export function monthLabel(m) {
  const year = Math.floor((m - 1) / 12) + 1;
  const month = ((m - 1) % 12) + 1;
  return `第 ${year} 年 ${String(month).padStart(2, '0')} 月`;
}

// 第 m 個月 → 「第 1 年 01 月」的短版，給圖表標籤用
export function shortMonthLabel(m) {
  const year = Math.floor((m - 1) / 12) + 1;
  const month = ((m - 1) % 12) + 1;
  return `${year}年${String(month).padStart(2, '0')}月`;
}
