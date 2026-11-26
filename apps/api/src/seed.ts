/**
 * Development seed: fixed users for /dev/login and tests. Idempotent.
 *   admin       role admin
 *   alice       regular user, channel "alice", stream key "dev"
 *   bob         regular user, channel "bob", stream key "dev"
 *   quota-full  regular user with a 0-byte quota (can't upload or stream)
 */
import { channel, runMigrations, user } from "@capturecat/db";
import { config } from "./config.js";
import { db, sql } from "./db.js";
import { hashStreamKey } from "./trpc/channel.js";

if (config.isProduction) {
  console.error("Refusing to seed development users in production.");
  process.exit(1);
}

await runMigrations(config.databaseUrl);

const users = [
  { id: "dev-admin", name: "Admin", email: "admin@dev.capturecat.local", role: "admin", quotaBytes: config.defaultQuotaBytes },
  { id: "dev-alice", name: "Alice", email: "alice@dev.capturecat.local", role: "user", quotaBytes: config.defaultQuotaBytes },
  { id: "dev-bob", name: "Bob", email: "bob@dev.capturecat.local", role: "user", quotaBytes: config.defaultQuotaBytes },
  { id: "dev-quota-full", name: "Quota Full", email: "quota-full@dev.capturecat.local", role: "user", quotaBytes: 0 },
];

for (const u of users) {
  await db
    .insert(user)
    .values({ ...u, emailVerified: true })
    .onConflictDoUpdate({ target: user.id, set: { name: u.name, role: u.role, quotaBytes: u.quotaBytes, suspendedAt: null } });
}

for (const [userId, channelId] of [
  ["dev-alice", "alice"],
  ["dev-bob", "bob"],
] as const) {
  await db
    .insert(channel)
    .values({ id: channelId, userId, streamKeyHash: hashStreamKey("dev") })
    .onConflictDoUpdate({ target: channel.userId, set: { streamKeyHash: hashStreamKey("dev") } });
}

console.log("Seeded users: admin, alice, bob, quota-full. Alice/Bob stream key: dev");
console.log('  ffmpeg -re -stream_loop -1 -i sample.mp4 -c copy -f flv "rtmp://localhost/live/alice?key=dev"');
await sql.end();
process.exit(0);
