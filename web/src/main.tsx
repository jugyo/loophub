import { bootstrap } from "./bootstrap";
import "./index.css";
import "./typeset.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");
// Not awaited: nothing here depends on the result, and a top-level await would put this module
// outside what `Bun.build` targets. bootstrap renders its own startup error, and anything it
// cannot handle surfaces as an unhandled rejection in the console.
void bootstrap(rootEl);
