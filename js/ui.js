// 讀表單、渲染、事件綁定（進入點）。

import { formatAmount, parseAmount, digitsOnly, formatDigits } from './money.js';
import { simulate, maxSustainableExpense, monthLabel } from './calc.js';
import { renderChart } from './chart.js';

const $ = (sel) => document.querySelector(sel);

const debtList = $('#debt-list');
const addDebtBtn = $('#add-debt');
const warningsNode = $('#warnings');
const summaryNode = $('#summary');
const reportTable = $('#report');
const toggleAllBtn = $('#toggle-all');
const chartContainer = $('#chart-container');
const chartSummary = $('#chart-summary');

const reportEmpty = $('#report-empty');

let debtRowSeq = 0;
let lastResult = null; // 有錯誤時保留上一次結果，不清空報表與圖
let hasRendered = false; // 還沒算出任何結果前顯示空狀態，而不是一排紅字
const expandedYears = new Set();

// 欄位被輸入或離開焦點後才算「碰過」，避免一開頁就對空欄位報錯
function watchTouched(input) {
  const mark = () => { input.dataset.touched = '1'; };
  input.addEventListener('blur', () => { mark(); recalculate(); });
  input.addEventListener('input', mark);
}

/* ---------- 金額輸入框：即時千分位 + 游標還原 ---------- */

function countDigits(text) {
  return (text.match(/\d/g) || []).length;
}

// 寫回格式化字串後，把游標移到「左側第 n 個數字之後」。
// 單純設 selectionStart = 原值 會在逗號插入時跳位。
function positionAfterDigits(text, n) {
  if (n <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] >= '0' && text[i] <= '9') {
      seen++;
      if (seen === n) return i + 1;
    }
  }
  return text.length;
}

function reformatMoneyInput(input) {
  const before = input.value;
  const caret = input.selectionStart ?? before.length;
  const digitsLeftOfCaret = countDigits(before.slice(0, caret));
  const next = formatDigits(digitsOnly(before)); // 貼上的非數字字元在此被濾掉
  if (next === before) return;
  input.value = next;
  const pos = positionAfterDigits(next, digitsLeftOfCaret);
  input.setSelectionRange(pos, pos);
}

function bindMoneyInput(input) {
  input.addEventListener('input', () => {
    reformatMoneyInput(input);
    recalculate();
  });
  watchTouched(input);
}

/* ---------- 負債列 ---------- */

function createDebtRow() {
  const id = `debt-${++debtRowSeq}`; // 穩定 id：刪除中間列時，結清紀錄仍能正確對應
  const row = document.createElement('div');
  row.className = 'debt-row';
  row.dataset.id = id;
  row.innerHTML = `
    <div class="debt-index" aria-hidden="true"></div>
    <div class="field">
      <label for="${id}-payment">每月還款額</label>
      <input id="${id}-payment" class="money" data-role="payment" type="text"
             inputmode="numeric" autocomplete="off" value="" placeholder="例：15,000">
    </div>
    <div class="field">
      <label for="${id}-months">剩餘月份</label>
      <input id="${id}-months" data-role="months" type="number" min="0" step="1"
             autocomplete="off" value="" placeholder="例：36">
    </div>
    <div class="debt-actions">
      <button type="button" class="btn-remove" data-role="remove">刪除</button>
    </div>
  `;

  bindMoneyInput(row.querySelector('[data-role="payment"]'));
  row.querySelector('[data-role="months"]').addEventListener('input', recalculate);
  row.querySelector('[data-role="remove"]').addEventListener('click', () => {
    row.remove(); // 可以刪到 0 列，0 列即代表無負債
    renumberDebtRows();
    recalculate();
    addDebtBtn.focus();
  });

  return row;
}

function renumberDebtRows() {
  [...debtList.children].forEach((row, i) => {
    row.querySelector('.debt-index').textContent = `負債 ${i + 1}`;
    row.querySelector('[data-role="remove"]').setAttribute('aria-label', `刪除負債 ${i + 1}`);
  });
  debtList.classList.toggle('is-empty', debtList.children.length === 0);
}

