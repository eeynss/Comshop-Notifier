require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, EmbedBuilder, Partials } = require("discord.js");

const app = express();
app.use(express.json({ limit: "1mb" }));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

let stockMessageId = null;
let merchantMessageId = null;
let stockAlertMessageId = null;
let lastMerchantActive = false;
let lastMerchantAlertAt = 0;
let lastMerchantAlertKey = "";
let cachedStockRoleId = process.env.STOCK_ROLE_ID || "";
let lastStockMentionSignature = "";
let roleCreateWarned = false;
let roleCreateDisabled = false;
const cachedItemRoleIds = new Map();
let lastCatalogRoleSyncSignature = "";
let lastCatalogRoleSyncAt = 0;
const roleMenuFile = path.join(__dirname, "role-menu.json");
let roleMenuState = loadRoleMenuState();

const EMOJI = {
  stock: "\u{1F4E6}",
  chair: "\u{1FA91}",
  pc: "\u{1F5A5}\uFE0F",
  keyboard: "\u2328\uFE0F",
  mousepad: "\u{1F5B1}\uFE0F",
  table: "\u{1F9F1}",
  grocery: "\u{1F6D2}",
  star: "\u2B50",
  drink: "\u{1F964}",
  water: "\u{1F4A7}",
  food: "\u{1F32F}",
  merchant: "\u{1F9F3}",
};

const CATEGORY = {
  Chair: { icon: EMOJI.chair, title: "Chair" },
  Desktop: { icon: EMOJI.pc, title: "CPU" },
  CPU: { icon: EMOJI.pc, title: "CPU" },
  Keyboard: { icon: EMOJI.keyboard, title: "Keyboard" },
  Monitor: { icon: EMOJI.pc, title: "Monitor" },
  Mousepad: { icon: EMOJI.mousepad, title: "Mousepad" },
  Table: { icon: EMOJI.table, title: "Table" },
  Grocery: { icon: EMOJI.grocery, title: "Grocery" },
};

const ORDER = ["Chair", "Desktop", "CPU", "Keyboard", "Monitor", "Mousepad", "Table", "Grocery"];
const ROLE_MENU_ORDER = ["Chair", "CPU", "Keyboard", "Monitor", "Mousepad", "Table"];
const NUMBER_EMOJIS = ["1\uFE0F\u20E3", "2\uFE0F\u20E3", "3\uFE0F\u20E3", "4\uFE0F\u20E3", "5\uFE0F\u20E3", "6\uFE0F\u20E3", "7\uFE0F\u20E3", "8\uFE0F\u20E3", "9\uFE0F\u20E3", "\u{1F51F}"];

const ROLE_COLORS = {
  Chair: 0x2ecc71,
  Desktop: 0x3498db,
  CPU: 0x3498db,
  Keyboard: 0x9b59b6,
  Monitor: 0x1abc9c,
  Mousepad: 0xe67e22,
  Table: 0xe74c3c,
  Legendary: 0xf1c40f,
  Default: 0x95a5a6,
};

function stockRoleName() {
  return process.env.STOCK_ROLE_NAME || "Comshop Stock";
}

function stockMentionMinStars() {
  const value = Number(process.env.STOCK_MENTION_MIN_STARS);
  return Number.isFinite(value) ? Math.max(0, Math.min(5, value)) : 4;
}

function itemRoleMentionsEnabled() {
  return process.env.ITEM_ROLE_MENTIONS !== "false";
}

function itemRolePrefix() {
  return process.env.ITEM_ROLE_PREFIX || "Comshop";
}

function itemRoleMinStars() {
  const value = Number(process.env.ITEM_ROLE_MIN_STARS);
  return Number.isFinite(value) ? Math.max(0, Math.min(5, value)) : 1;
}

function maxItemRoleMentions() {
  const value = Number(process.env.MAX_ITEM_ROLE_MENTIONS);
  return Number.isFinite(value) ? Math.max(1, Math.min(50, value)) : 50;
}

