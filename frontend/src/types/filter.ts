/** 通用筛选条件模型：FilterBar 组件与各页面共用 */
export interface FilterModel {
  keyword: string;
  [key: string]: string | string[] | boolean | number | null;
}

/** URL query → 字符串数组 */
export function queryToArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string' && value.length > 0) return value.split(',').filter((item) => item.length > 0);
  return [];
}

/** URL query → 数字或 null */
export function queryToNumber(value: unknown): number | null {
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** URL query → 布尔 */
export function queryToBool(value: unknown): boolean {
  return value === '1' || value === 'true' || value === true;
}

/** 构造 query 对象（空值不写入，保持 URL 干净） */
export function buildQuery(
  entries: Record<string, string | number | boolean | string[] | null | undefined>
): Record<string, string> {
  const query: Record<string, string> = {};
  Object.entries(entries).forEach(([key, value]) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      if (value.length > 0) query[key] = value.join(',');
      return;
    }
    if (typeof value === 'string') {
      if (value.trim().length > 0) query[key] = value.trim();
      return;
    }
    if (typeof value === 'number') {
      query[key] = String(value);
      return;
    }
    if (value) query[key] = '1';
  });
  return query;
}