addDebtBtn.addEventListener('click', () => {
  const row = createDebtRow();
  debtList.appendChild(row);
  renumberDebtRows();
  row.querySelector('[data-role="payment"]').focus();
  recalculate();
});

/* ---------- 讀表單 + 驗證 ---------- */

function setFieldError(name, message) {
  const node = document.querySelector(`[data-error-for="${name}"]`);
  if (!node) return;
  // 沒碰過的欄位不報錯（開頁時全部為空是正常狀態）
  const field = document.querySelector(`#${name}`);
  const touched = field?.dataset.touched === '1';
  node.textContent = touched ? message || '' : '';
}

function readForm() {
  const errors = [];

  const yearsRaw = $('#years').value.trim();
  const years = yearsRaw === '' ? NaN : Number(yearsRaw);
  if (!Number.isFinite(years) || years < 1 || !Number.isInteger(years)) {
    errors.push(['years', '請輸入 1 以上的整數年數']);
  } else if (years > 120) {
    errors.push(['years', '年數請勿超過 120']);
  }

  const readMoney = (sel, name, label) => {
    const value = parseAmount($(sel).value);
    if (Number.isNaN(value)) {
      errors.push([name, `${label}無法解析為數字`]);
      return 0;
    }
    if (value < 0) {
      errors.push([name, `${label}不可為負值`]);
      return 0;
    }
    return value;
  };

  const cash = readMoney('#cash', 'cash', '現金');
  const investment = readMoney('#investment', 'investment', '投資金額');
  const monthlyExpense = readMoney('#expense', 'expense', '每月開銷');

  const rateRaw = $('#rate').value.trim();
  const annualRatePercent = rateRaw === '' ? 0 : Number(rateRaw);
  if (!Number.isFinite(annualRatePercent)) {
    errors.push(['rate', '預期年報酬率必須是數字']);
  } else if (annualRatePercent < 0) {
    errors.push(['rate', '預期年報酬率不可為負值']);
  }

  const debts = [...debtList.children].map((row) => ({
    id: row.dataset.id,
    payment: parseAmount(row.querySelector('[data-role="payment"]').value) || 0,
    months: Math.max(0, Math.round(Number(row.querySelector('[data-role="months"]').value) || 0)),
  }));

  for (const name of ['years', 'cash', 'investment', 'expense', 'rate']) setFieldError(name, '');
  for (const [name, message] of errors) setFieldError(name, message);

  if (errors.length > 0) return null;

  return { years, cash, investment, annualRatePercent, monthlyExpense, debts };
}

/* ---------- 警示條 ---------- */

function renderWarnings(result, debtIndexById) {
  const messages = [];

  if (result.unsettled.length > 0) {
    const remaining = result.unsettled.reduce((s, d) => s + d.payment * d.monthsLeft, 0);
    messages.push(`有負債在試算期間結束時尚未繳完，剩餘還款總額 NT$ ${formatAmount(remaining)}`);
  }
  for (const id of result.zeroPaymentRows) {
    messages.push(`第 ${debtIndexById.get(id)} 筆負債尚未設定月付，此列不會計入還款`);
  }

  warningsNode.textContent = '';
  warningsNode.hidden = messages.length === 0;
  for (const text of messages) {
    const div = document.createElement('div');
    div.className = 'warning';
    div.textContent = text;
    warningsNode.appendChild(div);
  }
}

/* ---------- 結論卡 ---------- */

function describeDebtStatus(result) {
  if (result.startTotalDebt <= 0 && result.payoffs.length === 0) return '目前無負債';
  if (result.unsettled.length > 0) {
    const remaining = result.unsettled.reduce((s, d) => s + d.payment * d.monthsLeft, 0);
    return `有負債至期末仍未結清，剩餘還款總額 NT$ ${formatAmount(remaining)}`;
  }
  if (result.payoffs.length > 0) {
    const last = result.payoffs.reduce((a, b) => (b.month > a.month ? b : a));
    return `最後一筆負債於${monthLabel(last.month)}結清`;
  }
  return '目前無負債';
}

