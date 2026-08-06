/**
 * Markers a source-event producer writes into the ordinary event payload.
 *
 * Readers that used to decide "was this write the run's own" lived here; delivery no longer asks
 * that question. What remains is the payload-version marker cutover producers still stamp so a
 * reader can tell current rows from pre-cutover ones.
 */

/**
 * The version of the source payload contract. A source event carrying it holds the stable ids and
 * producer session id a reader can rely on; rows written before the cutover lack it, which is how
 * the run's observation trail tells the two apart.
 */
export const SOURCE_PAYLOAD_VERSION = 1;
