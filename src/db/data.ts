// ═══════════════════════════════════════════════════════════
// WeildBuild DB — items, games, notifications, DMs, transactions
// ═══════════════════════════════════════════════════════════
import { randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./client";
import { sanitizeString } from "./users";

// ─────────────────────────── ITEMS ───────────────────────────

export function rowToItem(row: any): any {
  return {
    id: row.id,
    display_name: row.displayName,
    item_type: row.itemType,
    price: row.price,
    description: row.description,
    creator: row.creator,
    color: row.color,
    date_created: row.dateCreated instanceof Date ? row.dateCreated.toISOString() : row.dateCreated,
    data: row.data,
  };
}

export async function getItemsByType(type: string) {
  try {
    const rows = await prisma.item.findMany({ where: { itemType: type } });
    return rows.map(rowToItem);
  } catch {
    return [];
  }
}

export async function getAllItems() {
  try {
    const rows = await prisma.item.findMany();
    return rows.map(rowToItem);
  } catch {
    return [];
  }
}

export async function getItem(itemId: string) {
  if (!itemId || itemId.includes("..") || itemId.includes("/") || itemId.includes("\\")) return null;
  try {
    const row = await prisma.item.findUnique({ where: { id: itemId } });
    return row ? rowToItem(row) : null;
  } catch {
    return null;
  }
}

/**
 * Buy an item — SERVER-AUTHORITATIVE and race-condition safe.
 * The balance deduction and ownership append happen in ONE atomic
 * conditional UPDATE: it only succeeds if the user can afford the
 * item AND doesn't already own it. Two simultaneous buys can never
 * double-spend or double-append.
 */
export async function buyItemAtomic(username: string, itemId: string): Promise<
  { success: true; balanceBefore: number; balanceAfter: number } | { error: string }
> {
  const item = await getItem(itemId);
  if (!item) return { error: "Item not found" };

  const user = await prisma.user.findUnique({ where: { username }, select: { webuy: true, itemsOwned: true } });
  if (!user) return { error: "User not found" };
  if ((user.itemsOwned || []).includes(itemId)) return { error: "You already own this item" };
  if (user.webuy < item.price) return { error: "Insufficient WeBuy balance" };

  const balanceBefore = user.webuy;

  try {
    const updated = await prisma.$executeRaw`
      UPDATE users
      SET webuy = webuy - ${item.price},
          items_owned = array_append(items_owned, ${itemId}::text)
      WHERE username = ${username}
        AND webuy >= ${item.price}
        AND NOT (${itemId}::text = ANY(items_owned))
    `;
    if (updated !== 1) {
      // Lost the race (another request spent the balance or bought the item first)
      return { error: "Purchase failed — please try again" };
    }
    const after = await prisma.user.findUnique({ where: { username }, select: { webuy: true } });
    return { success: true, balanceBefore, balanceAfter: after?.webuy ?? balanceBefore - item.price };
  } catch (e: any) {
    console.error("[db] buyItemAtomic error:", e.message);
    return { error: "Purchase failed. Please try again." };
  }
}

// ─────────────────────────── GAMES ───────────────────────────
// "Game files": extra_data JSONB holds the whole studio state.
// Game hosts read this; the root is never modified by hosts.

export function flattenGame(row: any): any {
  if (!row) return null;
  const base = {
    id: row.id,
    name: row.name,
    description: row.description,
    creator: row.creator,
    plays: row.plays,
    created: row.created instanceof Date ? row.created.toISOString() : row.created,
    last_update: row.lastUpdate instanceof Date ? row.lastUpdate.toISOString() : row.lastUpdate,
  };
  return { ...base, ...(row.extraData || {}) };
}

export async function getGame(gameId: string) {
  if (!gameId || gameId.includes("..") || gameId.includes("/") || gameId.includes("\\")) return null;
  try {
    const row = await prisma.game.findUnique({ where: { id: gameId } });
    return row ? flattenGame(row) : null;
  } catch {
    return null;
  }
}

export async function getAllGames() {
  try {
    const rows = await prisma.game.findMany({ orderBy: { created: "desc" } });
    return rows.map(flattenGame);
  } catch {
    return [];
  }
}

const GAME_TOP_LEVEL_FIELDS = ["name", "description", "creator", "plays"];

export async function createGameRecord(gameData: any) {
  const id = gameData.id || randomBytes(4).toString("hex");
  const { studioState, primitives, spawn_point, sky_color_top, sky_color_bottom,
    baseplate_color, baseplate_size, max_players, public: isPublic,
    multiplayer, ...rest } = gameData;

  const row = {
    id,
    name: gameData.name || "",
    description: gameData.description || "",
    creator: gameData.creator || "",
    plays: 0,
    extraData: {
      studioState, primitives, spawn_point, sky_color_top, sky_color_bottom,
      baseplate_color, baseplate_size, max_players,
      public: isPublic, multiplayer, ...rest,
    } as any,
  };

  try {
    const created = await prisma.game.create({ data: row });
    return flattenGame(created);
  } catch (e: any) {
    console.error("[db] createGameRecord error:", e.message);
    return { ...row, ...row.extraData };
  }
}

export async function updateGameRecord(gameId: string, updates: any) {
  const game = await getGame(gameId);
  if (!game) return null;

  const topLevelUpdates: any = { lastUpdate: new Date() };
  const extraDataUpdates: any = {};
  for (const [key, value] of Object.entries(updates)) {
    if (GAME_TOP_LEVEL_FIELDS.includes(key)) topLevelUpdates[key] = value;
    else extraDataUpdates[key] = value;
  }

  const existingRow = await prisma.game.findUnique({ where: { id: gameId }, select: { extraData: true } });
  const newExtraData = { ...((existingRow?.extraData as any) || {}), ...extraDataUpdates };

  try {
    const updated = await prisma.game.update({
      where: { id: gameId },
      data: { ...topLevelUpdates, extraData: newExtraData as any },
    });
    return flattenGame(updated);
  } catch (e: any) {
    console.error("[db] updateGameRecord error:", e.message);
    return { ...game, ...updates };
  }
}

export async function incrementGamePlays(gameId: string) {
  try {
    await prisma.game.update({ where: { id: gameId }, data: { plays: { increment: 1 } } });
  } catch {}
}

// ─────────────────────── NOTIFICATIONS ───────────────────────

export async function createNotification(username: string, type: string, message: string, from?: string) {
  const id = randomBytes(6).toString("hex");
  const notification = {
    id, username, type,
    message: sanitizeString(message, 500),
    fromUser: from || "",
    read: false,
  };
  try {
    await prisma.notification.create({ data: notification });
  } catch (e: any) {
    console.error("[db] createNotification error:", e.message);
  }
  // API shape: from_user is mapped to "from" (matches original)
  return {
    id, username, type,
    message: notification.message,
    from: notification.fromUser,
    read: false,
    timestamp: new Date().toISOString(),
  };
}

export async function getNotifications(username: string) {
  try {
    const rows = await prisma.notification.findMany({
      where: { username },
      orderBy: { timestamp: "desc" },
    });
    return rows.map((n) => ({
      id: n.id, username: n.username, type: n.type, message: n.message,
      from: n.fromUser || "", read: n.read,
      timestamp: n.timestamp instanceof Date ? n.timestamp.toISOString() : n.timestamp,
    }));
  } catch {
    return [];
  }
}

export async function markNotificationsRead(username: string) {
  try {
    await prisma.notification.updateMany({ where: { username, read: false }, data: { read: true } });
  } catch (e: any) {
    console.error("[db] markNotificationsRead error:", e.message);
  }
  return { success: true };
}

// ─────────────────────────── DMs ─────────────────────────────

export async function saveDMMessage(from: string, to: string, content: string) {
  const id = randomBytes(8).toString("hex");
  const conversationKey = [from, to].sort().join("_");
  const message = {
    id, from, to, conversationKey,
    content: sanitizeString(content, 1000),
  };
  try {
    await prisma.dm.create({ data: message });
  } catch (e: any) {
    console.error("[db] saveDMMessage error:", e.message);
  }
  return {
    id, from, to,
    content: message.content,
    timestamp: new Date().toISOString(),
  };
}

export async function getDMMessages(user1: string, user2: string) {
  const conversationKey = [user1, user2].sort().join("_");
  try {
    const rows = await prisma.dm.findMany({
      where: { conversationKey },
      orderBy: { timestamp: "asc" },
    });
    return rows.map((m) => ({
      id: m.id, from: m.from, to: m.to, content: m.content,
      timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
    }));
  } catch {
    return [];
  }
}

// ──────────────────── TRANSACTION LOGS ───────────────────────

export interface TransactionInput {
  type: "purchase" | "refund" | "reward" | "transfer" | "admin_adjust";
  username: string;
  itemId?: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  description: string;
  performedBy: string;
}

export async function logTransaction(t: TransactionInput): Promise<void> {
  const id = randomBytes(6).toString("hex");
  try {
    await prisma.transactionLog.create({
      data: {
        id,
        logDate: new Date(),
        timestamp: new Date(),
        type: t.type,
        username: t.username,
        itemId: t.itemId || "",
        amount: t.amount,
        balanceBefore: t.balanceBefore,
        balanceAfter: t.balanceAfter,
        description: t.description,
        performedBy: t.performedBy,
      },
    });
  } catch (e: any) {
    console.error("[db] logTransaction error:", e.message);
  }
}

export async function getTransactionLogs(username?: string, date?: string): Promise<any[]> {
  const dateStr = date || new Date().toISOString().split("T")[0];
  try {
    const target = new Date(dateStr + "T00:00:00.000Z");
    const rows = await prisma.transactionLog.findMany({
      where: {
        logDate: { gte: target, lt: new Date(target.getTime() + 24 * 60 * 60 * 1000) },
        ...(username ? { username } : {}),
      },
      orderBy: { timestamp: "desc" },
    });
    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
      type: r.type, username: r.username,
      itemId: r.itemId || undefined,
      amount: r.amount, balanceBefore: r.balanceBefore, balanceAfter: r.balanceAfter,
      description: r.description, performedBy: r.performedBy,
    }));
  } catch {
    return [];
  }
}

