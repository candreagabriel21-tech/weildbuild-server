// ═══════════════════════════════════════════════════════════
// WeildBuild, database seed
// ═══════════════════════════════════════════════════════════
// Run with:  npm run seed
// Seeds the 35 official shop items from data/items/*.json.
//
// v2.1 SECURITY: the default admin account (WeildBuild / a
// hardcoded password) is NO LONGER seeded here, a password baked
// into the repo is a leaked password. The first admin is created
// from ENVIRONMENT VARIABLES instead (see src/db/ensure.ts):
//
//   ADMIN_USERNAME + ADMIN_PASSWORD
//
// Set them once on your hosting dashboard (Render > Environment)
// and restart, the account is created only if the username does
// not exist yet, and its password is NEVER overwritten afterwards,
// so you can change it freely from in-app Settings.
//
// Safe to re-run: uses upserts.

import { PrismaClient } from "@prisma/client";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { ITEM_COLORS } from "../src/shared/item-colors";

const prisma = new PrismaClient();

async function seedItems() {
  const itemsDir = join(__dirname, "..", "data", "items");
  if (!existsSync(itemsDir)) {
    console.warn("! No data/items directory found, skipping items");
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
  await seedItems();
  console.log("Done. (Admin accounts come from ADMIN_USERNAME/ADMIN_PASSWORD env vars, see src/db/ensure.ts)");
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
