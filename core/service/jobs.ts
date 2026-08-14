import * as J from "../store/jobs.ts";

export const jobs = {
  enqueue: J.enqueue,
  claimNext: J.claimNext,
  heartbeat: J.heartbeat,
  finish: J.finish,
};