// ───────────────────────── FRIENDS ───────────────────────────
// Ported from file-db.ts friend operations (arrays on user rows).

export async function sendFriendRequest(from: string, to: string) {
  const { getUser, saveUser } = await import("./users");
  const targetUser = await getUser(to);
  const fromUser = await getUser(from);
  if (!targetUser) return { error: "User not found" };
  if (from === to) return { error: "Cannot send request to yourself" };
  if ((targetUser.friends || []).includes(from)) return { error: "Already friends" };

  // Mutual request auto-accept
  if (fromUser && (fromUser.friend_requests || []).includes(to)) {
    if (!fromUser.friends.includes(to)) fromUser.friends = [...(fromUser.friends || []), to];
    fromUser.friend_requests = (fromUser.friend_requests || []).filter((f: string) => f !== to);
    fromUser.notifications = [...(fromUser.notifications || []), `You are now friends with ${to}!`];
    await saveUser(from, fromUser);

    if (!targetUser.friends.includes(from)) targetUser.friends = [...(targetUser.friends || []), from];
    targetUser.friend_requests = (targetUser.friend_requests || []).filter((f: string) => f !== from);
    targetUser.notifications = [...(targetUser.notifications || []), `${from} accepted your friend request!`];
    await saveUser(to, targetUser);

    await createNotification(from, "friend_accepted", `You are now friends with ${to}!`, to);
    await createNotification(to, "friend_accepted", `${from} accepted your friend request!`, from);
    return { success: true, autoAccepted: true };
  }

  if ((targetUser.friend_requests || []).includes(from)) return { error: "Already requested" };
  targetUser.friend_requests = [...(targetUser.friend_requests || []), from];
  targetUser.notifications = [...(targetUser.notifications || []), `${from} sent you a friend request!`];
  await saveUser(to, targetUser);
  await createNotification(to, "friend_request", `${from} sent you a friend request!`, from);
  return { success: true };
}

