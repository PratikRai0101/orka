import { useRef } from "react";
import { useInfiniteQuery, type QueryKey } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { SessionPage } from "../types.js";
import { useWorkspaceScope } from "./workspace-cache.js";

const SESSION_PAGE_SIZE = 40;
/** The native command serves at most this many turns per call. */
const SESSION_PAGE_LIMIT = 200;

/**
 * Message pages for one session version. The key holds the file hashes, so a
 * cached entry can never go stale: new content is a new key.
 */
export class SessionMessagesQuery {
  static key(scope: string, id: string, conflict: string, content: string) {
    return ["session-messages", scope, id, conflict, content] as const;
  }

  /** Whether two keys read the same session and conflict, at any content. */
  static sameSession(a: QueryKey, b: QueryKey) {
    return a.slice(0, 4).every((part, index) => part === b[index]);
  }
}

/**
 * Pages through a session's readable turns, oldest first. Only the requested
 * window crosses the native bridge; the parsed transcript stays native-side.
 * Returning to a session reads the shared cache. When its content changes,
 * the earlier turns stay visible until the new version's first page arrives.
 */
export function useSessionMessages(
  id: string,
  conflictId: string,
  contentKey: string,
) {
  const key = SessionMessagesQuery.key(
    useWorkspaceScope(),
    id,
    conflictId,
    contentKey,
  );
  // Refill as many turns as were showing, so a content change keeps the
  // reader's place instead of collapsing to the first page.
  const shown = useRef(0);
  const query = useInfiniteQuery({
    queryKey: key,
    staleTime: Infinity,
    initialPageParam: {
      offset: 0,
      limit: Math.min(
        Math.max(shown.current, SESSION_PAGE_SIZE),
        SESSION_PAGE_LIMIT,
      ),
    },
    getNextPageParam: (last: SessionPage, pages: SessionPage[]) => {
      const offset = pages.flatMap((page) => page.messages ?? []).length;
      return offset < (last.total ?? offset)
        ? { offset, limit: SESSION_PAGE_SIZE }
        : undefined;
    },
    queryFn: ({ pageParam }) =>
      invoke<SessionPage>("session_messages", {
        id,
        conflictId: conflictId || null,
        ...pageParam,
      }),
    placeholderData: (previous, previousQuery) =>
      previousQuery &&
      SessionMessagesQuery.sameSession(previousQuery.queryKey, key)
        ? previous
        : undefined,
  });
  const messages = query.data?.pages.flatMap((page) => page.messages ?? []);
  shown.current = messages?.length ?? 0;
  const last = query.data?.pages.at(-1);
  const loading = query.isFetching;
  const error = query.error ? String(query.error) : "";
  return {
    messages: messages ?? [],
    total: last ? (last.total ?? shown.current) : null,
    loading,
    /** No turns to show yet, from the cache or an earlier version. */
    pending: query.isPending,
    error,
    removed: last?.removed === true,
    hasMore: query.hasNextPage,
    loadMore: () => {
      if (!loading && !error && query.hasNextPage) void query.fetchNextPage();
    },
    retry: () =>
      void (query.isFetchNextPageError
        ? query.fetchNextPage()
        : query.refetch()),
  };
}
