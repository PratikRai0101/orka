import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Snapshot } from "../types.js";

export class WorkspaceCache {
  static scope(state: Pick<Snapshot, "profile" | "user" | "config">) {
    return JSON.stringify([state.profile, state.user, state.config?.apiUrl]);
  }

  static createClient() {
    return new QueryClient({
      defaultOptions: {
        queries: {
          networkMode: "always", // Local IPC reads must also work offline.
          retry: false,
          refetchOnWindowFocus: false,
          refetchOnReconnect: false,
          staleTime: 30_000,
          gcTime: 5 * 60_000,
        },
      },
    });
  }
}

export function WorkspaceCacheProvider({
  state,
  children,
}: {
  state: Pick<Snapshot, "profile" | "user" | "config">;
  children: ReactNode;
}) {
  return (
    <WorkspaceCacheBoundary key={WorkspaceCache.scope(state)}>
      {children}
    </WorkspaceCacheBoundary>
  );
}

function WorkspaceCacheBoundary({ children }: { children: ReactNode }) {
  // Remount observers with the client so no previous account can be read.
  const [client] = useState(WorkspaceCache.createClient);
  useEffect(() => () => client.clear(), [client]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
