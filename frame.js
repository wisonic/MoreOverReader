'use strict';

/**
 * Pure ANSI frame builder for the fake "AI coding session" terminal.
 * No vscode import — testable headless in Node.
 */

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
  blue: '\x1b[34m', magenta: '\x1b[35m', red: '\x1b[31m', gray: '\x1b[90m',
};

const FILLERS = [
  '  4. 空状态插画换成 SVG，减小包体',
  '  5. 把列表虚拟化，长列表滚动不掉帧',
  '  6. 错误边界兜底，白屏上报 Sentry',
  '  7. 接口超时统一收到 8s，配重试退避',
  '  8. 表单校验文案对齐设计稿',
  '  9. 入口埋点补齐，漏斗能对上',
  '  10. 灰度开关下发缓存到本地',
  '  11. 无障碍标签补一轮',
  '  12. 深色模式变量接入 token',
  '  13. 删掉废弃的 legacy 分支逻辑',
  '  14. 拆个 hook 出去，别都堆在页面里',
  '  15. 加一条 E2E 回归用例',
];

/** Dim work lines shown INSTEAD of book text when hidden — same line count,
 *  so hiding never changes the frame height (no jitter). Deterministic per seed. */
function buildFiller(seed, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(C.dim + FILLERS[(seed + i) % FILLERS.length] + C.reset);
  }
  return out;
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${sec}s`;
}

function bar(pct, width = 16) {
  const filled = Math.max(0, Math.min(width, Math.round(pct / 100 * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** Terminal display width: CJK/fullwidth chars take 2 columns. */
function charW(cp) {
  if (cp >= 0x1100 && cp <= 0x115f) return 2;
  if (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) return 2;
  if (cp >= 0xac00 && cp <= 0xd7a3) return 2;
  if (cp >= 0xf900 && cp <= 0xfaff) return 2;
  if (cp >= 0xfe30 && cp <= 0xfe6f) return 2;
  if (cp >= 0xff00 && cp <= 0xff60) return 2;
  if (cp >= 0xffe0 && cp <= 0xffe6) return 2;
  if (cp >= 0x20000 && cp <= 0x3fffd) return 2;
  return 1;
}

/**
 * Pre-wrap a paragraph into reading lines of ≤maxCols terminal columns.
 * Never cuts inside a [n]/(n)/（n） marker so footnote chips stay whole.
 * No ellipsis — the full text is preserved across the wrapped lines.
 */
function wrapText(text, maxCols = 82) {
  const s = String(text);
  const ranges = [];
  { const re = /([[(（])(\d{1,3})([\])）])/g; let m;
    while ((m = re.exec(s)) !== null) ranges.push([m.index, m.index + m[0].length]); }
  const chars = Array.from(s);
  const widths = chars.map(c => charW(c.codePointAt(0)));
  const out = [];
  let chunkStart = 0, w = 0;
  for (let i = 0; i < chars.length; i++) {
    w += widths[i];
    if (w > maxCols && i > chunkStart) {
      let cut = i;
      const r = ranges.find(([a, b]) => cut > a && cut < b);
      if (r && r[0] > chunkStart) cut = r[0];   // keep marker whole
      out.push(chars.slice(chunkStart, cut).join(''));
      chunkStart = cut;
      w = widths.slice(chunkStart, i + 1).reduce((sum, x) => sum + x, 0);
    }
  }
  if (chunkStart < chars.length) out.push(chars.slice(chunkStart).join(''));
  return out.length ? out : [''];
}

/** Window of book lines ending at `line` (lines are pre-wrapped at load). */
function buildBookWindow(book, line, count) {
  const from = Math.max(0, line - Math.max(1, count) + 1);
  const out = [];
  for (let i = from; i <= line; i++) {
    const b = book.flat[i];
    if (!b) continue;
    if (b.head) out.push(C.bold + C.cyan + b.text + C.reset);
    else if (b.t === 'img') out.push(C.dim + '  [插图 · 按 i 查看]' + C.reset);
    else out.push('  ' + b.text);
  }
  return out.join('\r\n');
}

/** Notes block: all currently shown notes, each on its own line. */
function buildNotes(notes) {
  return notes.map(n =>
    C.yellow + '  ⎿ 注 ' + n.n + '：' + n.text + C.reset,
  ).join('\r\n');
}

function buildStatus(s) {
  const pct = s.total ? Math.min(100, Math.floor((s.line / s.total) * 100)) : 0;
  return [
    C.dim + '  ⎿  q hide · Q quit · d toggle · n/p step · j jump · e notes · i image · a auto' + C.reset,
    C.magenta + '*' + C.reset + ' Sautéed for ' + fmtElapsed(s.elapsedMs) + ' · ' + s.chapter + ' · ' + pct + '%'
      + '        ' + C.dim + 'new task? /clear to save 308.4k tokens' + C.reset,
    '',
    C.green + '›' + C.reset,
    C.gray + '[' + s.model + '] ' + C.reset + bar(pct) + ' ' + pct + '% | 💰 $' + s.cost + ' | ⏱ ' + fmtElapsed(s.elapsedMs),
  ].join('\r\n');
}

/**
 * @param {object} s
 * s = { fake: string,            ANSI fake-work transcript (always shown)
 *       book, line, visible,     book + current flat index + book-text visibility
 *       lines: number,           visible book-line window size (config)
 *       chapter: string,         e.g. "3/12 · 第三章"
 *       notes, notesVisible,     [{n, text}] — all markers in the visible window
 *       afterText: string,       ANSI block glued right below the book text (fake diff)
 *       elapsedMs, cost, model }
 */
function buildFrame(s) {
  const parts = [];
  parts.push(s.fake);
  parts.push('');
  if (s.book) {
    if (s.visible) {
      parts.push(buildBookWindow(s.book, s.line, s.lines || 3));
      if (s.notesVisible && s.notes && s.notes.length) {
        parts.push(buildNotes(s.notes));
      }
    } else {
      // hidden: same number of dim work lines so the frame height never jumps
      parts.push(buildFiller(s.tick || 0, s.lines || 3).join('\r\n'));
    }
    if (s.afterText) {
      parts.push('');
      parts.push(s.afterText);
    }
    parts.push('');
  }
  parts.push(buildStatus({
    total: s.book ? s.book.total : 0,
    line: s.line || 0,
    chapter: s.chapter || '',
    elapsedMs: s.elapsedMs || 0,
    cost: s.cost || '16.17',
    model: s.model || 'opus-4.8[1m]',
  }));
  return '\x1b[2J\x1b[3J\x1b[H' + parts.join('\r\n');
}

module.exports = { buildFrame, buildBookWindow, buildNotes, buildStatus, wrapText, C, fmtElapsed, bar };
