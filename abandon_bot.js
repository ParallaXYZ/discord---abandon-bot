const CONFIG = {
  PRODUCTION_SEND_ENABLED: true,

  TEXT: {
    newDealHeader: "🎮 **СВЕЖАЯ ХАЛЯВА**",
    typeFreeGame: "БЕСПЛАТНАЯ ИГРА",
    typeFreeWeekend: "БЕСПЛАТНЫЕ ВЫХОДНЫЕ",
    typeDiscount: "СКИДКА",
    storeSteam: "Steam",
    storeEpic: "Epic Games",
    freePrice: "БЕСПЛАТНО",
    priceLabel: "💰",
    expiresLabel: "⏳ До",
    fieldType: "Тип",
    fieldStore: "Площадка",
    fieldPublisher: "Издатель",
    fieldGenres: "Жанры"
  },

  BUTTONS: {
    freeGames: { label: "Бесплатные игры", emoji: "🎁" },
    discounts: { label: "Скидки", emoji: "🔥" },
    steam: { label: "Steam" },
    epic: { label: "Epic Games" },
    freeWeekend: { label: "Бесплатные выходные", emoji: "🎮" },
    allDeals: { label: "Вся подноготная", emoji: "🔄" }
  }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Abandon Bot is running", { status: 200 });
    }

    if (request.method === "GET" && url.pathname === "/send-new-deals") {
      try {
        if (!env.DEALS_KV) {
          throw new Error("DEALS_KV binding not found.");
        }

        const commit = url.searchParams.get("commit") === "1";
        const deals = await getCurrentDeals();
        const newDeals = await getProductionNewDeals(deals, env.DEALS_KV);

        if (!commit) {
          return Response.json({
            ok: true,
            commit: false,
            productionSendEnabled: CONFIG.PRODUCTION_SEND_ENABLED,
            totalDeals: deals.length,
            newDealsCount: newDeals.length,
            newDeals: newDeals.map((deal, index) => ({
              id: deal.id,
              title: deal.title,
              store: deal.store,
              type: deal.type,
              price: deal.price,
              originalPrice: deal.originalPrice,
              discount: deal.discount,
              expires: deal.expires,
              discordPreview: buildDealDiscordMessage(
                deal,
                index === newDeals.length - 1
              )
            }))
          });
        }

        if (!CONFIG.PRODUCTION_SEND_ENABLED) {
          return Response.json(
            {
              ok: false,
              blocked: true,
              productionSendEnabled: false,
              message: "Production sending is disabled."
            },
            { status: 403 }
          );
        }

        if (newDeals.length === 0) {
          return Response.json({
            ok: true,
            commit: true,
            sent: 0,
            failed: 0,
            message: "No new deals."
          });
        }

        const result = await sendNewDealsToDiscord(newDeals, env);

        return Response.json({
          ok: result.ok,
          commit: true,
          sent: result.sent,
          failed: result.failed,
          results: result.results
        });
      } catch (error) {
        console.error(error);

        return Response.json(
          {
            ok: false,
            error: error.message
          },
          { status: 500 }
        );
      }
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const signature = request.headers.get("x-signature-ed25519");
    const timestamp = request.headers.get("x-signature-timestamp");

    if (!signature || !timestamp) {
      return new Response("Missing signature", { status: 401 });
    }

    const body = await request.text();

    const valid = await verifyDiscordRequest(
      body,
      signature,
      timestamp,
      env.DISCORD_PUBLIC_KEY
    );

    if (!valid) {
      return new Response("Invalid request signature", { status: 401 });
    }

    const interaction = JSON.parse(body);

    if (interaction.type === 1) {
      return Response.json({ type: 1 });
    }

    if (interaction.type === 3) {
      try {
        const deals = await getCurrentDeals();
        const response = buildInteractionResponse(
          interaction.data?.custom_id,
          deals
        );

        return Response.json({
          type: 4,
          data: {
            ...response,
            flags: 64
          }
        });
      } catch (error) {
        console.error(error);

        return Response.json({
          type: 4,
          data: {
            content: "Не удалось получить актуальные акции. Попробуй ещё раз чуть позже.",
            flags: 64
          }
        });
      }
    }

    return Response.json({
      type: 4,
      data: {
        content: "Неизвестное действие.",
        flags: 64
      }
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledDealsCheck(env));
  }
};