// 現金耗盡是與「總資產用完」不同的事件：現金歸零後改由提領投資支應，
// 投資本金因此逐月變小，投資報酬也跟著下降。
function describeCashExhaustion(result) {
  const cashMonth = result.cashExhaustMonth;

  if (cashMonth == null) {
    return '現金全期都夠支付支出，沒有動用到投資本金。';
  }

  // 總資產同月轉負 → 一開始就沒有投資可提領，講成「改由投資支應」會誤導
  if (result.exhaustMonth != null && result.exhaustMonth <= cashMonth) {
    return `現金在${monthLabel(cashMonth)}用完，且沒有足以支應的投資部位，缺口自此開始累積。`;
  }

  const drained = result.months.find((r) => r.endInvestment === 0 && r.withdrawal > 0);
  const tail = drained
    ? `投資也在${monthLabel(drained.m)}提領完畢。`
    : '投資本金會因此逐月變小，投資報酬也跟著下降。';

  return `現金在${monthLabel(cashMonth)}用完，之後每月改由提領投資支應——${tail}`;
}

function describeShortfallSpan(result) {
  // 資產在第 e 個月用完 → 只撐住了 e - 1 個完整月份
  const covered = result.exhaustMonth - 1;
  const short = result.N - covered;
  const y = Math.floor(short / 12);
  const m = short % 12;
  if (y > 0 && m > 0) return `還差 ${y} 年 ${m} 個月`;
  if (y > 0) return `還差 ${y} 年`;
  return `還差 ${m} 個月`;
}

// 每筆負債各自的付清時程
function buildPayoffSchedule(input, result, debtIndexById) {
  const payoffMonthById = new Map(result.payoffs.map((p) => [p.id, p.month]));
  const unsettledById = new Map(result.unsettled.map((d) => [d.id, d]));

  return input.debts
    .map((d) => {
      const label = `負債 ${debtIndexById.get(d.id)}`;
      const months = Math.round(d.months);
      const payment = Math.round(d.payment);

      if (months === 0 && payment === 0) return null; // 空白列不列入
      if (payment === 0) return { label, text: `${label}：未設定月付，不計入還款`, state: 'warn' };
      if (months === 0) return { label, text: `${label}（月付 ${formatAmount(payment)}）：已無剩餘月份`, state: 'done' };

      const paidMonth = payoffMonthById.get(d.id);
      if (paidMonth != null) {
        return {
          label,
          text: `${label}（月付 ${formatAmount(payment)}）：${monthLabel(paidMonth)} 付清`,
          state: 'done',
        };
      }
      const left = unsettledById.get(d.id);
      return {
        label,
        text: `${label}（月付 ${formatAmount(payment)}）：至期末仍未付清，尚餘 ${left ? left.monthsLeft : months} 期`,
        state: 'warn',
      };
    })
    .filter(Boolean);
}

