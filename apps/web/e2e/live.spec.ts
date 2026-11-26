import { spawn } from "node:child_process";
import { expect, test } from "@playwright/test";
import ffmpegPath from "ffmpeg-static";

const ORIGIN = "http://localhost:5173";

test("live: viewer annotates a public stream without pausing it; note survives into the recording", async ({ browser }) => {
  test.setTimeout(180_000);
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  await aliceCtx.request.post("/api/dev/login", { data: { userId: "dev-alice" } });
  await bobCtx.request.post("/api/dev/login", { data: { userId: "dev-bob" } });
  await aliceCtx.request.post("/api/trpc/channel.update", {
    data: { liveVisibility: "public", liveTitle: "E2E live" },
    headers: { origin: ORIGIN },
  });

  // Alice "goes live" from OBS (simulated with ffmpeg, stream key "dev").
  const pusher = spawn(ffmpegPath as unknown as string, [
    "-hide_banner", "-loglevel", "error", "-re",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=330",
    "-t", "35", "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p", "-g", "60",
    "-c:a", "aac", "-f", "flv", "rtmp://127.0.0.1:1935/live/alice?key=dev",
  ], { stdio: "ignore", windowsHide: true });
  const pusherDone = new Promise((r) => pusher.on("close", r));

  try {
    // Bob finds it in "Live now" on the feed.
    const bob = await bobCtx.newPage();
    await bob.goto("/");
    const liveCard = bob.getByRole("link", { name: /E2E live/ }).first();
    await expect(liveCard).toBeVisible({ timeout: 30_000 });
    await liveCard.click();
    await expect(bob.getByText("● Live").first()).toBeVisible();

    // Wait until the live clock is running (hls.js playingDate from PROGRAM-DATE-TIME).
    await expect
      .poll(() => bob.locator("video").evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > 1), { timeout: 30_000 })
      .toBe(true);

    const stage = bob.getByTestId("player-stage");
    const box = (await stage.boundingBox())!;
    await stage.click({ position: { x: box.width * 0.6, y: box.height * 0.5 } });
    await expect(bob.getByText("The stream keeps playing while you type.")).toBeVisible();
    await bob.getByPlaceholder("What's happening here?").fill("Live note from Bob");
    // Clicking a live stream must not pause it.
    expect(await bob.locator("video").evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
    await bob.getByRole("button", { name: "Post" }).click();
    const item = bob.getByTestId("annotation-item");
    await expect(item).toHaveCount(1);
    await expect(item.getByText("live", { exact: true })).toBeVisible();
    const liveLabel = (await item.locator(".font-mono").first().textContent())!.trim();

    // After the stream ends, the page switches to the finalized recording with the note kept.
    await pusherDone;
    await expect(bob.getByTestId("player-stage")).toBeVisible({ timeout: 90_000 });
    await expect(bob.getByText("recorded live")).toBeVisible({ timeout: 90_000 });
    const vodItem = bob.getByTestId("annotation-item");
    await expect(vodItem).toHaveCount(1);
    const [m, s] = liveLabel.split(":").map(Number);
    const [m2, s2] = (await vodItem.locator(".font-mono").first().textContent())!.trim().split(":").map(Number);
    expect(Math.abs(m! * 60 + s! - (m2! * 60 + s2!))).toBeLessThanOrEqual(1);
  } finally {
    pusher.kill();
    await aliceCtx.request.post("/api/trpc/channel.update", { data: { liveVisibility: "private", liveTitle: "" }, headers: { origin: ORIGIN } });
    await aliceCtx.close();
    await bobCtx.close();
  }
});
