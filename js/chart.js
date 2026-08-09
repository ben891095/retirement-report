// 手繪 SVG 折線圖，無函式庫。
// 三條線：現金、投資金額、負債（剩餘還款總額）。
// viewBox 寬度直接取容器的實際 CSS 像素寬（1 單位 = 1px），不做等比縮放，
// 否則刻度文字在 375px 螢幕會被縮到約 3px 而無法閱讀。

import { formatAmount } from './money.js';
import { monthLabel, shortMonthLabel } from './calc.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text != null) node.textContent = text;
  return node;
}

// 把數值範圍切成好看的刻度（1 / 2 / 5 × 10^k）
function niceStep(range, targetTicks) {
  const raw = range / targetTicks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)));
  const normalized = raw / magnitude;
  let step;
  if (normalized <= 1) step = 1;
  else if (normalized <= 2) step = 2;
  else if (normalized <= 5) step = 5;
  else step = 10;
  return step * magnitude;
}

function compactAmount(v) {
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(abs % 1e8 === 0 ? 0 : 1)} 億`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(abs % 1e4 === 0 ? 0 : 1)} 萬`;
  return formatAmount(v);
}

export function renderChart(container, result, summaryNode) {
  container.textContent = '';

  const width = Math.max(container.clientWidth || 0, 280);
  const height = width < 480 ? 260 : 320;
  const pad = { top: 18, right: 18, bottom: 38, left: width < 480 ? 64 : 82 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  // 序列從第 0 個月（期初）開始，讓起點看得到。
  const cashLine = [result.startCash, ...result.months.map((r) => r.endCash)];
  const investLine = [result.startInvestment, ...result.months.map((r) => r.endInvestment)];
  const debtLine = [result.startTotalDebt, ...result.months.map((r) => r.remainingDebtTotal)];
  const lastIndex = cashLine.length - 1;

  let minValue = Math.min(0, ...cashLine);
  let maxValue = Math.max(0, ...cashLine, ...investLine, ...debtLine);
  // 全為 0、或所有值相同時，Y 軸範圍會是 0，要撐開才不會除以零。
  if (maxValue - minValue < 1) {
    const center = (maxValue + minValue) / 2;
    minValue = center - 1;
    maxValue = center + 1;
  }

  const step = niceStep(maxValue - minValue, 4);
  const axisMin = Math.floor(minValue / step) * step;
  const axisMax = Math.ceil(maxValue / step) * step;
  const span = axisMax - axisMin || 1;

  const x = (i) => pad.left + (lastIndex === 0 ? 0 : (i / lastIndex) * innerW);
  const y = (v) => pad.top + ((axisMax - v) / span) * innerH;

  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: 'img',
    'aria-labelledby': 'chart-title-text',
  });
  svg.appendChild(el('title', { id: 'chart-title-text' }, '現金、投資金額與負債的逐月變化'));

  // 總資產為負的區段：累計資金缺口（不計利息）
  if (axisMin < 0) {
    const zeroY = y(0);
    const bottomY = y(axisMin);
    svg.appendChild(
      el('rect', {
        class: 'chart-gap',
        x: pad.left,
        y: zeroY,
        width: innerW,
        height: Math.max(bottomY - zeroY, 0),
      })
    );
    if (Math.min(...cashLine) < 0) {
      svg.appendChild(
        el(
          'text',
          { class: 'chart-gap-label', x: pad.left + 6, y: Math.min(zeroY + 16, height - pad.bottom - 4) },
          '累計資金缺口'
        )
      );
    }
  }

  // Y 軸刻度
  for (let v = axisMin; v <= axisMax + step / 2; v += step) {
    const gy = y(v);
    svg.appendChild(el('line', { class: 'chart-grid', x1: pad.left, y1: gy, x2: width - pad.right, y2: gy }));
    svg.appendChild(
      el('text', { class: 'chart-tick chart-tick-y', x: pad.left - 8, y: gy + 4 }, compactAmount(v))
    );
  }

  // y = 0 基準線
  if (axisMin < 0 && axisMax > 0) {
    svg.appendChild(
      el('line', { class: 'chart-zero', x1: pad.left, y1: y(0), x2: width - pad.right, y2: y(0) })
    );
  }

  // X 軸年刻度：依可用寬度決定間隔，避免標籤重疊
  const years = Math.round(result.N / 12);
  const maxLabels = Math.max(2, Math.floor(innerW / 52));
  const yearStep = Math.max(1, Math.ceil(years / maxLabels));
  for (let yr = 0; yr <= years; yr += yearStep) {
    const gx = x(yr * 12);
    svg.appendChild(
      el('line', { class: 'chart-grid', x1: gx, y1: pad.top, x2: gx, y2: pad.top + innerH })
    );
    svg.appendChild(
      el('text', { class: 'chart-tick chart-tick-x', x: gx, y: height - pad.bottom + 18 }, `${yr} 年`)
    );
  }

  // 負債結清的垂直虛線；相近月份的標籤合併，避免文字重疊
  const groups = [];
  for (const p of [...result.payoffs].sort((a, b) => a.month - b.month)) {
    const px = x(p.month);
    const last = groups[groups.length - 1];
    if (last && px - last.x < 40) last.items.push(p);
    else groups.push({ x: px, month: p.month, items: [p] });
  }
  for (const g of groups) {
    svg.appendChild(
      el('line', { class: 'chart-payoff', x1: g.x, y1: pad.top, x2: g.x, y2: pad.top + innerH })
    );
    const label = g.items.length > 1 ? `${g.items.length} 筆結清` : '負債結清';
    const anchor = g.x > width - pad.right - 60 ? 'end' : 'start';
    svg.appendChild(
      el(
        'text',
        { class: 'chart-payoff-label', x: anchor === 'end' ? g.x - 4 : g.x + 4, y: pad.top + 12, 'text-anchor': anchor },
        label
      )
    );
  }

  const toPath = (series) =>
    series.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');

  // 負債（剩餘還款總額）：無負債時全為 0，不畫以免與基準線混淆
  if (debtLine.some((v) => v > 0)) {
    svg.appendChild(el('path', { class: 'chart-line-debt', d: toPath(debtLine) }));
  }
  svg.appendChild(el('path', { class: 'chart-line-invest', d: toPath(investLine) }));
  svg.appendChild(el('path', { class: 'chart-line-cash', d: toPath(cashLine) }));

  // 歸零交叉點：紅點與標籤。總資產轉負時投資必為 0，故交叉點落在現金線上。
  if (result.exhaustMonth != null) {
    const i = result.exhaustMonth;
    const cx = x(i);
    const cy = y(cashLine[i]);
    svg.appendChild(el('circle', { class: 'chart-exhaust-dot', cx, cy, r: 4 }));
    const anchor = cx > width * 0.6 ? 'end' : 'start';
    svg.appendChild(
      el(
        'text',
        {
          class: 'chart-exhaust-label',
          x: anchor === 'end' ? cx - 8 : cx + 8,
          y: Math.max(cy - 10, pad.top + 24),
          'text-anchor': anchor,
        },
        `${shortMonthLabel(i)} 用完`
      )
    );
  }

  container.appendChild(svg);

  if (summaryNode) summaryNode.textContent = buildTextSummary(result);
}