function cleanRoleName(value) {
  return String(value || "")
    .replace(/[^\w\s\-\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function loadRoleMenuState() {
  try {
    if (!fs.existsSync(roleMenuFile)) return { messages: {} };
    const parsed = JSON.parse(fs.readFileSync(roleMenuFile, "utf8"));
    if (!parsed || typeof parsed !== "object") return { messages: {} };
    if (!parsed.messages || typeof parsed.messages !== "object") parsed.messages = {};
    return parsed;
  } catch {
    return { messages: {} };
  }
}

function saveRoleMenuState() {
  try {
    fs.writeFileSync(roleMenuFile, JSON.stringify(roleMenuState, null, 2), "utf8");
  } catch (err) {
    console.warn("Could not save role menu state:", err.message || err);
  }
}

function roleColorForItem(item) {
  if ((Number(item?.stars) || 0) >= 5) return ROLE_COLORS.Legendary;
  return ROLE_COLORS[item?.categoryName] || ROLE_COLORS.Default;
}

function robloxImage(assetId) {
  if (!assetId) return null;
  return `https://www.roblox.com/asset-thumbnail/image?assetId=${assetId}&width=420&height=420&format=png`;
}

function stars(n) {
  const count = Math.max(0, Math.min(5, Number(n) || 0));
  return count ? EMOJI.star.repeat(count) : "";
}

function eta(seconds) {
  seconds = Math.max(0, Number(seconds) || 0);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function etaLong(seconds) {
  seconds = Math.max(0, Number(seconds) || 0);
  if (seconds < 60) return `in ${seconds} seconds`;
  if (seconds < 3600) return `in ${Math.floor(seconds / 60)} minutes`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `in ${hours} hour${hours === 1 ? "" : "s"}${minutes ? ` & ${minutes} minutes` : ""}`;
}

function absoluteTime(seconds) {
  const date = new Date(Date.now() + Math.max(0, Number(seconds) || 0) * 1000);
  return date.toLocaleString("en-US", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function discordTimestamp(seconds, style = "R") {
  const unix = Math.floor((Date.now() + Math.max(0, Number(seconds) || 0) * 1000) / 1000);
  return `<t:${unix}:${style}>`;
}

function normalizeCategoryPayload(payload) {
  if (payload.categories && typeof payload.categories === "object") return payload.categories;
  const categories = {};
  if (payload.pcParts) categories["PC Parts"] = payload.pcParts;
  if (payload.grocery) categories.Grocery = payload.grocery;
  return categories;
}

function itemLine(item) {
  const qty = item.amount ?? 1;
  const starText = item.stars ? ` ${stars(item.stars)}` : "";
  return `\u2022 **${item.name}** x${qty}${starText}`;
}

function itemIcon(item) {
  const raw = String(item.emoji || "").toLowerCase();
  const name = String(item.name || "").toLowerCase();
  if (raw.includes("chair")) return EMOJI.chair;
  if (raw.includes("keyboard")) return EMOJI.keyboard;
  if (raw.includes("mouse")) return EMOJI.mousepad;
  if (raw.includes("table")) return EMOJI.table;
  if (raw.includes("monitor") || raw.includes("cpu") || raw.includes("pc")) return EMOJI.pc;
  if (name.includes("water")) return EMOJI.water;
  if (name.includes("c5") || name.includes("toby")) return EMOJI.drink;
  if (name.includes("lumpia") || name.includes("pancit") || name.includes("beef")) return EMOJI.food;
  if (name.includes("oil")) return "🛢️";
  return EMOJI.stock;
}

function compactList(items, maxItems = 4) {
  if (!items || !items.length) return "No stock";
  const shown = items.slice(0, maxItems).map(itemLine);
  const hidden = items.length - shown.length;
  if (hidden > 0) shown.push(`+${hidden} more`);
  return shown.join("\n");
}

function bestThumbnail(categories) {
  const all = [];
  for (const data of Object.values(categories)) {
    for (const item of data.available || []) all.push(item);
  }

  const sorted = all.sort((a, b) => {
    const aScore = (Number(a.stars) || 0) * 1000000 + (Number(a.amount) || 0);
    const bScore = (Number(b.stars) || 0) * 1000000 + (Number(b.amount) || 0);
    return bScore - aScore;
  });

  const item = sorted.find((x) => x.image);
  return item ? robloxImage(item.image) : null;
}

function bestRarity(categories) {
  let best = 0;
  for (const data of Object.values(categories)) {
    for (const item of data.available || []) best = Math.max(best, Number(item.stars) || 0);
  }
  if (best >= 5) return `${stars(5)} Legendary stock detected`;
  if (best >= 4) return `${stars(4)} Epic stock detected`;
  if (best >= 3) return `${stars(3)} Rare stock detected`;
  if (best >= 2) return `${stars(2)} Uncommon stock detected`;
  return "Live stock update";
}

function shortestRestock(categories) {
  let best = null;
  for (const data of Object.values(categories)) {
    const value = Number(data.restockSeconds);
    if (!Number.isNaN(value) && (best === null || value < best)) best = value;
  }
  return best ?? 0;
}

async function getOrCreateStockRole(channel) {
  if (!channel?.guild) return null;
  const guild = channel.guild;

  if (roleCreateDisabled) return null;

  if (cachedStockRoleId) {
    const cached = guild.roles.cache.get(cachedStockRoleId) || await guild.roles.fetch(cachedStockRoleId).catch(() => null);
    if (cached) return cached;
    cachedStockRoleId = "";
  }

  const name = stockRoleName();
  const existing = guild.roles.cache.find((role) => role.name === name) || (await guild.roles.fetch()).find((role) => role.name === name);
  if (existing) {
    cachedStockRoleId = existing.id;
    return existing;
  }

  try {
    const role = await guild.roles.create({
      name,
      color: 0x2b8cff,
      mentionable: true,
      reason: "Comshop stock alert role",
    });
    cachedStockRoleId = role.id;
    return role;
  } catch (err) {
    roleCreateDisabled = true;
    if (!roleCreateWarned) {
      roleCreateWarned = true;
      console.warn(`Could not create stock role "${name}". Create it manually or give the bot Manage Roles permission, then restart the bot.`);
    }
    return null;
  }
}

async function getOrCreateItemRole(channel, item) {
  if (!itemRoleMentionsEnabled() || !channel?.guild || roleCreateDisabled) return null;

  const guild = channel.guild;
  const itemName = typeof item === "string" ? item : item.name;
  const roleColor = roleColorForItem(typeof item === "string" ? { name: itemName } : item);
  const roleName = cleanRoleName(`${itemRolePrefix()} ${itemName}`);
  if (!roleName) return null;

  if (cachedItemRoleIds.has(roleName)) {
    const cachedId = cachedItemRoleIds.get(roleName);
    const cached = guild.roles.cache.get(cachedId) || await guild.roles.fetch(cachedId).catch(() => null);
    if (cached) return cached;
    cachedItemRoleIds.delete(roleName);
  }

  const roles = await guild.roles.fetch();
  const existing = roles.find((role) => role.name === roleName);
  if (existing) {
    if (existing.color !== roleColor) {
      await existing.edit({ color: roleColor }).catch(() => null);
    }
    cachedItemRoleIds.set(roleName, existing.id);
    return existing;
  }

  try {
    const role = await guild.roles.create({
      name: roleName,
      color: roleColor,
      mentionable: true,
      reason: `Comshop item alert role for ${itemName}`,
    });
    cachedItemRoleIds.set(roleName, role.id);
    return role;
  } catch (err) {
    roleCreateDisabled = true;
    if (!roleCreateWarned) {
      roleCreateWarned = true;
      console.warn("Could not create item roles. Check Manage Roles/Admin permission and role order, then restart the bot.");
    }
    return null;
  }
}

function importantStockItems(categories) {
  const minStars = stockMentionMinStars();
  const items = [];

  for (const [categoryName, data] of Object.entries(categories)) {
    for (const item of data.available || []) {
      if ((Number(item.stars) || 0) >= minStars) {
        items.push({
          categoryName,
          name: item.name,
          amount: Number(item.amount) || 1,
          stars: Number(item.stars) || 0,
        });
      }
    }
  }

  return items.sort((a, b) => {
    if (b.stars !== a.stars) return b.stars - a.stars;
    return a.name.localeCompare(b.name);
  });
}

function itemRoleStockItems(categories) {
  const minStars = itemRoleMinStars();
  const items = [];

  for (const [categoryName, data] of Object.entries(categories)) {
    if (categoryName === "Grocery") continue;
    for (const item of data.available || []) {
      const starsValue = Number(item.stars) || 0;
      if (starsValue >= minStars) {
        items.push({
          categoryName,
          name: item.name,
          amount: Number(item.amount) || 1,
          stars: starsValue,
        });
      }
    }
  }

  return items.sort((a, b) => {
    if (b.stars !== a.stars) return b.stars - a.stars;
    return a.name.localeCompare(b.name);
  });
}

function catalogRoleItems(categories) {
  const items = [];
  const seen = new Set();

  for (const [categoryName, data] of Object.entries(categories)) {
    if (categoryName === "Grocery") continue;
    const source = Array.isArray(data.catalog) && data.catalog.length ? data.catalog : data.available || [];
    for (const item of source) {
      const name = String(item.name || "");
      if (!name || seen.has(name)) continue;
      seen.add(name);
      items.push({
        categoryName,
        name,
        amount: Number(item.amount) || 0,
        stars: Number(item.stars) || 0,
      });
    }
  }

  return items.sort((a, b) => {
    if (a.categoryName !== b.categoryName) return a.categoryName.localeCompare(b.categoryName);
    if (b.stars !== a.stars) return b.stars - a.stars;
    return a.name.localeCompare(b.name);
  });
}

async function syncCatalogRoles(channel, categories) {
  if (!itemRoleMentionsEnabled() || roleCreateDisabled) return;
  const items = catalogRoleItems(categories);
  const signature = stockMentionSignature(items);
  const now = Date.now();
  if (!items.length || (signature === lastCatalogRoleSyncSignature && now - lastCatalogRoleSyncAt < 300000)) return;

  lastCatalogRoleSyncSignature = signature;
  lastCatalogRoleSyncAt = now;

  for (const item of items) {
    await getOrCreateItemRole(channel, item);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function buildRoleMenuEntries(channel, categoryName, data) {
  const source = Array.isArray(data.catalog) && data.catalog.length ? data.catalog : data.available || [];
  const entries = [];
  const seen = new Set();

  for (const item of source) {
    const name = String(item.name || "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const role = await getOrCreateItemRole(channel, {
      categoryName,
      name,
      amount: Number(item.amount) || 0,
      stars: Number(item.stars) || 0,
    });
    if (!role) continue;
    entries.push({
      name,
      roleId: role.id,
      stars: Number(item.stars) || 0,
    });
  }

  return entries
    .sort((a, b) => {
      if (b.stars !== a.stars) return b.stars - a.stars;
      return a.name.localeCompare(b.name);
    })
    .slice(0, NUMBER_EMOJIS.length)
    .map((entry, index) => ({
      ...entry,
      emoji: NUMBER_EMOJIS[index],
    }));
}

function roleMenuContent(categoryName, entries) {
  const lines = [`**${categoryName.toUpperCase()}**`];
  for (const entry of entries) {
    lines.push(`${entry.emoji} - <@&${entry.roleId}>`);
  }
  lines.push("");
  lines.push("React with a number to get/remove that stock alert role.");
  return lines.join("\n");
}

async function postOrUpdateRoleMenu(channel, categoryName, entries) {
  if (!entries.length) return;

  const content = roleMenuContent(categoryName, entries);
  const saved = roleMenuState.messages[categoryName];
  let message = null;

  if (saved?.messageId) {
    message = await channel.messages.fetch(saved.messageId).catch(() => null);
  }

  if (message) {
    await message.edit({ content, allowedMentions: { parse: [] } });
    await message.reactions.removeAll().catch(() => null);
  } else {
    message = await channel.send({ content, allowedMentions: { parse: [] } });
  }

  for (const entry of entries) {
    await message.react(entry.emoji).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  roleMenuState.messages[categoryName] = {
    messageId: message.id,
    roles: Object.fromEntries(entries.map((entry) => [entry.emoji, entry.roleId])),
  };
  saveRoleMenuState();
}

async function syncRoleMenus(categories) {
  const channelId = process.env.ROLE_MENU_CHANNEL_ID;
  if (!channelId || !itemRoleMentionsEnabled() || roleCreateDisabled) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  for (const categoryName of ROLE_MENU_ORDER) {
    const data = categories[categoryName];
    if (!data) continue;
    const entries = await buildRoleMenuEntries(channel, categoryName, data);
    await postOrUpdateRoleMenu(channel, categoryName, entries);
  }
}

function roleIdFromReaction(reaction) {
  const messageId = reaction.message?.id;
  const emoji = reaction.emoji?.name;
  if (!messageId || !emoji) return null;

  for (const data of Object.values(roleMenuState.messages || {})) {
    if (data.messageId === messageId) return data.roles?.[emoji] || null;
  }
  return null;
}

async function handleRoleReaction(reaction, user, shouldAdd) {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch().catch(() => null);
  if (reaction.message?.partial) await reaction.message.fetch().catch(() => null);

  const roleId = roleIdFromReaction(reaction);
  if (!roleId) return;

  const guild = reaction.message.guild;
  if (!guild) return;
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  if (shouldAdd) {
    await member.roles.add(roleId).catch((err) => console.warn("Could not add role:", err.message || err));
  } else {
    await member.roles.remove(roleId).catch((err) => console.warn("Could not remove role:", err.message || err));
  }
}

function stockMentionSignature(items) {
  return items.map((item) => `${item.categoryName}:${item.name}:${item.amount}:${item.stars}`).join("|");
}

async function buildStockMention(channel, categories) {
  const important = importantStockItems(categories);
  const itemRoleItems = itemRoleStockItems(categories).slice(0, maxItemRoleMentions());
  const signature = stockMentionSignature([...important, ...itemRoleItems]);
  if (signature === lastStockMentionSignature) return { changed: false, content: "", allowedMentions: { parse: [] } };

  const roleMentions = [];
  const allowedRoleIds = [];

  if (important.length) {
    const role = await getOrCreateStockRole(channel);
    if (role) {
      roleMentions.push(`<@&${role.id}>`);
      allowedRoleIds.push(role.id);
    }
  }

  for (const item of itemRoleItems) {
    const role = await getOrCreateItemRole(channel, item);
    if (role && !allowedRoleIds.includes(role.id)) {
      roleMentions.push(`<@&${role.id}>`);
      allowedRoleIds.push(role.id);
    }
  }

  if (!allowedRoleIds.length) {
    lastStockMentionSignature = signature;
    return { changed: true, content: "", allowedMentions: { parse: [] } };
  }

  lastStockMentionSignature = signature;
  return {
    changed: true,
    content: roleMentions.join(" "),
    allowedMentions: { roles: allowedRoleIds },
  };
}

async function deleteStockAlert(channel) {
  if (!stockAlertMessageId) return;
  try {
    const msg = await channel.messages.fetch(stockAlertMessageId);
    await msg.delete();
  } catch {
  }
  stockAlertMessageId = null;
}

async function sendFreshStockAlert(channel, mention) {
  if (!mention.changed) return;

  await deleteStockAlert(channel);

  if (!mention.content) return;

  const msg = await channel.send({
    content: mention.content,
    allowedMentions: mention.allowedMentions || { parse: [] },
  });
  stockAlertMessageId = msg.id;
}

function makeDashboardEmbed(payload) {
  const categories = normalizeCategoryPayload(payload);
  const fields = [];

  for (const name of ORDER) {
    if (!categories[name]) continue;
    const info = CATEGORY[name] || { icon: EMOJI.stock, title: name };
    fields.push({
      name: `${info.icon} ${info.title}`,
      value: compactList(categories[name].available || [], name === "Grocery" ? 6 : 4),
      inline: false,
    });
  }

  for (const [name, data] of Object.entries(categories)) {
    if (ORDER.includes(name)) continue;
    fields.push({
      name: `${EMOJI.stock} ${name}`,
      value: compactList(data.available || [], 4),
      inline: false,
    });
  }

  if (!fields.length) fields.push({ name: "Stock", value: "No stock", inline: false });

  const embed = new EmbedBuilder()
    .setColor(0x2b8cff)
    .setTitle(`${EMOJI.pc} Comshop Stock - next restock ${eta(shortestRestock(categories))}`)
    .setDescription(`${bestRarity(categories)}\nNext restock: ${discordTimestamp(shortestRestock(categories), "R")} (${discordTimestamp(shortestRestock(categories), "f")})`)
    .addFields(fields.slice(0, 25))
    .setFooter({ text: `Comshop Stock Bot • ${new Date().toLocaleString()}` })
    .setTimestamp();

  const thumb = bestThumbnail(categories);
  if (thumb) embed.setThumbnail(thumb);
  return embed;
}

function makeMerchantEmbed(merchant) {
  const etaSeconds = merchant?.etaSeconds || 0;
  const active = merchant && merchant.active === true;
  return new EmbedBuilder()
    .setColor(active ? 0x3498db : 0x8e44ad)
    .setTitle(`${EMOJI.merchant} ${active ? "Traveling Merchant Arrived" : "Traveling Merchant"}`)
    .setDescription(active ? "Merchant detected in your server." : "Merchant is not in your server right now.")
    .addFields(
      {
        name: "Status",
        value: active ? "Available now" : "Waiting for next arrival",
        inline: false,
      },
      {
        name: "Next Arrival",
        value: `${discordTimestamp(etaSeconds, "R")}\n${discordTimestamp(etaSeconds, "F")}`,
        inline: false,
      }
    )
    .setFooter({ text: `Comshop Script • Today at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` })
    .setTimestamp();
}

async function sendOrEditMerchant(payload) {
  const merchant = payload.merchant;
  if (!merchant) return;

  const channel = await client.channels.fetch(process.env.CHANNEL_ID);
  const active = merchant && merchant.active === true;
  const now = Date.now();
  const merchantKey = String(merchant?.cycleId || merchant?.activeEndsAt || merchant?.nextArrivalAt || "active");
  const shouldPing = active && !((lastMerchantActive && lastMerchantAlertKey === merchantKey) || now - lastMerchantAlertAt < 30000);
  const merchantRole = shouldPing && process.env.MERCHANT_MENTION_ROLE !== "false" ? await getOrCreateStockRole(channel) : null;
  const messageData = {
    content: shouldPing ? `${merchantRole ? `<@&${merchantRole.id}>` : "@everyone"} Traveling merchant arrived.` : "",
    allowedMentions: shouldPing ? (merchantRole ? { roles: [merchantRole.id] } : { parse: ["everyone"] }) : { parse: [] },
    embeds: [makeMerchantEmbed(merchant)],
  };

  if (!active) {
    lastMerchantActive = false;
  }

  if (shouldPing) {
    lastMerchantActive = true;
    lastMerchantAlertAt = now;
    lastMerchantAlertKey = merchantKey;

    const msg = await channel.send(messageData);
    merchantMessageId = msg.id;
    return;
  }

  if (merchantMessageId) {
    try {
      const msg = await channel.messages.fetch(merchantMessageId);
      await msg.edit(messageData);
      return;
    } catch {
      merchantMessageId = null;
    }
  }

  const msg = await channel.send(messageData);
  merchantMessageId = msg.id;
}

async function sendOrEditStock(payload) {
  const channel = await client.channels.fetch(process.env.CHANNEL_ID);
  const categories = normalizeCategoryPayload(payload);
  const embeds = [makeDashboardEmbed(payload)];
  const mention = await buildStockMention(channel, categories);

  if (stockMessageId) {
    try {
      const msg = await channel.messages.fetch(stockMessageId);
      await msg.edit({ content: payload.mention || "", allowedMentions: { parse: [] }, embeds });
      await sendFreshStockAlert(channel, mention);
      await syncCatalogRoles(channel, categories);
      await syncRoleMenus(categories);
      await sendOrEditMerchant(payload);
      return;
    } catch {
      stockMessageId = null;
    }
  }

  const msg = await channel.send({ content: payload.mention || "", allowedMentions: { parse: [] }, embeds });
  stockMessageId = msg.id;
  await sendFreshStockAlert(channel, mention);
  await syncCatalogRoles(channel, categories);
  await syncRoleMenus(categories);
  await sendOrEditMerchant(payload);
}

app.post("/stock", async (req, res) => {
  try {
    await sendOrEditStock(req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.get("/", (req, res) => {
  res.send("Comshop Stock Bot is running. Open /test-stock to send a compact test embed. Roblox must POST to /stock.");
});

app.get("/stock", (req, res) => {
  res.send("This endpoint works, but real stock must POST here. Open /test-stock to send a test message.");
});

app.get("/test-stock", async (req, res) => {
  try {
    await sendOrEditStock({
      merchant: {
        active: true,
        etaSeconds: 3600,
      },
      categories: {
        Chair: {
          restockSeconds: 5,
          available: [
            { name: "NexusChair", amount: 1, stars: 5, image: "128494832385197" },
            { name: "OfficeChair", amount: 2, stars: 4, image: "136636352286287" },
          ],
        },
        Desktop: {
          restockSeconds: 5,
          available: [
            { name: "Dark Nexus", amount: 1, stars: 5, image: "98608009751617" },
            { name: "FlatCore", amount: 3, stars: 2, image: "127471472822110" },
          ],
        },
        Keyboard: {
          restockSeconds: 5,
          available: [
            { name: "Nightfall Keyboard", amount: 1, stars: 5, image: "81545220377326" },
          ],
        },
        Monitor: {
          restockSeconds: 5,
          available: [
            { name: "Aether", amount: 1, stars: 5, image: "79988758475649" },
          ],
        },
        Mousepad: {
          restockSeconds: 5,
          available: [
            { name: "Fuji", amount: 1, stars: 5, image: "137835490071359" },
          ],
        },
        Table: {
          restockSeconds: 5,
          available: [
            { name: "GamingTable", amount: 1, stars: 5, image: "83410671217765" },
          ],
        },
        Grocery: {
          restockSeconds: 300,
          available: [
            { name: "C5 Apol", amount: 3, image: "71765894288086" },
            { name: "Water", amount: 5, image: "136344815592243" },
            { name: "Lumpia", amount: 2, image: "133951432355082" },
          ],
        },
      },
    });
    res.send("Compact test stock sent to Discord. Check your channel.");
  } catch (err) {
    console.error(err);
    res.status(500).send("Test failed: " + String(err.message || err));
  }
});

client.once("ready", () => {
  console.log(`Bot online as ${client.user.tag}`);
  app.listen(process.env.PORT || 3000, () => {
    console.log(`Stock API running on port ${process.env.PORT || 3000}`);
  });
});

client.on("messageReactionAdd", (reaction, user) => {
  handleRoleReaction(reaction, user, true).catch((err) => console.warn("Reaction add failed:", err.message || err));
});

client.on("messageReactionRemove", (reaction, user) => {
  handleRoleReaction(reaction, user, false).catch((err) => console.warn("Reaction remove failed:", err.message || err));
});

client.login(process.env.BOT_TOKEN);
