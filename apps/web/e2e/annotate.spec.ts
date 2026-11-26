import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import ffmpegPath from "ffmpeg-static";

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = path.resolve(here, "../../../.dev/e2e/clip.mp4");

test.beforeAll(() => {
  if (existsSync(sample)) return;
  mkdirSync(path.dirname(sample), { recursive: true });
  const r = spawnSync(ffmpegPath as unknown as string, [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "12", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "60", "-c:a", "aac", "-shortest", sample,
  ]);
  if (r.status !== 0) throw new Error("ffmpeg failed to make the sample clip");
});

async function loginAs(context: BrowserContext, userId: string) {
  const res = await context.request.post("/api/dev/login", { data: { userId } });
  expect(res.ok()).toBeTruthy();
}

async function videoTime(page: Page): Promise<number> {
  return page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime);
}

test("signed-out visitors are sent to the login page", async ({ page }) => {
  await page.goto("/browse");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("link", { name: /Dev login/ })).toBeVisible();
});

test("dev login page signs in as a seeded user", async ({ page }) => {
  await page.goto("/dev/login");
  await page.getByRole("button", { name: /Alice/ }).click();
  await expect(page.getByRole("heading", { name: "Feed" })).toBeVisible();
  await expect(page.getByText("DEV LOGIN ENABLED")).toBeVisible();
});

test("upload → publish → annotate, seen live by another user, click-to-seek", async ({ browser }) => {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  await loginAs(aliceCtx, "dev-alice");
  await loginAs(bobCtx, "dev-bob");
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  // Upload through the Library page (tus).
  await alice.goto("/library");
  await alice.locator('input[type="file"]').setInputFiles(sample);
  const card = alice.getByRole("link", { name: /clip/ }).first();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.click();
  await expect(alice.getByTestId("player-stage")).toBeVisible({ timeout: 90_000 });
  const videoUrl = alice.url();

  // Private: bob can't see it.
  await bob.goto(videoUrl);
  await expect(bob.getByText("Video not found")).toBeVisible();

  // Publish.
  await alice.getByRole("button", { name: "Publish" }).click();
  await expect(alice.getByRole("button", { name: "Make private" })).toBeVisible();

  // Bob opens it and waits for the player.
  await bob.goto(videoUrl);
  await expect(bob.getByTestId("player-stage")).toBeVisible();
  await expect(bob.getByText("No annotations yet")).toBeVisible();

  // Alice seeks to ~3 s, clicks the frame, and posts an annotation.
  await alice.locator("video").evaluate(async (v: HTMLVideoElement) => {
    if (v.readyState < 1) await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
    v.currentTime = 3;
    await new Promise((r) => v.addEventListener("seeked", r, { once: true }));
  });
  const stage = alice.getByTestId("player-stage");
  const box = (await stage.boundingBox())!;
  await stage.click({ position: { x: box.width * 0.25, y: box.height * 0.4 } });
  const composer = alice.getByPlaceholder("What's happening here?");
  await expect(composer).toBeVisible();
  await composer.fill("The red square enters here");
  // Default duration grows with word count: 5 s + 5 words × 0.3 s = 6.5 s.
  await expect(alice.getByText("6.5 s")).toBeVisible();
  await alice.getByRole("button", { name: "+2s" }).click();
  await expect(alice.getByText("8.5 s")).toBeVisible();
  await alice.getByRole("button", { name: "Post" }).click();
  await expect(alice.getByTestId("annotation-item")).toHaveCount(1);
  // The pin is drawn on the video while active.
  await expect(alice.getByTestId("player-stage").getByText("The red square enters here")).toBeVisible();

  // Bob sees it appear without reloading (SSE), plus a timeline marker.
  await expect(bob.getByTestId("annotation-item")).toHaveCount(1);
  await expect(bob.getByRole("button", { name: /Annotation at 0:03/ })).toBeVisible();

  // Clicking the comment seeks bob's player to the annotation time and shows the pin.
  await bob.getByTestId("annotation-item").getByRole("button", { name: /Jump to 0:03/ }).click();
  await expect.poll(() => videoTime(bob), { timeout: 10_000 }).toBeGreaterThan(2.8);
  expect(await videoTime(bob)).toBeLessThan(3.4);
  await expect(bob.getByTestId("player-stage").getByText("The red square enters here")).toBeVisible();

  // Cleanup.
  alice.on("dialog", (d) => void d.accept());
  await alice.getByRole("button", { name: "Delete" }).last().click();
  await expect(alice).toHaveURL(/\/library/);
  await aliceCtx.close();
  await bobCtx.close();
});
