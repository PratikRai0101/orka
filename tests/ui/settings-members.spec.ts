import { test, expect } from "@playwright/test";
import { settingsFixture } from "./fixtures/settings.js";

for (const [role, width, height] of [
  ["owner", 1160, 768],
  ["member", 900, 640],
] as const)
  test(`Members puts the current ${role} first and uses their account email at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    const settings = await settingsFixture(page, { role });
    const otherEmail = `${"alex.".repeat(12)}chen@example.com`;
    await page.evaluate(
      ({ role, otherEmail }) => {
        (window as any).settingsCatalog.members = [
          {
            id: "other-a",
            name: "Alex Chen",
            role: "admin",
            email: otherEmail,
          },
          { id: "other-b", name: "Jamie Rivera", role: "member" },
          { id: role, name: "Morgan Taylor", role },
        ];
      },
      { role, otherEmail },
    );
    await settings
      .getByRole("button", { name: "Members", exact: true })
      .click();
    const rows = settings.getByRole("listitem");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).getByText("You", { exact: true })).toBeVisible();
    await expect(
      rows.nth(0).getByText("morgan@example.com", { exact: true }),
    ).toBeVisible();
    await expect(
      rows.nth(1).getByText(otherEmail, { exact: true }),
    ).toHaveAttribute("title", otherEmail);
    await expect(
      rows.nth(2).getByText("Jamie Rivera", { exact: true }),
    ).toBeVisible();
    await expect(rows.nth(2).locator("p")).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        (window as any).settingsCatalog.members.map((member: any) => member.id),
      ),
    ).toEqual(["other-a", "other-b", role]);
    expect(
      await rows.nth(1).evaluate((row) => row.scrollWidth <= row.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`members-${width}.png`) });
  });

test("Members keeps supplied emails and does not invent an unavailable account email", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { noProfile: true });
  await page.evaluate(() => {
    (window as any).settingsCatalog.members = [
      {
        id: "member",
        name: "Jamie Rivera",
        role: "member",
        email: "jamie@example.com",
      },
      { id: "owner", name: "Morgan Taylor", role: "owner" },
    ];
  });
  await settings.getByRole("button", { name: "Members", exact: true }).click();
  const rows = settings.getByRole("listitem");
  await expect(rows.nth(0).getByText("You", { exact: true })).toBeVisible();
  await expect(rows.nth(0).locator("p")).toHaveCount(0);
  await expect(
    rows.nth(1).getByText("jamie@example.com", { exact: true }),
  ).toBeVisible();
});

test("a confirmed missing email does not revive the cached account email", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await settings.getByRole("button", { name: "Members", exact: true }).click();
  const self = settings
    .getByRole("listitem")
    .filter({ has: page.getByText("You", { exact: true }) });
  await expect(
    self.getByText("morgan@example.com", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    w.settingsCatalog.members.find(
      (member: any) => member.id === "owner",
    ).email = null;
    w.settingsState.projects[0].policyRevision++;
  });
  await expect(self.locator("p")).toHaveCount(0);
  await expect(self.getByText("Morgan Taylor", { exact: true })).toBeVisible();
});

test("a policy change during the initial Members read obtains the latest catalog", async ({
  page,
}) => {
  await page.clock.install();
  const settings = await settingsFixture(page);
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.memberCatalogReads = 0;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === "governance_command" && args.action === "catalog") {
        w.memberCatalogReads++;
        if (w.memberCatalogReads === 1) {
          const previous = structuredClone(w.settingsCatalog);
          await new Promise<void>((resolve) => {
            w.finishPreviousCatalog = resolve;
          });
          return previous;
        }
      }
      return original(command, args);
    };
  });
  await settings.getByRole("button", { name: "Members", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).memberCatalogReads))
    .toBe(1);
  await page.evaluate(() => {
    const w = window as any;
    w.settingsState.projects[0].policyRevision++;
    w.settingsCatalog.policyRevision++;
    w.settingsCatalog.members = [
      { id: "owner", name: "Current owner", role: "owner" },
      { id: "new-member", name: "New teammate", role: "member" },
    ];
  });
  await page.clock.runFor(3100);
  await expect(settings).toContainText("New teammate");
  await page.evaluate(() => (window as any).finishPreviousCatalog());
  await expect(settings).toContainText("New teammate");
  await expect
    .poll(() => page.evaluate(() => (window as any).memberCatalogReads))
    .toBe(2);
});