export async function acceptFriendRequest(username: string, friend: string) {
  const { getUser, saveUser } = await import("./users");
  const user = await getUser(username);
  const friendUser = await getUser(friend);
  if (!user || !friendUser) return { error: "User not found" };
  if (!user.friends.includes(friend)) user.friends = [...(user.friends || []), friend];
  user.friend_requests = (user.friend_requests || []).filter((f: string) => f !== friend);
  user.notifications = [...(user.notifications || []), `You are now friends with ${friend}!`];
  await saveUser(username, user);

  if (!friendUser.friends.includes(username)) friendUser.friends = [...(friendUser.friends || []), username];
  friendUser.notifications = [...(friendUser.notifications || []), `${username} accepted your friend request!`];
  await saveUser(friend, friendUser);
  await createNotification(username, "friend_accepted", `You are now friends with ${friend}!`, friend);
  await createNotification(friend, "friend_accepted", `${username} accepted your friend request!`, username);
  return { success: true };
}

export async function declineFriendRequest(username: string, friend: string) {
  const { getUser, saveUser } = await import("./users");
  const user = await getUser(username);
  if (!user) return { error: "User not found" };
  user.friend_requests = (user.friend_requests || []).filter((f: string) => f !== friend);
  await saveUser(username, user);
  return { success: true };
}

