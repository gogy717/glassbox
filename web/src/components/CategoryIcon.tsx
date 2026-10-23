import {
  CircleHelp,
  GitBranch,
  Globe,
  ListTodo,
  type LucideIcon,
  MessageSquareText,
  Pencil,
  Plug,
  Search,
  Terminal,
  Users,
  Wrench,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import type { PhaseCategory } from '../lib/steps';
import type { ToolCategory } from '../lib/tool-category';
import css from './CategoryIcon.module.css';

const ICONS: Record<PhaseCategory | ToolCategory, LucideIcon> = {
  explore: Search,
  edit: Pencil,
  run: Terminal,
  git: GitBranch,
  delegate: Users,
  ask: CircleHelp,
  plan: ListTodo,
  web: Globe,
  mcp: Plug,
  other: Wrench,
  answer: MessageSquareText,
};

/** With a `label`, the icon names its category (accessible name and tooltip); else it is decoration. */
export function CategoryIcon({
  category,
  size = 14,
  label,
}: {
  category: PhaseCategory | ToolCategory;
  size?: number;
  label?: string;
}) {
  const Icon = ICONS[category];
  const style = { '--cat': `var(--cat-${category})` } as CSSProperties;
  if (!label) return <Icon size={size} aria-hidden="true" className={css.icon} style={style} />;
  return (
    <span role="img" aria-label={label} title={label} className={css.labelled} style={style}>
      <Icon size={size} aria-hidden="true" className={css.icon} />
    </span>
  );
}