async function runScheduledDealsCheck(env) {
  try {
    if (!CONFIG.PRODUCTION_SEND_ENABLED) {
      console.log("Cron skipped: production sending is disabled.");
      return;
    }

    if (!env.DEALS_KV) {
      throw new Error("DEALS_KV binding not found.");
    }

    const deals = await getCurrentDeals();
    const newDeals = await getProductionNewDeals(deals, env.DEALS_KV);

    if (newDeals.length === 0) {
      console.log(`Cron complete: ${deals.length} current deals, 0 new deals.`);
      return;
    }

    const result = await sendNewDealsToDiscord(newDeals, env);

    console.log(
      `Cron complete: ${deals.length} current deals, ${newDeals.length} new, ${result.sent} sent, ${result.failed} failed.`
    );
  } catch (error) {
    console.error("Cron deals check failed:", error);
  }
}


function buildInteractionResponse(customId, deals) {
  const filters = {
    free_games: {
      title: "🎁 Бесплатные игры",
      filter: (deal) => deal.type === "free_game"
    },
    discounts: {
      title: "🔥 Скидки",
      filter: (deal) => deal.type === "discount"
    },
    steam: {
      title: "Steam",
      filter: (deal) => deal.store === "steam"
    },
    epic: {
      title: "Epic Games",
      filter: (deal) => deal.store === "epic"
    },
    free_weekend: {
      title: "🎮 Бесплатные выходные",
      filter: (deal) => deal.type === "free_weekend"
    },
    all_deals: {
      title: "🔄 Вся подноготная",
      filter: () => true
    }
  };

  const config = filters[customId];

  if (!config) {
    return {
      content: "Неизвестное действие."
    };
  }

  const filteredDeals = deals.filter(config.filter);

  if (filteredDeals.length === 0) {
    return {
      embeds: [
        {
          title: config.title,
          description: "Сейчас подходящих активных акций нет."
        }
      ]
    };
  }

  const description =
    customId === "all_deals"
      ? buildGroupedDealsList(filteredDeals)
      : buildSimpleDealsList(filteredDeals);

  return {
    embeds: [
      {
        title: config.title,
        description,
        footer: {
          text: `Найдено: ${filteredDeals.length}`
        }
      }
    ]
  };
}

function buildGroupedDealsList(deals) {
  const sections = [
    {
      title: "🎁 Бесплатные игры",
      deals: deals.filter((deal) => deal.type === "free_game")
    },
    {
      title: "🎮 Бесплатные выходные",
      deals: deals.filter((deal) => deal.type === "free_weekend")
    },
    {
      title: "🔥 Скидки",
      deals: deals.filter((deal) => deal.type === "discount")
    }
  ].filter((section) => section.deals.length > 0);

  const blocks = sections.map((section) => {
    const items = section.deals.map(formatDealListItem).join("\n\n\n");
    return `**${section.title}**\n\n${items}`;
  });

  return clampEmbedDescription(blocks.join("\n\n━━━━━━━━━━━━\n\n"));
}

function buildSimpleDealsList(deals) {
  return clampEmbedDescription(
    deals.map(formatDealListItem).join("\n\n\n")
  );
}

function clampEmbedDescription(description) {
  const maxLength = 4000;

  if (description.length <= maxLength) {
    return description;
  }

  const suffix = "\n\n…список сокращён из-за лимита Discord.";
  return description.slice(0, maxLength - suffix.length) + suffix;
}

function formatDealListItem(deal) {
  const storeName =
    deal.store === "steam"
      ? CONFIG.TEXT.storeSteam
      : CONFIG.TEXT.storeEpic;

  const lines = [
    `${getDealTypeEmoji(deal)} **[${escapeDiscordMarkdown(deal.title)}](${deal.url})**`
  ];

  if (deal.type === "discount") {
    let pricePart = "";

    if (deal.price && deal.originalPrice) {
      pricePart = ` · **−${deal.discount || ""}%** · ~~${deal.originalPrice}~~ → **${deal.price}**`;
    } else if (deal.price) {
      pricePart = ` · **−${deal.discount || ""}%** · **${deal.price}**`;
    } else if (deal.discount) {
      pricePart = ` · **−${deal.discount}%**`;
    }

    lines.push(`${storeName}${pricePart}`);
  } else if (deal.type === "free_game") {
    lines.push(`${storeName} · **${CONFIG.TEXT.freePrice}**`);
  } else if (deal.type === "free_weekend") {
    lines.push(`${storeName} · **${CONFIG.TEXT.typeFreeWeekend}**`);
  } else {
    lines.push(`${storeName}`);
  }

  if (deal.expires) {
    lines.push(`⏳ до ${formatDateRu(deal.expires)}`);
  }

  return lines.join("\n\n");
}

