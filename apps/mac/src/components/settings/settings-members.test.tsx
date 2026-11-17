import { Profiler } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Project, ProjectMember, Snapshot } from "../../types.js";
import { LoadingProvider } from "../loading-region.js";
import { WorkspaceCache, WorkspaceCacheProvider } from "../workspace-cache.js";
import { SettingsMembers } from "./settings-members.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const project = { id: "project", name: "Project", role: "owner" } as Project;
const member = (id: string, name: string): ProjectMember => ({
  id,
  name,
  role: "member",
});
const catalog = (...members: ProjectMember[]) => ({
  owner: true,
  governed: false,
  policyRevision: 1,
  members,
});
const snapshot = (user: string, members?: ProjectMember[]) =>
  ({
    profile: "work",
    user,
    config: { apiUrl: "https://work.example", syncMinutes: 5 },
    projects: [project],
    governance: members
      ? [{ projectId: project.id, catalog: { access: {}, members } }]
      : [],
  }) as unknown as Snapshot;

let answer: (value: unknown) => void = () => {};
const reads = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(
      ([name, args]) =>
        name === "governance_command" &&
        (args as { action: string }).action === "catalog",
    );
const loading = () => screen.queryByText("Loading members…");

function Members({ state, open = true }: { state: Snapshot; open?: boolean }) {
  return (
    <WorkspaceCacheProvider state={state}>
      <LoadingProvider scope={WorkspaceCache.scope(state)}>
        {open && (
          <SettingsMembers
            state={state}
            project={project}
            onReviews={() => {}}
            onLogs={() => {}}
          />
        )}
      </LoadingProvider>
    </WorkspaceCacheProvider>
  );
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((name) =>
    name === "governance_command"
      ? new Promise((resolve) => {
          answer = resolve;
        })
      : Promise.resolve({ enabled: false }),
  );
});
afterEach(cleanup);

test("after a restart, members show from the catalog with no loading state", async () => {
  const stored = [member("alice", "Alice"), member("bob", "Bob")];
  const loadingCommits: boolean[] = [];
  const tree = (open: boolean) => (
    <Profiler id="members" onRender={() => loadingCommits.push(!!loading())}>
      <Members state={snapshot("alice", stored)} open={open} />
    </Profiler>
  );
  const { rerender } = render(tree(true));
  expect(screen.getByText("Alice")).toBeTruthy();
  expect(screen.getByText("Bob")).toBeTruthy();
  expect(reads()).toHaveLength(1);

  await act(async () => answer(catalog(...stored)));
  expect(screen.getByText("Bob")).toBeTruthy();

  expect(
    await screen.findByRole("button", { name: "Add Member" }),
  ).toBeTruthy();

  // Reopening the tab keeps the confirmed list and owner controls on screen
  // while the service is asked again.
  rerender(tree(false));
  rerender(tree(true));
  expect(screen.getByText("Bob")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add Member" })).toBeTruthy();
  expect(reads()).toHaveLength(2);
  expect(loadingCommits).not.toContain(true);
});

test("the server's member list replaces the stored one", async () => {
  render(
    <Members
      state={snapshot("alice", [
        member("alice", "Alice"),
        member("bob", "Bob"),
      ])}
    />,
  );
  expect(screen.getByText("Bob")).toBeTruthy();

  await act(async () =>
    answer(catalog(member("alice", "Alice"), member("carol", "Carol"))),
  );
  expect(await screen.findByText("Carol")).toBeTruthy();
  expect(screen.queryByText("Bob")).toBeNull();
});

test("members from one user never show for another", async () => {
  const { rerender } = render(
    <Members state={snapshot("alice", [member("alice", "Alice")])} />,
  );
  await act(async () => answer(catalog(member("alice", "Alice"))));
  expect(screen.getByText("Alice")).toBeTruthy();

  rerender(<Members state={snapshot("bob")} />);
  expect(screen.queryByText("Alice")).toBeNull();
  expect(loading()).toBeTruthy();
  expect(reads()).toHaveLength(2);
});
