/**
 * The receipt's words, in the lazy receipt chunk rather than the app's dictionaries: the app's
 * first load stays as it was. The receipt itself is worded in the language chosen for it; the
 * dialog around it in the app's.
 */
import type { Locale } from '../../i18n';

const en = {
  // On the receipt.
  heading: 'RECEIPT',
  duration: 'DURATION',
  work: 'WORK',
  time: 'TIME',
  tokens: 'TOKENS',
  total: 'TOTAL',
  modelCalls: '{n|Model call|Model calls}',
  toolCalls: '{n|Tool call|Tool calls}',
  subAgents: '{n|Sub-agent|Sub-agents}',
  conversations: '{n|Conversation|Conversations}',
  failures: '{n|Failure|Failures}',
  compactions: '{n|Compaction|Compactions}',
  thinking: 'Thinking',
  generating: 'Generating',
  tools: 'Tools',
  approval: 'Waiting for you',
  queued: 'Waiting',
  longestThink: 'Longest think',
  cacheRead: 'Cache read',
  cacheWrite: 'Cache write',
  uncached: 'Uncached input',
  output: 'Output',
  ofThinking: 'of which thinking',
  cacheHit: 'Cache hit',
  notReported: 'Tokens not reported',
  untitled: 'Untitled session',
  effort: '{e} effort',
  now: 'now',
  stillRunning: 'still running',
  printedBy: 'Printed by glassbox',
  motto: 'Every token accounted for.',
  // The dialog.
  dialog: 'Receipt',
  size: 'Size',
  tall: 'Tall',
  post: 'Post 4:5',
  story: 'Story 9:16',
  paper: 'Paper',
  paperPaper: 'Paper',
  paperNight: 'Night',
  language: 'Language',
  hideNames: 'Hide names',
  hideNamesHint: 'Withholds the title and the project',
  off: 'Off',
  on: 'On',
  copyImage: 'Copy image',
  download: 'Download PNG',
  copyText: 'Copy as text',
  local: 'Made in your browser from the data on this page. Nothing leaves this machine.',
  copied: 'Image copied',
  copiedText: 'Text copied',
  downloaded: 'Downloaded',
  failed: 'Could not make the image: {msg}',
  preview: 'Receipt, {w} × {h}; its text follows',
};

type Key = keyof typeof en;

const zh: Record<Key, string> = {
  heading: '小票',
  duration: '总耗时',
  work: '工作',
  time: '时间',
  tokens: 'TOKEN',
  total: '总量',
  modelCalls: '模型调用',
  toolCalls: '工具调用',
  subAgents: '子代理',
  conversations: '轮次',
  failures: '失败',
  compactions: '上下文压缩',
  thinking: '思考',
  generating: '生成',
  tools: '工具',
  approval: '等待用户',
  queued: '排队',
  longestThink: '最长一次思考',
  cacheRead: '缓存读',
  cacheWrite: '缓存写',
  uncached: '未缓存输入',
  output: '输出',
  ofThinking: '其中思考',
  cacheHit: '缓存命中率',
  notReported: '未报告 token 用量',
  untitled: '未命名会话',
  effort: '{e} effort',
  now: '现在',
  stillRunning: '仍在运行',
  printedBy: '由 glassbox 打印',
  motto: '每一个 token 都有去处。',
  dialog: '小票',
  size: '尺寸',
  tall: '长条',
  post: '帖子 4:5',
  story: '快拍 9:16',
  paper: '底色',
  paperPaper: '纸',
  paperNight: '夜',
  language: '语言',
  hideNames: '隐去名字',
  hideNamesHint: '不印标题和项目名',
  off: '关',
  on: '开',
  copyImage: '复制图片',
  download: '下载 PNG',
  copyText: '复制为文本',
  local: '在你的浏览器里用本页的数据生成，什么都不离开这台机器。',
  copied: '已复制图片',
  copiedText: '已复制文本',
  downloaded: '已下载',
  failed: '生成图片失败：{msg}',
  preview: '小票，{w} × {h}；文字版在后面',
};

export type ReceiptKey = Key;
export const RECEIPT_STRINGS: Record<Locale, Record<Key, string>> = { en, zh };

/**
 * `key` in `locale`, its `{name}` placeholders filled from `params`, and `{n|one|other}` picked
 * by `n` (English plurals; Chinese has none).
 */
export function rt(locale: Locale, key: Key, params: Record<string, string | number> = {}): string {
  return RECEIPT_STRINGS[locale][key].replace(
    /\{(\w+)(?:\|([^|}]*)\|([^}]*))?\}/g,
    (whole, name: string, one?: string, other?: string) => {
      const v = params[name];
      if (v === undefined) return whole;
      if (one === undefined || other === undefined) return String(v);
      return Number(v) === 1 ? one : other;
    },
  );
}