function getDealTypeEmoji(deal) {
  if (deal.type === "free_game") {
    return "🎁";
  }

  if (deal.type === "free_weekend") {
    return "🎮";
  }

  if (deal.type === "discount") {
    return "🔥";
  }

  return "🎮";
}

function escapeDiscordMarkdown(value) {
  return String(value || "").replace(/([\\`*_{}\[\]()<>#+\-.!|])/g, "\\$1");
}

async function getCurrentDeals() {
  const [freeDeals, discountDeals] = await Promise.all([
    fetchDealsFeed("https://game-deals.app/rss/free", "free"),
    fetchDealsFeed("https://game-deals.app/rss/discounts", "discount")
  ]);

  const allDeals = [...freeDeals, ...discountDeals];

  const filteredDeals = allDeals.filter(
    (deal) => deal.store === "steam" || deal.store === "epic"
  );

  const uniqueDeals = Array.from(
    new Map(filteredDeals.map((deal) => [deal.id, deal])).values()
  );

  uniqueDeals.sort((a, b) =>
    a.title.localeCompare(b.title, "en", {
      sensitivity: "base",
      numeric: true
    })
  );

  return uniqueDeals;
}

async function getProductionNewDeals(deals, kv) {
  const newDeals = [];

  for (const deal of deals) {
    const existing = await kv.get(`seen:${deal.id}`);

    if (!existing && !(await hasLegacySteamDiscount(deal, kv))) {
      newDeals.push(deal);
    }
  }

  return newDeals;
}

function steamDiscountAppId(id, url) {
  return String(id || "").match(/^steam_(\d+)_/)?.[1] ||
    String(url || "").match(/^https?:\/\/store\.steampowered\.com\/app\/(\d+)(?:\/|\?|$)/i)?.[1] || null;
}

function normalizeDiscountExpiry(value) {
  const text = String(value || "").trim();
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/);
  if (iso) {
    const date = new Date(`${iso[1]}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso[1]
      ? iso[1] : null;
  }
  const timestamp = text.match(/^TIMESTAMP(\d{10}|\d{13})$/i);
  if (timestamp) {
    return new Date(Number(timestamp[1]) * (timestamp[1].length === 10 ? 1000 : 1))
      .toISOString().slice(0, 10);
  }
  return null;
}

function steamDiscountIdentity(deal) {
  if (deal.store !== "steam" || deal.type !== "discount") return null;
  const appId = steamDiscountAppId(deal.id, deal.url);
  if (!appId) return null;
  const expires = normalizeDiscountExpiry(deal.expires) ||
    normalizeDiscountExpiry(String(deal.id || "").replace(/^steam_\d+_/, ""));
  return expires ? { appId, expires, id: `steam_${appId}_${expires}` } : null;
}

async function hasLegacySteamDiscount(deal, kv) {
  const identity = steamDiscountIdentity(deal);
  if (!identity) return false;

  // Old keys contain either a textual date or TIMESTAMP. Their stored expires
  // field identifies the actual sale period, independently of the key format.
  let cursor;
  do {
    const page = await kv.list({ prefix: `seen:steam_${identity.appId}_`, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) {
      const raw = await kv.get(key.name);
      if (!raw) continue;
      let record;
      try {
        record = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!record || record.store !== "steam" || record.type !== "discount") continue;
      const previous = steamDiscountIdentity({ ...record, id: key.name.slice(5) });
      if (previous?.id === identity.id) return true;
    }
    if (page.list_complete) break;
    if (!page.cursor || page.cursor === cursor) {
      throw new Error("Incomplete Steam discount history scan: missing KV cursor.");
    }
    cursor = page.cursor;
  } while (true);
  return false;
}

async function sendNewDealsToDiscord(deals, env) {
  const results = [];
  let sent = 0;
  let failed = 0;

  for (let index = 0; index < deals.length; index++) {
    const deal = deals[index];
    const includeButtons = index === deals.length - 1;
    const payload = buildDealDiscordMessage(deal, includeButtons);

    const response = await sendDiscordMessageWithRetry(
      env.DISCORD_CHANNEL_ID,
      env.BOT_TOKEN,
      payload
    );

    if (!response.ok) {
      failed++;

      results.push({
        id: deal.id,
        title: deal.title,
        ok: false,
        status: response.status,
        discord: response.data
      });

      continue;
    }

    await env.DEALS_KV.put(
      `seen:${deal.id}`,
      JSON.stringify({
        id: deal.id,
        title: deal.title,
        store: deal.store,
        type: deal.type,
        expires: deal.expires,
        sentAt: new Date().toISOString(),
        discordMessageId: response.data?.id || null
      }),
      {
        expirationTtl: 60 * 60 * 24 * 180
      }
    );

    sent++;

    results.push({
      id: deal.id,
      title: deal.title,
      ok: true,
      discordMessageId: response.data?.id || null,
      hasButtons: includeButtons
    });

    if (index < deals.length - 1) {
      await sleep(500);
    }
  }

  return {
    ok: failed === 0,
    sent,
    failed,
    results
  };
}

async function sendDiscordMessageWithRetry(channelId, botToken, payload) {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${botToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    let data = null;

    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (response.ok) {
      return {
        ok: true,
        status: response.status,
        data
      };
    }

    if (response.status !== 429 || attempt === maxAttempts) {
      return {
        ok: false,
        status: response.status,
        data
      };
    }

    const retryAfterSeconds = Number(data?.retry_after) || 1;
    await sleep(Math.ceil(retryAfterSeconds * 1000) + 250);
  }

  return {
    ok: false,
    status: 500,
    data: {
      message: "Discord retry loop ended unexpectedly."
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildDealDiscordMessage(deal, includeButtons = false) {
  const storeName =
    deal.store === "steam"
      ? CONFIG.TEXT.storeSteam
      : CONFIG.TEXT.storeEpic;

  let emoji = "🎮";
  let typeName = "Deal";

  if (deal.type === "free_game") {
    emoji = "🎁";
    typeName = CONFIG.TEXT.typeFreeGame;
  } else if (deal.type === "free_weekend") {
    emoji = "🎮";
    typeName = CONFIG.TEXT.typeFreeWeekend;
  } else if (deal.type === "discount") {
    emoji = "🔥";
    typeName = deal.discount
      ? `${CONFIG.TEXT.typeDiscount} ${deal.discount}%`
      : CONFIG.TEXT.typeDiscount;
  }

  let priceText = null;

  if (deal.type === "free_game" || deal.type === "free_weekend") {
    priceText = CONFIG.TEXT.freePrice;
  } else if (deal.type === "discount") {
    if (deal.price && deal.originalPrice) {
      priceText = `~~${deal.originalPrice}~~ → **${deal.price}**`;
    } else if (deal.price) {
      priceText = `**${deal.price}**`;
    }
  }

  const lines = [
    `**${storeName}**`,
    priceText ? `${CONFIG.TEXT.priceLabel} ${priceText}` : null,
    deal.expires
      ? `${CONFIG.TEXT.expiresLabel} **${formatDateRu(deal.expires)}**`
      : null
  ].filter(Boolean);

  const embed = {
    title: `${emoji} ${deal.title}`,
    url: deal.url,
    description: lines.join("\n"),
    fields: [
      {
        name: CONFIG.TEXT.fieldType,
        value: typeName,
        inline: true
      },
      {
        name: CONFIG.TEXT.fieldStore,
        value: storeName,
        inline: true
      }
    ]
  };

  if (deal.publisher) {
    embed.fields.push({
      name: CONFIG.TEXT.fieldPublisher,
      value: deal.publisher,
      inline: true
    });
  }

  if (deal.genres?.length) {
    embed.fields.push({
      name: CONFIG.TEXT.fieldGenres,
      value: translateGenres(deal.genres).slice(0, 4).join(", "),
      inline: false
    });
  }

  if (deal.image) {
    embed.image = { url: deal.image };
  }

  const payload = {
    content: CONFIG.TEXT.newDealHeader,
    embeds: [embed]
  };

  if (includeButtons) {
    payload.components = buildDealButtons();
  }

  return payload;
}

function buildDealButtons() {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          label: CONFIG.BUTTONS.freeGames.label,
          emoji: { name: CONFIG.BUTTONS.freeGames.emoji },
          custom_id: "free_games"
        },
        {
          type: 2,
          style: 1,
          label: CONFIG.BUTTONS.discounts.label,
          emoji: { name: CONFIG.BUTTONS.discounts.emoji },
          custom_id: "discounts"
        },
        {
          type: 2,
          style: 1,
          label: CONFIG.BUTTONS.steam.label,
          custom_id: "steam"
        }
      ]
    },
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          label: CONFIG.BUTTONS.epic.label,
          custom_id: "epic"
        },
        {
          type: 2,
          style: 1,
          label: CONFIG.BUTTONS.freeWeekend.label,
          emoji: { name: CONFIG.BUTTONS.freeWeekend.emoji },
          custom_id: "free_weekend"
        },
        {
          type: 2,
          style: 1,
          label: CONFIG.BUTTONS.allDeals.label,
          emoji: { name: CONFIG.BUTTONS.allDeals.emoji },
          custom_id: "all_deals"
        }
      ]
    }
  ];
}