function renderSummary(input, result, maxSpend, debtIndexById) {
  const years = input.years;
  const lines = [];
  let headline;

  if (maxSpend === null) {
    // 連 0 開銷都撐不過：不顯示開銷上限
    headline = `即使完全不花錢也撐不過 ${years} 年`;
    lines.push('缺口來自既有債務還款。');
    if (result.exhaustMonth != null) lines.push(`資產在${monthLabel(result.exhaustMonth)}用完。`);
    lines.push(describeCashExhaustion(result));
    lines.push(describeDebtStatus(result) + '。');
  } else if (result.exhaustMonth == null) {
    headline = `${years} 年後仍有 NT$ ${formatAmount(result.finalTotal)}`;
    lines.push(
      `期末現金 NT$ ${formatAmount(result.finalCash)}，期末投資金額 NT$ ${formatAmount(result.finalInvestment)}。`
    );
    lines.push(describeCashExhaustion(result));
    lines.push(describeDebtStatus(result) + '。');
    lines.push(
      maxSpend === 0
        ? '目前的資產只夠打平，可支撐的最高月開銷為 0。'
        : `在相同條件下，可支撐的最高月開銷約為 NT$ ${formatAmount(maxSpend)}。`
    );
    lines.push('本試算採固定名目支出、不計通膨，長期結果可能偏樂觀。');
  } else {
    headline = `資產在${monthLabel(result.exhaustMonth)}用完`;
    lines.push(
      `期末缺口 NT$ ${formatAmount(Math.abs(result.finalTotal))}，距離設定的 ${years} 年${describeShortfallSpan(result)}。`
    );
    lines.push(describeCashExhaustion(result));
    lines.push(
      maxSpend === 0
        ? `要撐滿 ${years} 年，月開銷必須降到 0——完全不花錢才剛好打平。`
        : `要撐滿 ${years} 年，月開銷需降到 NT$ ${formatAmount(maxSpend)} 以內。`
    );
    lines.push(describeDebtStatus(result) + '。');
    lines.push('本試算採固定名目支出、不計通膨，長期結果可能偏樂觀。');
  }

  const survives = result.exhaustMonth == null;
  resetSummary(survives ? 'is-ok' : 'is-short');

  const h = document.createElement('p');
  h.className = 'summary-headline';
  h.textContent = headline;
  summaryNode.appendChild(h);

  const ul = document.createElement('ul');
  ul.className = 'summary-notes';
  for (const line of lines) {
    const li = document.createElement('li');
    li.textContent = line;
    ul.appendChild(li);
  }
  summaryNode.appendChild(ul);

  // 每筆負債各自付清的年月
  const schedule = buildPayoffSchedule(input, result, debtIndexById);
  if (schedule.length > 0) {
    const box = document.createElement('div');
    box.className = 'payoff-schedule';

    const title = document.createElement('h3');
    title.textContent = '負債付清時程';
    box.appendChild(title);

    const list = document.createElement('ul');
    for (const item of schedule) {
      const li = document.createElement('li');
      li.className = `payoff-item is-${item.state}`;
      li.textContent = item.text;
      list.appendChild(li);
    }
    box.appendChild(list);
    summaryNode.appendChild(box);
  }
}

/* ---------- 報表 ---------- */

function amountCell(value) {
  const td = document.createElement('td');
  td.className = `num${value < 0 ? ' neg' : ''}`;
  td.textContent = formatAmount(value);
  return td;
}

function buildMonthRow(row, debtIndexById) {
  const tr = document.createElement('tr');
  tr.className = 'month-row';

  const label = document.createElement('td');
  label.className = 'period';
  label.textContent = monthLabel(row.m);
  if (row.payoffIds.length > 0) {
    for (const id of row.payoffIds) {
      const tag = document.createElement('span');
      tag.className = 'payoff-tag';
      tag.textContent = `負債 ${debtIndexById.get(id) ?? '?'} 結清 ✓`;
      label.appendChild(tag);
    }
  }
  tr.appendChild(label);

  for (const v of [
    row.startCash,
    row.startInvestment,
    row.ret,
    row.expense,
    row.repay,
    row.endCash,
    row.endInvestment,
    row.total,
  ]) {
    tr.appendChild(amountCell(v));
  }
  return tr;
}