export async function cancelFriendRequest(from: string, to: string) {
  const { getUser, saveUser } = await import("./users");
  const targetUser = await getUser(to);
  if (!targetUser) return { error: "User not found" };
  targetUser.friend_requests = (targetUser.friend_requests || []).filter((f: string) => f !== from);
  await saveUser(to, targetUser);
  return { success: true };
}

export async function removeFriend(username: string, friend: string) {
  const { getUser, saveUser } = await import("./users");
  const user = await getUser(username);
  const friendUser = await getUser(friend);
  if (!user) return { error: "User not found" };
  user.friends = (user.friends || []).filter((f: string) => f !== friend);
  await saveUser(username, user);
  if (friendUser) {
    friendUser.friends = (friendUser.friends || []).filter((f: string) => f !== username);
    await saveUser(friend, friendUser);
  }
  return { success: true };
}

// ──────────────────────── CLEANUP ────────────────────────────

export async function runCleanup(): Promise<any> {
  const result: any = {
    notificationsDeleted: 0, readNotificationsDeleted: 0, dmMessagesDeleted: 0,
    chatMessagesDeleted: 0, rateLimitsDeleted: 0, sessionsDeleted: 0,
    transactionLogsDeleted: 0, totalFreed: 0, errors: [],
  };
  const now = Date.now();
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(now - 90 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const oneHourAgo = new Date(now - 60 * 60 * 1000);

  try { result.readNotificationsDeleted = await prisma.notification.deleteMany({ where: { read: true, timestamp: { lt: sevenDaysAgo } } }).then(r => r.count); } catch (e: any) { result.errors.push(`Read notifications: ${e.message}`); }
  try { result.notificationsDeleted = await prisma.notification.deleteMany({ where: { timestamp: { lt: thirtyDaysAgo } } }).then(r => r.count); } catch (e: any) { result.errors.push(`Notifications: ${e.message}`); }
  try { result.dmMessagesDeleted = await prisma.dm.deleteMany({ where: { timestamp: { lt: ninetyDaysAgo } } }).then(r => r.count); } catch (e: any) { result.errors.push(`DMs: ${e.message}`); }
  try { result.chatMessagesDeleted = await prisma.message.deleteMany({ where: { timestamp: { lt: ninetyDaysAgo } } }).then(r => r.count); } catch (e: any) { result.errors.push(`Messages: ${e.message}`); }
  try { result.rateLimitsDeleted = await prisma.rateLimit.deleteMany({ where: { windowStart: { lt: oneHourAgo } } }).then(r => r.count); } catch (e: any) { result.errors.push(`Rate limits: ${e.message}`); }
  try { result.transactionLogsDeleted = await prisma.transactionLog.deleteMany({ where: { logDate: { lt: ninetyDaysAgo } } }).then(r => r.count); } catch (e: any) { result.errors.push(`Transaction logs: ${e.message}`); }

  result.totalFreed =
    result.notificationsDeleted + result.readNotificationsDeleted + result.dmMessagesDeleted +
    result.chatMessagesDeleted + result.rateLimitsDeleted + result.sessionsDeleted +
    result.transactionLogsDeleted;
  return result;
}

export async function trimUserNotificationArrays(): Promise<number> {
  const MAX_NOTIFICATIONS = 50;
  const PAGE_SIZE = 100;
  let trimmed = 0;
  let offset = 0;
  try {
    while (true) {
      const rows = await prisma.user.findMany({
        select: { username: true, notifications: true },
        skip: offset, take: PAGE_SIZE,
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        const notifs = row.notifications || [];
        if (notifs.length > MAX_NOTIFICATIONS) {
          await prisma.user.update({
            where: { username: row.username },
            data: { notifications: notifs.slice(-MAX_NOTIFICATIONS) },
          });
          trimmed++;
        }
      }
      offset += PAGE_SIZE;
    }
  } catch {}
  return trimmed;
}