function formatDateRu(dateString) {
  const match = String(dateString || "").match(
    /^(\d{4})-(\d{2})-(\d{2})$/
  );

  if (!match) {
    return dateString;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const months = [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря"
  ];

  const monthName = months[month - 1];

  if (!monthName) {
    return dateString;
  }

  const currentYear = new Date().getUTCFullYear();

  return year === currentYear
    ? `${day} ${monthName}`
    : `${day} ${monthName} ${year}`;
}

function translateGenres(genres) {
  const dictionary = {
    "action": "Экшен",
    "adventure": "Приключения",
    "arcade": "Аркада",
    "card & board game": "Карточная / настольная",
    "fighting": "Файтинг",
    "hack and slash/beat 'em up": "Hack and Slash",
    "indie": "Инди",
    "music": "Музыкальная",
    "platform": "Платформер",
    "point-and-click": "Point-and-click",
    "puzzle": "Головоломка",
    "quiz/trivia": "Викторина",
    "racing": "Гонки",
    "real time strategy (rts)": "Стратегия в реальном времени",
    "role-playing (rpg)": "RPG",
    "shooter": "Шутер",
    "simulator": "Симулятор",
    "sport": "Спорт",
    "strategy": "Стратегия",
    "tactical": "Тактика",
    "turn-based strategy (tbs)": "Пошаговая стратегия",
    "visual novel": "Визуальная новелла"
  };

  return (genres || []).map((genre) => {
    const key = String(genre).trim().toLowerCase();
    return dictionary[key] || genre;
  });
}

async function fetchDealsFeed(url, feedType) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "AbandonBot/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(
      `RSS request failed: ${response.status} ${url}`
    );
  }

  const xml = await response.text();

  return parseRSS(xml, feedType);
}