function renderReport(result, debtIndexById) {
  reportTable.querySelectorAll('tbody').forEach((n) => n.remove());
  const years = Math.round(result.N / 12);

  for (let yr = 1; yr <= years; yr++) {
    const rows = result.months.slice((yr - 1) * 12, yr * 12);
    if (rows.length === 0) continue;

    const tbody = document.createElement('tbody');
    tbody.className = 'year-group';
    tbody.dataset.year = String(yr);

    const first = rows[0];
    const last = rows[rows.length - 1];
    const sum = (key) => rows.reduce((s, r) => s + r[key], 0);

    const tr = document.createElement('tr');
    tr.className = 'year-row';

    const th = document.createElement('th');
    th.scope = 'row';
    th.className = 'period';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'year-toggle';
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = `<span class="caret" aria-hidden="true">▸</span> 第 ${yr} 年`;
    th.appendChild(btn);

    // 該年有負債付清時，年列也標示，不必展開才看得到
    for (const row of rows) {
      for (const id of row.payoffIds) {
        const tag = document.createElement('span');
        tag.className = 'payoff-tag';
        tag.textContent = `負債 ${debtIndexById.get(id) ?? '?'} 於 ${String(((row.m - 1) % 12) + 1).padStart(2, '0')} 月結清 ✓`;
        th.appendChild(tag);
      }
    }
    tr.appendChild(th);

    for (const v of [
      first.startCash,
      first.startInvestment,
      sum('ret'),
      sum('expense'),
      sum('repay'),
      last.endCash,
      last.endInvestment,
      last.total,
    ]) {
      tr.appendChild(amountCell(v));
    }
    tbody.appendChild(tr);

    // 只有展開的年才建立月列 DOM
    const expand = (open) => {
      btn.setAttribute('aria-expanded', String(open));
      btn.querySelector('.caret').textContent = open ? '▾' : '▸';
      tbody.querySelectorAll('.month-row').forEach((n) => n.remove());
      if (open) {
        expandedYears.add(yr);
        for (const row of rows) tbody.appendChild(buildMonthRow(row, debtIndexById));
      } else {
        expandedYears.delete(yr);
      }
    };

    btn.addEventListener('click', () => expand(btn.getAttribute('aria-expanded') !== 'true'));
    if (expandedYears.has(yr)) expand(true);

    reportTable.appendChild(tbody);
  }
}

toggleAllBtn.addEventListener('click', () => {
  const open = toggleAllBtn.dataset.state !== 'open';
  toggleAllBtn.dataset.state = open ? 'open' : 'closed';
  toggleAllBtn.textContent = open ? '全部收合' : '全部展開';
  reportTable.querySelectorAll('.year-toggle').forEach((btn) => {
    if ((btn.getAttribute('aria-expanded') === 'true') !== open) btn.click();
  });
});

/* ---------- 主流程 ---------- */

// 結論卡每次重繪都會清空，標題由這裡統一補回
function resetSummary(stateClass) {
  summaryNode.className = `summary ${stateClass}`;
  summaryNode.textContent = '';
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.id = 'summary-title';
  title.textContent = '試算結論';
  summaryNode.appendChild(title);
}

function renderEmptyState() {
  resetSummary('is-empty');
  const p = document.createElement('p');
  p.className = 'empty-state';
  p.textContent = '填入「還要活多久」與資產金額，這裡就會顯示結論。';
  summaryNode.appendChild(p);

  chartContainer.textContent = '';
  const c = document.createElement('p');
  c.className = 'empty-state';
  c.textContent = '尚未有可繪製的資料。';
  chartContainer.appendChild(c);
  chartSummary.textContent = '';

  warningsNode.hidden = true;
  reportTable.querySelectorAll('tbody').forEach((n) => n.remove());
  reportEmpty.hidden = false;
}

function recalculate() {
  const input = readForm();
  if (!input) {
    // 有錯誤：算過就保留上一次的報表與圖，沒算過則維持空狀態
    if (!hasRendered) renderEmptyState();
    return;
  }

  const result = simulate(input);
  const maxSpend = maxSustainableExpense(input);
  lastResult = result;
  hasRendered = true;
  reportEmpty.hidden = true;

  const debtIndexById = new Map(input.debts.map((d, i) => [d.id, i + 1]));

  renderWarnings(result, debtIndexById);
  renderSummary(input, result, maxSpend, debtIndexById);
  renderReport(result, debtIndexById);
  renderChart(chartContainer, result, chartSummary);
}

// 換寬度時重畫，讓刻度文字維持可讀大小
if (typeof ResizeObserver !== 'undefined') {
  let lastWidth = 0;
  new ResizeObserver(() => {
    const w = chartContainer.clientWidth;
    if (lastResult && w > 0 && Math.abs(w - lastWidth) > 1) {
      lastWidth = w;
      renderChart(chartContainer, lastResult, chartSummary);
    }
  }).observe(chartContainer);
}

$('#form').addEventListener('submit', (e) => e.preventDefault());
document.querySelectorAll('input.money').forEach(bindMoneyInput);
['#years', '#rate'].forEach((sel) => {
  $(sel).addEventListener('input', recalculate);
  watchTouched($(sel));
});

renumberDebtRows();
recalculate();