// 圖表的文字摘要，供輔助技術讀取
export function buildTextSummary(result) {
  const parts = [];
  const years = Math.round(result.N / 12);
  parts.push(
    `圖表顯示 ${years} 年、共 ${result.N} 個月的三條線：現金、投資金額與負債。` +
      `期末現金 ${formatAmount(result.finalCash)} 元，` +
      `期末投資金額 ${formatAmount(result.finalInvestment)} 元，` +
      `總資產 ${formatAmount(result.finalTotal)} 元。`
  );

  if (result.cashExhaustMonth != null) {
    parts.push(`現金在${monthLabel(result.cashExhaustMonth)}首次不足以支應當月支出，自此開始提領投資。`);
  } else {
    parts.push('現金全期都夠支付支出，未動用投資本金。');
  }

  if (result.exhaustMonth != null) {
    parts.push(`總資產在${monthLabel(result.exhaustMonth)}首次低於 0，之後為累計資金缺口，此缺口不計利息。`);
  } else {
    parts.push('總資產全期未低於 0。');
  }

  if (result.startTotalDebt <= 0) {
    parts.push('目前無負債，剩餘還款總額全期為 0。');
  } else if (result.unsettled.length > 0) {
    const remaining = result.unsettled.reduce((s, d) => s + d.payment * d.monthsLeft, 0);
    parts.push(`有 ${result.unsettled.length} 筆負債至期末仍未結清，剩餘還款總額 ${formatAmount(remaining)} 元。`);
  } else if (result.payoffs.length > 0) {
    const last = result.payoffs.reduce((a, b) => (b.month > a.month ? b : a));
    parts.push(`所有負債於${monthLabel(last.month)}前結清，最後一筆在${monthLabel(last.month)}。`);
  }

  return parts.join('');
}