function parseRSS(xml, feedType) {
  const items = [
    ...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)
  ];

  const deals = [];

  for (const match of items) {
    const item = match[1];

    const titleRaw = decodeXmlEntities(
      getTag(item, "title")
    );

    const descriptionRaw =
      getCdataTag(item, "description");

    const link = decodeXmlEntities(
      getTag(item, "link")
    ).trim();

    const guid = decodeXmlEntities(
      getTag(item, "guid")
    ).trim();

    const pubDate = decodeXmlEntities(
      getTag(item, "pubDate")
    ).trim();

    const categories = [
      ...item.matchAll(
        /<category>([\s\S]*?)<\/category>/gi
      )
    ].map((match) =>
      decodeXmlEntities(match[1]).trim()
    );

    const enclosureMatch = item.match(
      /<enclosure[^>]*url="([^"]+)"/i
    );

    const image = enclosureMatch
      ? decodeXmlEntities(enclosureMatch[1])
      : null;


    const sourceRaw =
      extractDescriptionFieldRaw(
        descriptionRaw,
        "Source"
      );

    const priceRaw =
      extractDescriptionFieldRaw(
        descriptionRaw,
        "Price"
      );

    const expiresRaw =
      extractDescriptionFieldRaw(
        descriptionRaw,
        "Expires"
      );

    const publisherRaw =
      extractDescriptionFieldRaw(
        descriptionRaw,
        "Publisher"
      );

    const igdbRaw =
      extractDescriptionFieldRaw(
        descriptionRaw,
        "IGDB Rating"
      );

    const metascoreRaw =
      extractDescriptionFieldRaw(
        descriptionRaw,
        "Metascore"
      );

    const dealScoreRaw =
      extractDescriptionFieldRaw(
        descriptionRaw,
        "Deal Score"
      );

    const genresRaw =
      extractDescriptionFieldRaw(
        descriptionRaw,
        "Genres"
      );


    const source = cleanDescriptionValue(sourceRaw);

    const expires = cleanDescriptionValue(expiresRaw);

    const publisher = cleanDescriptionValue(publisherRaw);

    const igdbRating = cleanDescriptionValue(igdbRaw);

    const metascore = cleanDescriptionValue(metascoreRaw);

    const dealScore = cleanDescriptionValue(dealScoreRaw);

    const genres = cleanDescriptionValue(genresRaw);


    const store = detectStore(
      categories,
      source
    );

    if (!store) {
      continue;
    }

    const type = detectDealType({
      guid,
      feedType,
      store,
      priceRaw,
      titleRaw
    });

    if (!type) {
      continue;
    }

    const title = cleanGameTitle(
      titleRaw
    );

    const discount = extractDiscountPercent(
      titleRaw,
      priceRaw
    );

    const price = extractCurrentPrice(
      priceRaw
    );

    // Read the original price from the raw HTML before stripping tags.
    const originalPrice = extractOriginalPrice(
      priceRaw
    );

    const identity = steamDiscountIdentity({ id: guid, url: link, store, type, expires });

    deals.push({
      id: identity?.id || guid,

      title,

      store,

      type,

      price,

      originalPrice,

      discount,

      expires: identity?.expires || expires || null,

      url: link,

      image,

      publisher: publisher || null,

      genres: genres
        ? genres
            .split(",")
            .map((genre) => genre.trim())
        : [],

      ratings: {
        igdb: igdbRating || null,
        metascore: metascore || null,
        dealScore: dealScore || null
      },

      publishedAt: pubDate || null
    });
  }

  return deals;
}


