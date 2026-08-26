export type RepoSortItem = {
  favorite: boolean | number;
  full_name: string;
};

export function compareRepos(a: RepoSortItem, b: RepoSortItem): number {
  const aFavorite = Boolean(a.favorite);
  const bFavorite = Boolean(b.favorite);
  if (aFavorite !== bFavorite) return aFavorite ? -1 : 1;
  return a.full_name.localeCompare(b.full_name, undefined, {
    sensitivity: "base",
  });
}
