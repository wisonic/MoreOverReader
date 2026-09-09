'use strict';

/**
 * The fake "AI coding session" transcript that always fills the terminal —
 * what a passer-by actually reads. The book text is interleaved below it
 * (toggle d), so when hidden it's 100% work content.
 */

const { C } = require('./frame');

function pick(arr, seed) {
  return arr[Math.abs(seed) % arr.length];
}

const THINKINGS = [
  // each entry: user task + assistant plan + note
  [
    '我先看了订单列表和接口封装，问题集中在分页状态没有和筛选条件一起重置。方案如下：',
    '  1. 把 pageParam 统一交给 useInfiniteQuery 管理\r\n' +
    '  2. 筛选条件变化时清空本地 selection / scroll anchor\r\n' +
    '  3. 补 loading、空状态、失败重试和边界单测',
    'Notes: API 返回 nextCursor=null 时应停止请求，避免重复拉最后一页',
  ],
  [
    '登录态偶发丢失，排查了一圈，焦点在 token 刷新竞态。计划：',
    '  1. refresh 加单飞锁，并发请求共享同一个 promise\r\n' +
    '  2. 401 重试队列化，刷新成功后统一放行\r\n' +
    '  3. 补一条 401→refresh→重放的集成测试',
    'Notes: 刷新失败要清队列并跳登录，别把用户晾在白屏',
  ],
  [
    '首页 LCP 超标，主要是首屏图片和字体阻塞。优化方案：',
    '  1. 首图 preload + fetchpriority=high\r\n' +
    '  2. 字体子集化，font-display: swap\r\n' +
    '  3. 骨架屏替换 loading 菊花，减少 CLS',
    'Notes: 实验组 LCP 4.2s → 2.1s，灰度 10% 观察一周',
  ],
];

const G = C.green, R = C.red, Y = C.cyan, D = C.dim, N = C.reset;

function colorizeDiff(header, hunk, lines) {
  return D + header + N + '\r\n' +
    Y + hunk + N + '\r\n' +
    lines.map(l => /\-\s/.test(l.slice(0, 6)) ? R + l + N : G + l + N).join('\r\n');
}

const DIFFS = [
  colorizeDiff(
    '✏️  Updated src/api/orders.ts',
    '     @@ -24,7 +24,12 @@',
    [
      '   -  const res = await fetch(\'/api/orders\')',
      '   +  const params = new URLSearchParams({ page, size: \'20\', status })',
      '   +  const res = await fetch(\'/api/orders?\' + params.toString())',
      '   +  if (!res.ok) throw new Error(\'订单加载失败\')',
    ],
  ),
  colorizeDiff(
    '✏️  Updated src/hooks/useAuth.ts',
    '     @@ -42,7 +42,11 @@',
    [
      '   -  const t = await refresh()',
      '   +  inflight = inflight || refresh()',
      '   +  const t = await inflight.finally(() => { inflight = null })',
    ],
  ),
  colorizeDiff(
    '✏️  Updated src/pages/Home.tsx',
    '     @@ -18,6 +18,9 @@',
    [
      '   +  <link rel="preload" as="image" href={hero} fetchpriority="high" />',
      '   +  {loading ? <Skeleton /> : <Feed />}',
    ],
  ),
];

const TESTS = [
  '● npm test -- --runInBand orders  ' + C.green + '✓ 18 passed (2.4s)' + C.reset,
  '● npm test auth:e2e  ' + C.green + '✓ 9 passed (5.1s)' + C.reset,
  '● npm run build  ' + C.green + '✓ bundle 214kb (gzip 68kb)' + C.reset,
  '● npm run lint  ' + C.green + '✓ no issues' + C.reset,
];

/** Build a deterministic fake-work transcript (thinking/plan only — no diff here). */
function buildFake(seed) {
  const [task, plan, note] = pick(THINKINGS, seed >> 2);
  return [
    C.gray + '● I\'ll keep the terminal rendering state local and reuse the shared renderer.' + C.reset,
    '',
    C.bold + C.green + '⏺ ' + task + C.reset,
    plan,
    '',
    C.dim + note + C.reset,
    '',
  ].join('\r\n');
}

/** Fake diff + test block glued right under the book text. */
function buildAfter(seed) {
  return pick(DIFFS, seed) + '\r\n' + pick(TESTS, seed + 1);
}

module.exports = { buildFake, buildAfter };
