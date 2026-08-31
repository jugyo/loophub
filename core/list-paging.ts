// Pure paging limits and slicing helpers for list procedures. Kept free of store/db imports so a
// caller can read the limits without opening the database.

export const DEFAULT_LIST_PER_PAGE = 30;
export const MAX_LIST_PER_PAGE = 100;

export function clampPerPage(
  perPage: number | undefined,
  def: number,
  max: number,
): number {
  let v = Number(perPage ?? def);
  if (!Number.isFinite(v) || v < 1) v = def;
  return Math.min(v, max);
}

export function paginate<T>(rows: T[], perPage: number, page: number): T[] {
  const offset = (page - 1) * perPage;
  return rows.slice(offset, offset + perPage);
}
