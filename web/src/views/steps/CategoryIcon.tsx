import {
  CircleHelp,
  Globe,
  ListTodo,
  type LucideIcon,
  MessageSquareText,
  Pencil,
  Search,
  Terminal,
  Users,
  Wrench,
} from 'lucide-react';
import type { PhaseCategory } from '../../lib/steps';
import type { ToolCategory } from '../../lib/tool-category';

const ICONS: Record<PhaseCategory | ToolCategory, LucideIcon> = {
  explore: Search,
  edit: Pencil,
  run: Terminal,
  delegate: Users,
  ask: CircleHelp,
  plan: ListTodo,
  web: Globe,
  other: Wrench,
  answer: MessageSquareText,
};

export function CategoryIcon({
  category,
  size = 14,
}: {
  category: PhaseCategory | ToolCategory;
  size?: number;
}) {
  const Icon = ICONS[category];
  return (
    <Icon
      size={size}
      aria-hidden="true"
      style={{ color: `var(--cat-${category})`, flex: 'none' }}
    />
  );
}