function detectStore(categories, source) {
  const values = [
    ...categories,
    source
  ]
    .filter(Boolean)
    .map((value) =>
      value.toLowerCase()
    );

  if (
    values.some(
      (value) => value === "steam game"
    )
  ) {
    return "steam";
  }

  if (
    values.some(
      (value) => value === "epic game"
    )
  ) {
    return "epic";
  }

  // Ignore Epic Mobile entries.
  if (
    values.some(
      (value) =>
        value.includes("epic mobile")
    )
  ) {
    return null;
  }

  return null;
}


function detectDealType({
  guid,
  feedType,
  store,
  priceRaw,
  titleRaw
}) {
  const id = String(
    guid || ""
  ).toLowerCase();

  const price = cleanDescriptionValue(
    priceRaw
  ).toUpperCase();

  // Steam Free Weekend / Free Trial.
  if (
    store === "steam" &&
    id.startsWith("steam_fw_")
  ) {
    return "free_weekend";
  }

  // The discounts feed is already filtered to 70%+ by Game Deals.
  if (
    feedType === "discount" ||
    /-\d{1,3}%/.test(titleRaw)
  ) {
    return "discount";
  }

  // Epic free game or a possible Steam free entry.
  if (
    feedType === "free" &&
    price.includes("FREE")
  ) {
    return "free_game";
  }

  return null;
}


function cleanGameTitle(title) {
  let result = decodeXmlEntities(
    title
  ).trim();

  result = result.replace(
    /\s*\[FREE\]\s*$/i,
    ""
  );

  result = result.replace(
    /\s*\(-\d{1,3}%[^)]*\)\s*$/i,
    ""
  );

  return result.trim();
}


