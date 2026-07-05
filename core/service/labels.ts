import { labelJSON, repoOr404, S } from "./shared.ts";

// ===== labels =====
export const labels = {
  list(name: string) {
    const r = repoOr404(name);
    return S.listLabels(r.id).map(labelJSON);
  },
};
