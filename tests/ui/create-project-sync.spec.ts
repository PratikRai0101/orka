import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

type Call = { command: string; args: Record<string, unknown> };
type Fixture = {
  setupCalls: Call[];
  releaseSetup: (outcome: "created" | "cancelled") => void;
};

// `cloud_action` behaves like a create that reaches a busy workspace: it
// reports that it is waiting and holds until the test releases it.
async function fixture(page: Page) {
  await page.addInitScript(() => {
    const calls: Call[] = [];
    let created = false;
    let release: (outcome: "created" | "cancelled") => void = () => {};
    const project = (id: string, name: string) => ({
      id,
      name,
      role: "owner",
      sources: [],
    });
    Object.assign(window, {
      setupCalls: calls,
      releaseSetup: (outcome: "created" | "cancelled") => release(outcome),
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === "snapshot")
            return {
              user: "user",
              config: { apiUrl: "https://test.orka", syncMinutes: 15 },
              projects: [
                project("project", "Product"),
                ...(created ? [project("created", "Atlas")] : []),
              ],
              resources: [],
              bindings: [],
              conflicts: [],
              activity: [],
              outbox: [],
              errors: [],
              sync: { online: true },
              daemon: { running: true },
              devices: [],
              deviceId: "mac",
              background: true,
            };
          if (command === "sync_progress")
            return { user: "user", progress: null };
          calls.push({ command, args });
          if (command === "plugin:dialog|open")
            return ["/new/desktop", "/new/backend"];
          if (command === "cloud_action" && args.action === "create") {
            const progress = args.onProgress as {
              onmessage: (value: { waiting: boolean }) => void;
            };
            progress.onmessage({ waiting: true });
            return new Promise((resolve, reject) => {
              release = (outcome) => {
                if (outcome === "cancelled")
                  return reject("Cancelled while waiting for sync to finish.");
                created = true;
                progress.onmessage({ waiting: false });
                resolve({ id: "created" });
              };
            });
          }
          if (command.startsWith("plugin:")) return null;
          return {};
        },
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Project name" }).fill("Atlas");
  await dialog.getByRole("button", { name: "Add folders" }).click();
  await dialog
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText(
    "Waiting for sync to finish. Orka will create the project as soon as it can.",
  );
  return dialog;
}

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as Fixture).setupCalls);
const release = (page: Page, outcome: "created" | "cancelled") =>
  page.evaluate(
    (outcome) => (window as unknown as Fixture).releaseSetup(outcome),
    outcome,
  );

test("one Create click waits for sync, keeps the choices and opens the project", async ({
  page,
}) => {
  const dialog = await fixture(page);
  await expect(
    dialog.getByRole("button", { name: "Waiting for sync…" }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("textbox", { name: "Project name" }),
  ).toHaveValue("Atlas");
  await expect(dialog.getByText("/new/backend")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeEnabled();
  expect(
    (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
      .violations,
  ).toEqual([]);

  await release(page, "created");
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("combobox", { name: "Select project", exact: true }),
  ).toContainText("Atlas");
  const made = await calls(page);
  expect(made.filter((call) => call.command === "cloud_action")).toHaveLength(
    1,
  );
  expect(
    made.find((call) => call.command === "connect_project_sources")?.args,
  ).toEqual({ id: "created", paths: ["/new/desktop", "/new/backend"] });
});

test("Cancel stops a create that is waiting for sync without an error", async ({
  page,
}) => {
  const dialog = await fixture(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Cancelling…");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect((await calls(page)).map((call) => call.command)).toContain(
    "cancel_project_setup",
  );

  await release(page, "cancelled");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(
    (await calls(page)).some(
      (call) => call.command === "connect_project_sources",
    ),
  ).toBe(false);
});

test("Escape while waiting cancels instead of hiding a pending create", async ({
  page,
}) => {
  const dialog = await fixture(page);
  await page.keyboard.press("Escape");
  await expect(dialog.getByRole("status")).toHaveText("Cancelling…");
  await release(page, "cancelled");
  await expect(dialog).toBeHidden();
});
