import { bootstrap } from "./bootstrap";
import "./index.css";
import "./typeset.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");
await bootstrap(rootEl);
