import { type WebConfigWire, webConfigJSON } from "../../core/serialize.ts";

let config = webConfigJSON(false);

export function setWebRuntimeConfig(next: WebConfigWire): void {
  config = webConfigJSON(next.experimental);
}

export function webRuntimeConfig(): WebConfigWire {
  return config;
}
