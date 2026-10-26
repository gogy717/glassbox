/**
 * The Stats page's words, in its own lazy chunk rather than the app's dictionaries (as the
 * receipt's are): the app's first load stays as it was. The words the slip prints come from the
 * receipt's own (`rt`), so the page and the receipt say them alike.
 */
import type { Locale } from '../../i18n';

const en = {
  window: 'Window',
  thisWeek: 'This week',
  last7: 'Last 7 days',
  print: 'Print weekly receipt',
  reading: 'Reading sessions…',
  range: '{span} · {n} {n|session|sessions} · {p} {p|project|projects}',
  when: 'When the agents worked',
  minutes: 'min',
  isolateHint: 'Hover a CLI or project to isolate it here',
  only: '{who} only · {time} · Esc or click again to unpin',
  onlyHover: '{who} only · {time}',
  cell: '{time} · {n} {n|session|sessions} · {cli} {cliTime}',
  cellIdle: 'No agent worked',
  cellAhead: 'Still to come',
  hourLine: '{time} agent time · {n} {n|session|sessions} · {cli} {cliTime}',
  hourIdle: 'No agent worked in this hour.',
  noTime: 'No agent time to show yet.',
  hourHint: 'The busiest hour is selected until you click another. Hover a cell for its minutes.',
  more: '{n} more',
  wayOut: 'Last 7 days has {n} {n|session|sessions} →',
  agentTime: 'agent time',
  cliHint: 'Hover to isolate in the grid · click to pin',
  projects: 'Top projects',
  projectsNote: 'agent time · sessions',
  longest: 'Longest sessions',
  longestNote: 'session time',
  tokensNote: 'cache read · cache write · uncached input · output',
  thinking: '({n} thinking)',
  apiCost: 'API cost (est.)',
  costTitle: 'What these tokens would cost on the API, estimated from the price table in Settings',
  costLeftOut: 'Left out, no price: {models}',
  costNoModel: 'calls that name no model',
  now: 'Right now',
  live: 'live',
  perMin: 'tokens/min',
  resets: 'resets {time}',
  noReset: 'no reset given',
  noQuota: 'No plan usage to show.',
  defaultNote:
    'Less than a day into the week, Stats opens on the last 7 days; This week counts from Monday.',
};

type Key = keyof typeof en;

const zh: Record<Key, string> = {
  window: '时间范围',
  thisWeek: '本周',
  last7: '最近 7 天',
  print: '打印本周小票',
  reading: '正在读取会话…',
  range: '{span} · {n} 个会话 · {p} 个项目',
  when: '代理什么时候在干活',
  minutes: '分钟',
  isolateHint: '把鼠标移到某个 CLI 或项目上，格子里只画它',
  only: '只看 {who} · {time} · 按 Esc 或再点一次取消',
  onlyHover: '只看 {who} · {time}',
  cell: '{time} · {n} 个会话 · {cli} {cliTime}',
  cellIdle: '没有代理在干活',
  cellAhead: '还没到',
  hourLine: '代理时长 {time} · {n} 个会话 · {cli} {cliTime}',
  hourIdle: '这一小时没有代理在干活。',
  noTime: '还没有代理时长可以显示。',
  hourHint: '默认选中最忙的一小时，点别的格子就换。把鼠标移到格子上看它的分钟数。',
  more: '还有 {n} 个',
  wayOut: '最近 7 天有 {n} 个会话 →',
  agentTime: '代理时长',
  cliHint: '移上去在格子里单独看 · 点一下钉住',
  projects: '项目',
  projectsNote: '代理时长 · 会话数',
  longest: '最长的会话',
  longestNote: '会话时长',
  tokensNote: '缓存读 · 缓存写 · 未缓存输入 · 输出',
  thinking: '（思考 {n}）',
  apiCost: 'API 费用（估）',
  costTitle: '这些 token 按 API 计价约值多少，按设置里的价格表估算',
  costLeftOut: '未计入（无价格）：{models}',
  costNoModel: '未注明模型的调用',
  now: '此刻',
  live: '实时',
  perMin: 'token/分钟',
  resets: '{time} 重置',
  noReset: '没有重置时间',
  noQuota: '没有可显示的用量。',
  defaultNote: '本周才开始不到一天，统计先显示最近 7 天；本周从周一起算。',
};

export type StatsKey = Key;
const STRINGS: Record<Locale, Record<Key, string>> = { en, zh };

/**
 * `key` in `locale`, its `{name}` placeholders filled from `params`, and `{n|one|other}` picked
 * by `n` (English plurals; Chinese has none).
 */
export function st(locale: Locale, key: Key, params: Record<string, string | number> = {}): string {
  return STRINGS[locale][key].replace(
    /\{(\w+)(?:\|([^|}]*)\|([^}]*))?\}/g,
    (whole, name: string, one?: string, other?: string) => {
      const v = params[name];
      if (v === undefined) return whole;
      if (one === undefined || other === undefined) return String(v);
      return Number(String(v).replace(/,/g, '')) === 1 ? one : other;
    },
  );
}
