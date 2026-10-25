// Sweeper smoke test helper - run by test-guest-e2e.sh.
// Backdates the second guest by 48h, runs sweepStaleGuests(), and checks
// the row is gone. The guest's username arrives via GUEST2_NAME env var.
import { prisma } from "../src/db/client";
import { sweepStaleGuests } from "../src/db/users";

async function main() {
  const username = process.env.GUEST2_NAME || "";
  if (!username) {
    console.log("SWEPT:0:GONE:false (no GUEST2_NAME)");
    return;
  }
  await prisma.$executeRawUnsafe(
    "UPDATE users SET last_login = now() - interval '48 hours' WHERE username = $1",
    username,
  );
  const purged = await sweepStaleGuests();
  const left = await prisma.user.findUnique({ where: { username } });
  console.log(`SWEPT:${purged}:GONE:${left === null}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("sweep helper failed:", e);
  process.exit(1);
});
