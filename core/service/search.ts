import { searchResultJSON } from "../serialize.ts";
import * as S from "../store.ts";
import { repoOr404 } from "./shared.ts";

export const search = {
  query(name: string, query: string) {
    const repo = repoOr404(name);
    return S.searchIssuesAndPulls(repo.id, query).map(searchResultJSON);
  },
};
