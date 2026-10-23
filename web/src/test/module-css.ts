/// <reference types="node" />
import { readFileSync } from 'node:fs';
import postcss, { type Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';

/**
 * The value a CSS module gives `prop` on a rendered element: the most specific matching rule,
 * then the last. jsdom applies no module CSS, so the module's rules are matched here, with each
 * `.name` read as the hashed class the component received (`classes`, the module's import).
 * Rules inside at-rules (keyframes, media) are left out.
 */
export function moduleCssValue(
  file: string,
  classes: Record<string, string>,
  el: Element,
  prop: string,
): string | undefined {
  const found: { spec: number; order: number; value: string }[] = [];
  let order = 0;
  postcss.parse(readFileSync(file, 'utf8')).walkRules((rule: Rule) => {
    if (rule.parent?.type !== 'root') return;
    const decl = rule.nodes.findLast((n) => n.type === 'decl' && n.prop === prop);
    selectorParser((root) => {
      for (const selector of root.nodes) {
        let spec = 0;
        selector.walk((node) => {
          if (node.type === 'class') {
            node.value = classes[node.value] ?? node.value;
            spec += 100;
          } else if (node.type === 'attribute' || node.type === 'pseudo') spec += 100;
          else if (node.type === 'tag') spec += 1;
        });
        order++;
        if (decl?.type === 'decl' && el.matches(selector.toString()))
          found.push({ spec, order, value: decl.value });
      }
    }).processSync(rule.selector);
  });
  found.sort((a, b) => a.spec - b.spec || a.order - b.order);
  return found.at(-1)?.value;
}
