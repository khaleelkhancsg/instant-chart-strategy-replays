// Fast search primitives -- moved to src/search.mjs, re-exported here so every
// research script keeps working. bracketGrid alone differs: the mega-search
// results were measured on the engine before its intrabar order was made
// explicit, so here it defaults to that engine (LEGACY_EXEC) and stays
// reproducible. New searches import src/search.mjs, which runs today's engine.

import { bracketGrid as gridNow } from "../src/search.mjs";
import { LEGACY_EXEC } from "../src/engine.mjs";

export { DAY, flatten, fastWindow, fastSweep, assertParity, windowStarts } from "../src/search.mjs";

export function bracketGrid(bars, strategy, params, slList, tpList, baseExec = {}) {
  return gridNow(bars, strategy, params, slList, tpList, { ...LEGACY_EXEC, ...baseExec });
}
