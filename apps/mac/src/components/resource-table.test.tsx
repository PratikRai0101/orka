import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ProjectResource } from "../types.js";
import { ResourceMenuProvider } from "./resource-menu.js";
import { ResourceTable } from "./resource-table.js";

const session = (resourceId: string, title: string) =>
  ({
    resourceId,
    projectId: "project",
    kind: "session",
    title,
    logicalPath: `sessions/${resourceId}`,
    files: [],
    revision: 0,
    local: true,
    owner: "me",
    updatedAt: "2026-11-01T00:00:00Z",
  }) as unknown as ProjectResource;

const resources = [session("a", "Fix login"), session("b", "Write docs")];

function renderTable() {
  const onOpen = vi.fn();
  const state = {
    user: "me",
    projects: [{ id: "project", name: "Project", role: "owner" }],
  } as never;
  render(
    <ResourceMenuProvider
      resources={resources}
      scope="test"
      state={state}
      busy={false}
      act={vi.fn()}
      onOpen={vi.fn()}
      onReview={vi.fn()}
      onNotice={vi.fn()}
      onError={vi.fn()}
      onRefresh={vi.fn()}
    >
      <ResourceTable
        resources={resources}
        label="Sessions"
        user="me"
        displayTitle={(resource) => resource.title}
        conflicted={new Set()}
        onOpen={onOpen}
      />
    </ResourceMenuProvider>,
  );
  return onOpen;
}

const row = (title: string) => screen.getByText(title).closest("tr")!;
const waitForMenu = () => act(() => new Promise((done) => setTimeout(done)));

/**
 * jsdom does no hit-testing, so model WebKit's: a press lands on the nearest
 * element whose pointer events are on, and the click goes to the common
 * ancestor of where the press went down and where it came up.
 */
function hit(element: Element): Element {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const value = (node as HTMLElement).style.pointerEvents;
    if (value === "none") return document.documentElement;
    if (value) return element;
  }
  return element;
}
async function press(element: Element) {
  const down = hit(element);
  fireEvent.pointerDown(down, { pointerType: "mouse" });
  fireEvent.mouseDown(down);
  await waitForMenu();
  const up = hit(element);
  fireEvent.mouseUp(up);
  let target: Node = down;
  while (!target.contains(up)) target = target.parentNode!;
  fireEvent.click(target);
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("a left click on any part of a row opens it", () => {
  const onOpen = renderTable();
  fireEvent.click(screen.getByText("Fix login"));
  fireEvent.click(screen.getAllByText("Local Only")[0]);
  fireEvent.click(row("Fix login").cells[2]);
  expect(onOpen.mock.calls).toEqual([["a"], ["a"], ["a"]]);
});

test("a control-click anywhere on a row shows its menu and never opens it", async () => {
  const onOpen = renderTable();
  const targets = [
    screen.getByText("Fix login"),
    screen.getAllByText("Local Only")[0],
    row("Fix login").cells[0],
    row("Fix login").cells[2],
  ];
  for (const target of targets) {
    fireEvent.contextMenu(target, { ctrlKey: true });
    fireEvent.click(target, { ctrlKey: true });
    expect(screen.getByRole("menu", { name: "session actions" })).toBeTruthy();
    expect(row("Fix login").hasAttribute("data-item-menu-open")).toBe(true);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitForMenu();
  }
  expect(onOpen).not.toHaveBeenCalled();
});

test("clicking another row to dismiss a menu does not open that row", async () => {
  const onOpen = renderTable();
  fireEvent.contextMenu(screen.getByText("Fix login"));
  await waitForMenu();
  expect(screen.getByRole("menu")).toBeTruthy();

  await press(screen.getByText("Write docs"));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(row("Fix login").hasAttribute("data-item-menu-open")).toBe(false);
  expect(onOpen).not.toHaveBeenCalled();

  await press(screen.getByText("Write docs"));
  expect(onOpen).toHaveBeenCalledWith("b");
});