function extractDiscountPercent(
  title,
  priceRaw
) {
  const combined =
    `${title} ${priceRaw || ""}`;

  const match = combined.match(
    /\(-?(\d{1,3})%\)/
  );

  if (!match) {
    return null;
  }

  return Number(match[1]);
}


function extractCurrentPrice(priceRaw) {
  if (!priceRaw) {
    return null;
  }

  // Example: €5.99 <s>€29.99</s> (-80%).

  let beforeOldPrice = priceRaw;

  const strikeIndex =
    beforeOldPrice.search(/<s>/i);

  if (strikeIndex !== -1) {
    beforeOldPrice =
      beforeOldPrice.slice(
        0,
        strikeIndex
      );
  }

  const clean = cleanDescriptionValue(
    beforeOldPrice
  );

  if (
    clean.toUpperCase() === "FREE"
  ) {
    return "FREE";
  }

  return clean || null;
}


function extractOriginalPrice(priceRaw) {
  if (!priceRaw) {
    return null;
  }

  const match = priceRaw.match(
    /<s>([\s\S]*?)<\/s>/i
  );

  if (!match) {
    return null;
  }

  return cleanDescriptionValue(
    match[1]
  );
}


function extractDescriptionFieldRaw(
  description,
  fieldName
) {
  if (!description) {
    return null;
  }

  const escaped =
    escapeRegExp(fieldName);

  const regex = new RegExp(
    `<p>\\s*<strong>\\s*${escaped}:?\\s*<\\/strong>([\\s\\S]*?)<\\/p>`,
    "i"
  );

  const match =
    description.match(regex);

  if (!match) {
    return null;
  }

  return match[1].trim();
}


function cleanDescriptionValue(value) {
  if (!value) {
    return "";
  }

  return decodeXmlEntities(
    stripHtml(value)
  ).trim();
}


function getTag(xml, tagName) {
  const regex = new RegExp(
    `<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`,
    "i"
  );

  const match = xml.match(regex);

  return match
    ? match[1].trim()
    : "";
}


function getCdataTag(
  xml,
  tagName
) {
  const regex = new RegExp(
    `<${tagName}(?:\\s[^>]*)?>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tagName}>`,
    "i"
  );

  const match = xml.match(regex);

  if (match) {
    return match[1];
  }

  return getTag(
    xml,
    tagName
  );
}


function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}


function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")

    .replace(
      /&#(\d+);/g,
      (_, number) =>
        String.fromCodePoint(
          Number(number)
        )
    )

    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, hex) =>
        String.fromCodePoint(
          parseInt(hex, 16)
        )
    );
}


function escapeRegExp(value) {
  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}


async function sendTestPanel(env) {
  const response = await fetch(
    `https://discord.com/api/v10/channels/${env.DISCORD_CHANNEL_ID}/messages`,
    {
      method: "POST",

      headers: {
        Authorization:
          `Bot ${env.BOT_TOKEN}`,

        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        content:
          "🎮 **GAME DEALS**",

        components: [
          {
            type: 1,

            components: [
              {
                type: 2,
                style: 1,
                label: "Free Games",

                emoji: {
                  name: "🎁"
                },

                custom_id:
                  "free_games"
              }
            ]
          }
        ]
      })
    }
  );

  const data = await response.json();

  return {
    ok: response.ok,
    status: response.status,
    discord: data
  };
}


async function verifyDiscordRequest(
  body,
  signature,
  timestamp,
  publicKey
) {
  try {
    const key =
      await crypto.subtle.importKey(
        "raw",

        hexToUint8Array(
          publicKey
        ),

        {
          name: "Ed25519"
        },

        false,

        ["verify"]
      );

    return await crypto.subtle.verify(
      "Ed25519",

      key,

      hexToUint8Array(
        signature
      ),

      new TextEncoder().encode(
        timestamp + body
      )
    );

  } catch (error) {
    console.error(
      "Signature verification failed:",
      error
    );

    return false;
  }
}


function hexToUint8Array(hex) {
  return new Uint8Array(
    hex
      .match(/.{1,2}/g)
      .map(
        (byte) =>
          parseInt(byte, 16)
      )
  );
} 
