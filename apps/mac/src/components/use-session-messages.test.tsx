import { Profiler } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { SessionPage } from "../types.js";
import { WorkspaceCacheProvider } from "./workspace-cache.js";
import { useSessionMessages } from "./use-session-messages.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const state = {
  profile: "work",
  user: "alice",
  config: { apiUrl: "https://work.example", syncMinutes: 5 },
};
const page = (...texts: string[]): SessionPage => ({
  messages: texts.map((text, index) => ({ index, role: "user", text })),
  total: texts.length,
  offset: 0,
});

function Sessions({ contentKey }: { contentKey: string }) {
  const view = useSessionMessages("session", "", contentKey);
  if (view.pending) return <p role="status">Loading messages…</p>;
  return (
    <section aria-busy={view.loading}>
      {view.messages.map((message) => (
        <p key={message.index}>{message.text}</p>
      ))}
      {view.hasMore && <button onClick={view.loadMore}>Show more</button>}
    </section>
  );
}

const reads = () =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === "session_messages");

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});
afterEach(cleanup);

test("a second visit renders cached turns without a loading state", async () => {
  vi.mocked(invoke).mockResolvedValue(page("First turn"));
  const loadingCommits: boolean[] = [];
  const tree = (visible: boolean, contentKey = "hash-a") => (
    <WorkspaceCacheProvider state={state}>
      <Profiler
        id="sessions"
        onRender={() =>
          loadingCommits.push(Boolean(screen.queryByRole("status")))
        }
      >
        {visible ? <Sessions contentKey={contentKey} /> : <p>Project home</p>}
      </Profiler>
    </WorkspaceCacheProvider>
  );
  const { rerender } = render(tree(true));
  expect(await screen.findByText("First turn")).toBeTruthy();
  expect(reads()).toHaveLength(1);

  rerender(tree(false));
  loadingCommits.length = 0;
  rerender(tree(true));
  expect(screen.getByText("First turn")).toBeTruthy();
  expect(loadingCommits).not.toContain(true);
  expect(reads()).toHaveLength(1);

  let finish: (value: SessionPage) => void = () => {};
  vi.mocked(invoke).mockReturnValueOnce(
    new Promise<SessionPage>((resolve) => {
      finish = resolve;
    }),
  );
  rerender(tree(true, "hash-b"));
  expect(reads()).toHaveLength(2);
  expect(screen.getByText("First turn")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();

  await act(async () => finish(page("First turn", "Second turn")));
  expect(await screen.findByText("Second turn")).toBeTruthy();
  expect(loadingCommits).not.toContain(true);
});

test("a content change refills as many turns as were showing", async () => {
  let version = "a";
  const turns = () =>
    Array.from({ length: 50 }, (_, index) => `Turn ${index}${version}`);
  vi.mocked(invoke).mockImplementation(async (_, args) => {
    const { offset, limit } = args as { offset: number; limit: number };
    return {
      messages: turns()
        .slice(offset, offset + limit)
        .map((text, index) => ({ index: offset + index, role: "user", text })),
      total: 50,
      offset,
    };
  });
  const tree = (contentKey: string) => (
    <WorkspaceCacheProvider state={state}>
      <Sessions contentKey={contentKey} />
    </WorkspaceCacheProvider>
  );
  const { rerender } = render(tree("hash-a"));
  expect(await screen.findByText("Turn 39a")).toBeTruthy();
  expect(screen.queryByText("Turn 40a")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(await screen.findByText("Turn 49a")).toBeTruthy();

  version = "b";
  rerender(tree("hash-b"));
  expect(reads().at(-1)?.[1]).toMatchObject({ offset: 0, limit: 50 });
  expect(await screen.findByText("Turn 49b")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
});
