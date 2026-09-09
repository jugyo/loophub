import { ServiceError } from "../errors.ts";
import * as J from "../store/jobs.ts";
import * as S from "../store.ts";

export const jobs = {
  enqueue: J.enqueue,
  claimNext: J.claimNext,
  heartbeat: J.heartbeat,
  finish: J.finish,
  repoName(repoId: number): string {
    const repo = S.getRepoById(repoId);
    if (!repo) throw new ServiceError(404, "Repository not found");
    return repo.full_name;
  },
};
