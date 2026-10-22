// E2E helper: delete a user's server-side sessions (simulates admin kick /
// session expiry). Run with: npx tsx <this-file> <database-url> <username>
import { PrismaClient } from "@prisma/client";

async function main() {
  const [dbUrl, username] = process.argv.slice(2);
  if (!dbUrl || !username) throw new Error("usage: tsx delete-sessions.ts <DATABASE_URL> <username>");
  const p = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  const r = await p.session.deleteMany({ where: { username } });
  console.log(`deleted ${r.count} sessions for ${username}`);
  await p.$disconnect();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
