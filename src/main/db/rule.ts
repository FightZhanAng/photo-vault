import type { SmartRule } from '@shared/ipc';

/** ruleJson 是用户可编辑的库内数据，解析失败时当作「无规则」而不是崩掉 */
export function parseRule(json: string | null | undefined): SmartRule | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as SmartRule;
  } catch {
    return null;
  }
}

export function isEmptyRule(rule: SmartRule | null | undefined): boolean {
  if (!rule) return true;
  return (
    !rule.status?.length &&
    typeof rule.from !== 'number' &&
    typeof rule.to !== 'number' &&
    !rule.tagIds?.length &&
    !rule.favoriteOnly &&
    typeof rule.hasGps !== 'boolean' &&
    !rule.minWidth &&
    !rule.minHeight &&
    !rule.ext?.length &&
    !rule.keyword?.trim()
  );
}
