import { type WebConfigWire, webConfigJSON } from "../../core/serialize.ts";

let config = webConfigJSON(false, false);

export function setWebRuntimeConfig(next: WebConfigWire): void {
  config = webConfigJSON(next.experimental, next.legacy);
}

export function webRuntimeConfig(): WebConfigWire {
  return config;
}
