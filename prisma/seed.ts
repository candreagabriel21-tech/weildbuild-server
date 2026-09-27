// ═══════════════════════════════════════════════════════════
// WeildBuild — database seed
// ═══════════════════════════════════════════════════════════
// Run with:  npm run seed
// Seeds the default top_admin account (WeildBuild / WeildBuild2026!
// — CHANGE THE PASSWORD AFTER FIRST LOGIN) and the 35 official
// shop items from data/items/*.json.
//
// Safe to re-run: uses upserts.

import { PrismaClient } from "@prisma/client";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { scryptSync } from "crypto";

const prisma = new PrismaClient();

// MUST match src/db/users.ts secureHashPassword exactly
function secureHashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
}

// Item colors — mirrors the client's ITEM_COLORS map
// (single source of truth lives in the client repo; kept in sync here)
const ITEM_COLORS: Record<string, string> = {
  "FACE-1": "#FFD700", "FACE-2": "#87CEEB", "FACE-3": "#FFD700", "FACE-4": "#87CEEB",
  "FACE-5": "#7B8794", "FACE-6": "#00BFFF", "FACE-7": "#8B4513", "FACE-8": "#9370DB",
  "FACE-9": "#FF4500", "FACE-11": "#32CD32", "FACE-12": "#FF6347", "FACE-13": "#4169E1",
  "FACE-14": "#FF1493", "FACE-15": "#00CED1", "FACE-16": "#FF8C00", "FACE-17": "#8A2BE2",
  "FACE-18": "#2E8B57", "FACE-19": "#DC143C", "FACE-20": "#4B0082", "FACE-21": "#8B4513",
  "SHIRT-1": "#CC0000", "SHIRT-2": "#FF4500", "SHIRT-3": "#228B22", "SHIRT-4": "#6A0DAD",
  "SHIRT-5": "#FFD700", "SHIRT-6": "#191970", "SHIRT-7": "#FFB6C1", "SHIRT-8": "#006994",
  "PANTS-1": "#2196F3", "PANTS-2": "#0D1B2A", "PANTS-3": "#556B2F", "PANTS-4": "#CC0000",
  "PANTS-5": "#F5F5F5", "PANTS-6": "#7B2D8E",
};

async function seedAdmin() {
  const username = "WeildBuild";
  const password = "WeildBuild2026!";
  const salt = "5765696c644275696c64323032362121"; // same salt as the original schema
  const hash = secureHashPassword(password, salt);

  await prisma.user.upsert({
    where: { username },
    create: {
      username,
      password: hash,
      salt,
      hashVersion: 1,
      userKey: "WeildAdm",
      avatar: { shirt: "SHIRT-1", left_leg: "PANTS-1", right_leg: "PANTS-1", face: "FACE-1", skin: "#f8ff6d" } as any,
      webuy: 999999,
      itemsOwned: ["FACE-1", "SHIRT-1", "PANTS-1"],
      description: "Official WeildBuild admin account. Change the default password immediately!",
      adminRole: "top_admin",
      banned: { is_banned: false, reason: "" } as any,
      notifications: ["Welcome to WeildBuild! You are logged in as the default admin. Please change your password."],
      visualSettings: { dark_mode: true, ui_scale: 1, animations: true, reduce_motion: false } as any,
    },
    update: {
      // Re-assert admin credentials on re-seed (rescue if password was forgotten)
      password: hash,
      salt,
      hashVersion: 1,
      adminRole: "top_admin",
    },
  });
  console.log("✓ Admin user seeded: WeildBuild (top_admin)");
}

async function seedItems() {
  const itemsDir = join(__dirname, "..", "data", "items");
  if (!existsSync(itemsDir)) {
    console.warn("! No data/items directory found — skipping items");
    return;
  }
  const files = readdirSync(itemsDir).filter((f) => f.endsWith(".json"));
  let count = 0;
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(itemsDir, file), "utf-8"));
    const displayName = raw.name || raw.display_name || raw.item_key;
    const data = {
      id: raw.item_key,
      displayName,
      itemType: raw.type || raw.item_type || "",
      price: raw.price ?? 0,
      description: raw.description || "",
      creator: raw.creator || "WeildBuild",
      color: ITEM_COLORS[raw.item_key] || "#888",
      data: raw.data || null,
      ...(raw.date_created ? { dateCreated: new Date(raw.date_created) } : {}),
    };
    await prisma.item.upsert({
      where: { id: data.id },
      create: data,
      update: data,
    });
    count++;
  }
  console.log(`✓ Seeded ${count} shop items`);
}

async function main() {
  console.log("Seeding WeildBuild database...");
  await seedAdmin();
  await seedItems();
  console.log("Done.");
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
