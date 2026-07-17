import { createContext, type ReactNode, useContext } from "react";
import type { WebConfig } from "@/api/types";

const WebConfigContext = createContext<WebConfig>({
  experimental: false,
});

export function WebConfigProvider({
  config,
  children,
}: {
  config: WebConfig;
  children: ReactNode;
}) {
  return (
    <WebConfigContext.Provider value={config}>
      {children}
    </WebConfigContext.Provider>
  );
}

export function useWebConfig(): WebConfig {
  return useContext(WebConfigContext);
}
