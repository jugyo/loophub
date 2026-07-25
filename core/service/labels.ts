import { labelJSON } from "../serialize.ts";
import * as S from "../store.ts";
import { repoOr404 } from "./shared.ts";

// ===== labels =====
export const labels = {
  list(name: string) {
    const r = repoOr404(name);
    return S.listLabels(r.id).map(labelJSON);
  },
};
