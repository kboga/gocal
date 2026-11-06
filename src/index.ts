/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
 
 
 // https://github.com/othyn/go-calendar/issues/5#issuecomment-1577070405
 // https://gocal.kristofbogaerts.workers.dev/gocal.ics?timezone=Europe/Brussels&exclude=all_day
 // https://gocal.kristofbogaerts.workers.dev/gocal.ics?timezone=Europe/Brussels&include=all_day
 // https://www.google.com/calendar/render?cid=webcal://gocal.kristofbogaerts.workers.dev/gocal.ics?timezone=Europe/Brussels%26exclude=all_day
 
 /*
Description	URL
Main calendar (defaults to UTC)	https://nit.ai/gocal.ics
Timezone-specific with timezone param	https://nit.ai/gocal.ics?timezone=America/Port-au-Prince
List of valid timezones shows if you type in a wrong one	https://nit.ai/gocal.ics?timezone=foo
Exclude events (blacklist style)	https://nit.ai/gocal.ics?exclude=community_day
Exclude multiple events	https://nit.ai/gocal.ics?exclude=community_day&exclude=elite_raids
List of valid categories shows if you type in a wrong one	https://nit.ai/gocal.ics?exclude=foo
Include events (whitelist style)	https://nit.ai/gocal.ics?include=pokemon_spotlight_hour
Timezone and filter combined	https://nit.ai/gocal.ics?timezone=America/Port-au-Prince&exclude=season&exclude=research
Special category all_day (see notes)	https://nit.ai/gocal.ics?exclude=all_day
Just a few notes:

As I mentioned, this isn't fully tested, so there might be some issues.
'Exclude' and 'include' parameters can't refer to the same category
I added a special category for 'exclude/include' called all_day, which filters all-day events across categories.
 */

/*
 * Leek Duck's events, as scraped by ScrapedDuck. Global events'
 * start/end end with `Z` (UTC); local events have no offset and
 * happen at that wall-clock time in every timezone.
 */
const SCRAPEDDUCK_EVENTS_URL =
  "https://raw.githubusercontent.com/bigfoott/ScrapedDuck/data/events.json";

/*
 * Leek Duck tags some events on their own page only (e.g.
 * "Location-specific"), not in the events list ScrapedDuck
 * scrapes. A cron job reads those tags into KV a few pages at
 * a time, to stay within the Free plan's 50 subrequests.
 */
const EVENT_TAGS_KEY = "event-tags";
const TAG_BATCH_SIZE = 10;
const TAG_RECHECK_MS = 24 * 60 * 60 * 1000;

// Events lasting this long or longer are shown as all-day.
const ALL_DAY_MIN_MS = 2 * 24 * 60 * 60 * 1000;

/*
 * prefix: the title prefix, an acronym of Leek Duck's heading
 * (as go-calendar, which this calendar used to be built from,
 * made them). name: Leek Duck's heading, used in the calendar name.
 */
const categories = {
  bonus_hour: { prefix: "[BH]", name: "Bonus Hour" },
  city_safari: { prefix: "[CS]", name: "City Safari" },
  community_day: { prefix: "[CD]", name: "Community Day" },
  choose_your_path: { prefix: "[CYP]", name: "Choose Your Path" },
  elite_raids: { prefix: "[ER]", name: "Elite Raids" },
  event: { prefix: "[E]", name: "Event" },
  giovanni_special_research: { prefix: "[GSR]", name: "Giovanni Special Research" },
  global_challenge: { prefix: "[GC]", name: "Global Challenge" },
  go_battle_league: { prefix: "[GBL]", name: "GO Battle League" },
  go_pass: { prefix: "[GP]", name: "GO Pass" },
  go_rocket_takeover: { prefix: "[GRT]", name: "GO Rocket Takeover" },
  limited_research: { prefix: "[LR]", name: "Limited Research" },
  live_event: { prefix: "[LE]", name: "Live Event" },
  location_specific: { prefix: "[LS]", name: "Location-specific" },
  max_battles: { prefix: "[MB]", name: "Max Battles" },
  max_mondays: { prefix: "[MM]", name: "Max Mondays" },
  pokemon_go_fest: { prefix: "[PGF]", name: "Pokémon GO Fest" },
  pokemon_go_tour: { prefix: "[PGT]", name: "Pokémon GO Tour" },
  pokemon_spotlight_hour: { prefix: "[PSH]", name: "Pokémon Spotlight Hour" },
  pokestop_showcase: { prefix: "[PS]", name: "PokéStop Showcase" },
  potential_ultra_unlock: { prefix: "[PUU]", name: "Potential Ultra Unlock" },
  raid_battles: { prefix: "[RB]", name: "Raid Battles" },
  raid_day: { prefix: "[RD]", name: "Raid Day" },
  raid_hour: { prefix: "[RH]", name: "Raid Hour" },
  raid_weekend: { prefix: "[RW]", name: "Raid Weekend" },
  research_breakthrough: { prefix: "[RBT]", name: "Research Breakthrough" },
  // Same prefix as raid_day; told apart by ScrapedDuck's eventType.
  research_day: { prefix: "[RD]", name: "Research Day" },
  research: { prefix: "[R]", name: "Research" },
  safari_zone: { prefix: "[SZ]", name: "Safari Zone" },
  season: { prefix: "[S]", name: "Season" },
  special_research: { prefix: "[SR]", name: "Special Research" },
  team_go_rocket: { prefix: "[TGR]", name: "Team GO Rocket" },
  ticketed_event: { prefix: "[TE]", name: "Ticketed Event" },
  ticketed: { prefix: "[T]", name: "Ticketed" },
  timed_research: { prefix: "[TR]", name: "Timed Research" },
  twitch_drops: { prefix: "[TD]", name: "Twitch Drops" },
  update: { prefix: "[U]", name: "Update" },
  wild_area: { prefix: "[WA]", name: "Wild Area" },
  all_day: { prefix: "all_day", name: "All-day" },
} as const;

type Category = keyof typeof categories;

interface EventMetadata {
  category: Category | null;
  // Categories from the event page's tags, e.g. location_specific.
  tagCategories: Category[];
  allDay: boolean;
}

interface StoredEventTags {
  // Leek Duck tag classes, e.g. ["event", "location-specific"].
  tags: string[];
  checkedAt: number;
}

type EventTagStore = Record<string, StoredEventTags>;

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

interface EventTime {
  // As ScrapedDuck writes it, without any timezone applied.
  written: ZonedParts;
  // Global (UTC) rather than local wall-clock time.
  global: boolean;
}

interface LeekDuckEvent {
  // Used as the ICS UID, as go-calendar did, so subscribers
  // see updates rather than duplicates.
  id: string;
  name: string;
  type: string;
  heading: string;
  link: string;
  image: string;
  start: EventTime;
  end: EventTime;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

export default {
  async fetch(request: Request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse("Method not allowed", 405, {
        Allow: "GET, HEAD",
      });
    }

    if (url.pathname !== "/" && url.pathname !== "/gocal.ics") {
      return textResponse("Not found", 404);
    }

    const include = readMultiValueParameter(
      url.searchParams,
      "include",
    );

    const exclude = readMultiValueParameter(
      url.searchParams,
      "exclude",
    );

    /*
     * Both may be combined: keep events matching `include`, then
     * drop those matching `exclude`. The same category in both
     * would always give an empty calendar.
     */
    const overlap = include.filter((category) =>
      exclude.includes(category),
    );

    if (overlap.length > 0) {
      return errorResponse(
        `Categories cannot be both included and excluded: ${overlap.join(", ")}`,
      );
    }

    const invalidCategories = [...include, ...exclude].filter(
      (category) => !isCategory(category),
    );

    if (invalidCategories.length > 0) {
      return errorResponse(
        [
          `Invalid categor${
            invalidCategories.length === 1 ? "y" : "ies"
          }: ${invalidCategories.join(", ")}`,
          "",
          "Valid categories:",
          ...Object.keys(categories).map(
            (category) => `- ${category}`,
          ),
        ].join("\n"),
      );
    }

    const includedCategories = include as Category[];
    const excludedCategories = exclude as Category[];

    let timezone = url.searchParams.get("timezone") ?? "UTC";

    try {
      timezone = canonicalizeTimeZone(timezone);
    } catch {
      return errorResponse(
        [
          `Invalid timezone: ${timezone}`,
          "",
          "Examples:",
          "- UTC",
          "- Europe/Brussels",
          "- America/New_York",
          "- Asia/Tokyo",
          "",
          "Supported timezones:",
          ...getSupportedTimeZones().map(
            (zone) => `- ${zone}`,
          ),
        ].join("\n"),
      );
    }

    const [events, eventTags] = await Promise.all([
      fetchLeekDuckEvents(),
      readEventTags(env),
    ]);

    if (!events) {
      return textResponse(
        "Failed to fetch the Leek Duck events from ScrapedDuck.",
        502,
      );
    }

    const stamp = formatUtcIcsDate(new Date());

    const vevents = events.flatMap((event) => {
      const metadata = getEventMetadata(event, eventTags);

      if (
        includedCategories.length > 0 &&
        !matchesAnyFilter(metadata, includedCategories)
      ) {
        return [];
      }

      if (
        excludedCategories.length > 0 &&
        matchesAnyFilter(metadata, excludedCategories)
      ) {
        return [];
      }

      return renderEvent(event, metadata, timezone, stamp);
    });

    const { name, description } = describeCalendar(
      includedCategories,
      excludedCategories,
      timezone,
    );

    const calendar = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//gocal//Leek Duck events//EN",
      `NAME:${escapeText(name)}`,
      `X-WR-CALNAME:${escapeText(name)}`,
      `DESCRIPTION:${escapeText(description)}`,
      `X-WR-CALDESC:${escapeText(description)}`,
      `X-WR-TIMEZONE:${timezone}`,
      "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
      "X-PUBLISHED-TTL:PT6H",
      ...vevents,
      "END:VCALENDAR",
      "",
    ]
      .map(foldLine)
      // RFC 5545 uses CRLF line endings.
      .join("\r\n");

    const headers = new Headers({
      "Content-Type":
        "text/calendar; charset=utf-8",
      "Content-Disposition":
        'inline; filename="gocal.ics"',
      "Cache-Control":
        "public, max-age=900, s-maxage=900, stale-while-revalidate=3600",
      "X-Gocal-Timezone": timezone,
      "X-Content-Type-Options": "nosniff",
    });

    if (request.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers,
      });
    }

    return new Response(calendar, {
      status: 200,
      headers,
    });
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(refreshEventTags(env));
  },
} satisfies ExportedHandler<Env>;

/**
 * Supports:
 *
 * ?exclude=season&exclude=research
 *
 * and:
 *
 * ?exclude=season,research
 */
function readMultiValueParameter(
  searchParams: URLSearchParams,
  name: string,
): string[] {
  return [
    ...new Set(
      searchParams
        .getAll(name)
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function isCategory(
  value: string,
): value is Category {
  return value in categories;
}

function getEventMetadata(
  event: LeekDuckEvent,
  eventTags: EventTagStore,
): EventMetadata {
  /*
   * Leek Duck's tag classes are its eventType names, so they
   * map onto categories the same way.
   */
  const tagCategories = (eventTags[event.id]?.tags ?? [])
    .map(categoryForEventType)
    .filter((tag): tag is Category => tag !== null);

  /*
   * Measured on the times as written, so an event is all-day
   * (or not) in every timezone alike.
   */
  const allDay =
    wallClockMs(event.end.written) -
      wallClockMs(event.start.written) >=
    ALL_DAY_MIN_MS;

  return {
    category: categoryForEventType(event.type),
    tagCategories,
    allDay,
  };
}

/**
 * Category keys are ScrapedDuck eventTypes in snake_case.
 */
function categoryForEventType(
  eventType: string,
): Category | null {
  const key = eventType.replace(/-/g, "_");

  return isCategory(key) && key !== "all_day"
    ? key
    : null;
}

function matchesAnyFilter(
  metadata: EventMetadata,
  filters: Category[],
): boolean {
  return filters.some((filter) => {
    if (filter === "all_day") {
      return metadata.allDay;
    }

    return (
      metadata.category === filter ||
      metadata.tagCategories.includes(filter)
    );
  });
}

/*
 * The category's prefix plus one for each page tag besides it,
 * e.g. "[E][LS] Patterns of the Wild".
 */
function eventTitle(
  event: LeekDuckEvent,
  { category, tagCategories }: EventMetadata,
): string {
  // Unknown types get an acronym of their heading, like the rest.
  const own = category
    ? categories[category].prefix
    : event.heading
      ? `[${acronym(event.heading)}]`
      : "";

  const extra = [...new Set(tagCategories)]
    .filter((tag) => tag !== category)
    .map((tag) => categories[tag].prefix);

  const prefix = own + extra.join("");

  return prefix ? `${prefix} ${event.name}` : event.name;
}

function acronym(text: string): string {
  return text
    .split(/[^\p{L}]+/u)
    .filter(Boolean)
    .map((word) => word[0])
    .join("");
}

/**
 * The VEVENT lines, unfolded. Global events' times are given in
 * the requested timezone; local events keep their own times.
 */
function renderEvent(
  event: LeekDuckEvent,
  metadata: EventMetadata,
  timezone: string,
  stamp: string,
): string[] {
  const title = eventTitle(event, metadata);

  const start = resolveTime(event.start, timezone);
  const end = resolveTime(event.end, timezone);

  const zone =
    event.start.global && event.end.global
      ? ` (${timezone})`
      : "";

  const description =
    `Starts at ${formatTime(start.local)}, ends at ${formatTime(end.local)}${zone}.` +
    (event.link ? `\n\n${event.link}` : "");

  // All-day ranges end on the day after the last one shown.
  const dates = metadata.allDay
    ? [
        `DTSTART;VALUE=DATE:${formatIcsDate(start.local)}`,
        `DTEND;VALUE=DATE:${nextIcsDate(end.local)}`,
      ]
    : [
        `DTSTART:${formatUtcIcsDate(start.instant)}`,
        `DTEND:${formatUtcIcsDate(end.instant)}`,
      ];

  return [
    "BEGIN:VEVENT",
    `UID:${event.id}`,
    `DTSTAMP:${stamp}`,
    `SUMMARY:${escapeText(title)}`,
    `DESCRIPTION:${escapeText(description)}`,
    ...(event.link ? [`URL:${event.link}`] : []),
    ...(event.image ? [`IMAGE;VALUE=URI:${event.image}`] : []),
    ...dates,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeText(title)}`,
    "TRIGGER:-PT15M",
    "END:VALARM",
    "END:VEVENT",
  ];
}

/**
 * The instant an event time happens in the timezone, and the
 * wall-clock time there.
 */
function resolveTime(
  time: EventTime,
  timezone: string,
): { instant: Date; local: ZonedParts } {
  if (time.global) {
    const instant = new Date(wallClockMs(time.written));

    return {
      instant,
      local: getZonedParts(instant, timezone),
    };
  }

  return {
    instant: wallClockToUtc(time.written, timezone),
    local: time.written,
  };
}

async function readEventTags(
  env: Env,
): Promise<EventTagStore> {
  try {
    return (
      (await env.EVENT_TAGS.get<EventTagStore>(
        EVENT_TAGS_KEY,
        {
          type: "json",
          cacheTtl: 300,
        },
      )) ?? {}
    );
  } catch {
    // Tags are an extra; categories still work without them.
    return {};
  }
}

/**
 * Checks the Leek Duck pages of up to TAG_BATCH_SIZE events that
 * were never checked or not in the last TAG_RECHECK_MS, since
 * tags can be added after an event is announced.
 */
async function refreshEventTags(
  env: Env,
): Promise<void> {
  const events = await fetchLeekDuckEvents();

  // Don't wipe the store because ScrapedDuck is unavailable.
  if (!events || events.length === 0) {
    return;
  }

  const eventIDs = events.map((event) => event.id);

  const stored =
    (await env.EVENT_TAGS.get<EventTagStore>(
      EVENT_TAGS_KEY,
      "json",
    )) ?? {};

  const now = Date.now();
  const store: EventTagStore = {};

  // Drop events ScrapedDuck no longer lists.
  for (const eventID of eventIDs) {
    if (stored[eventID]) {
      store[eventID] = stored[eventID];
    }
  }

  const checkedAt = (eventID: string): number =>
    store[eventID]?.checkedAt ?? 0;

  // Never-checked events first (checkedAt 0), then the oldest.
  const due = eventIDs
    .filter(
      (eventID) =>
        checkedAt(eventID) < now - TAG_RECHECK_MS,
    )
    .sort((a, b) => checkedAt(a) - checkedAt(b))
    .slice(0, TAG_BATCH_SIZE);

  const results = await Promise.all(
    due.map(async (eventID) => ({
      eventID,
      tags: await fetchLeekDuckTags(eventID),
    })),
  );

  for (const { eventID, tags } of results) {
    // On failure keep the old entry, so it is retried next run.
    if (tags) {
      store[eventID] = { tags, checkedAt: now };
    }
  }

  const pruned =
    Object.keys(store).length !==
    Object.keys(stored).length;

  if (pruned || results.some(({ tags }) => tags)) {
    await env.EVENT_TAGS.put(
      EVENT_TAGS_KEY,
      JSON.stringify(store),
    );
  }
}

/**
 * The tag classes of a Leek Duck event page:
 *
 * <div class="page-tags"><div class="tag event">Event</div>
 * <div class="tag location-specific">Location-specific</div></div>
 *
 * Returns null when the page can't be read or has no tags block,
 * e.g. after a Leek Duck redesign.
 */
async function fetchLeekDuckTags(
  eventID: string,
): Promise<string[] | null> {
  try {
    const response = await fetch(
      `https://leekduck.com/events/${encodeURIComponent(eventID)}/`,
      {
        headers: {
          "User-Agent": "GO-Calendar-Cloudflare-Proxy",
        },
      },
    );

    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const start = html.indexOf('class="page-tags"');

    if (start === -1) {
      return null;
    }

    // Only the tags block, not "tag" classes elsewhere on the page.
    const end = html.indexOf("<section", start);

    const block = html.slice(
      start,
      end === -1 ? start + 2000 : end,
    );

    return [
      ...block.matchAll(/class="tag ([a-z0-9-]+)"/g),
    ].map((match) => match[1]);
  } catch {
    return null;
  }
}

/**
 * ScrapedDuck's events, in its order. Events without a start or
 * end (Leek Duck drops them once an event is over) are skipped.
 *
 * Returns null when ScrapedDuck is unavailable.
 */
async function fetchLeekDuckEvents(): Promise<
  LeekDuckEvent[] | null
> {
  let data: unknown;

  try {
    const response = await fetch(SCRAPEDDUCK_EVENTS_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "GO-Calendar-Cloudflare-Proxy",
      },

      cf: {
        cacheEverything: true,
        cacheTtl: 900,
      },
    });

    if (!response.ok) {
      return null;
    }

    data = await response.json();
  } catch {
    return null;
  }

  if (!Array.isArray(data)) {
    return null;
  }

  const events: LeekDuckEvent[] = [];
  const seen = new Set<string>();

  for (const item of data) {
    const {
      eventID,
      name,
      eventType,
      heading,
      link,
      image,
      start,
      end,
    } = item ?? {};

    if (
      typeof eventID !== "string" ||
      typeof name !== "string" ||
      typeof eventType !== "string" ||
      // Duplicate UIDs would clash in calendar apps.
      seen.has(eventID)
    ) {
      continue;
    }

    const startTime = parseEventTime(start);
    const endTime = parseEventTime(end);

    if (!startTime || !endTime) {
      continue;
    }

    seen.add(eventID);

    events.push({
      id: eventID,
      name,
      type: eventType,
      heading: typeof heading === "string" ? heading : "",
      link: typeof link === "string" ? link : "",
      image: typeof image === "string" ? image : "",
      start: startTime,
      end: endTime,
    });
  }

  return events;
}

/**
 * Parses "2026-10-02T10:00:00.000" (local) and
 * "2026-09-15T20:00:00.000Z" (global).
 */
function parseEventTime(
  value: unknown,
): EventTime | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z)?$/,
  );

  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second = "0", utc] =
    match;

  return {
    written: {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second),
    },
    global: utc === "Z",
  };
}

function formatTime(parts: ZonedParts): string {
  const pad = (number: number): string =>
    String(number).padStart(2, "0");

  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

function formatIcsDate(parts: ZonedParts): string {
  const pad = (number: number): string =>
    String(number).padStart(2, "0");

  return `${parts.year}${pad(parts.month)}${pad(parts.day)}`;
}

function nextIcsDate(parts: ZonedParts): string {
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + 1),
  );

  return formatUtcIcsDate(date).slice(0, 8);
}

/**
 * RFC 5545 folding: lines of at most 75 octets, continuation
 * lines start with a single space. Never splits a UTF-8 sequence.
 */
function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const lines: string[] = [];

  let current = "";
  let size = 0;
  let limit = 75;

  for (const char of line) {
    const charSize = encoder.encode(char).length;

    if (size + charSize > limit) {
      lines.push(current);
      current = "";
      size = 0;
      // The leading space counts towards the 75 octets.
      limit = 74;
    }

    current += char;
    size += charSize;
  }

  lines.push(current);

  return lines.join("\r\n ");
}

/**
 * The wall-clock components read as if they were UTC.
 */
function wallClockMs(parts: ZonedParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

/**
 * The instant a wall-clock time happens in a timezone.
 */
function wallClockToUtc(
  parts: ZonedParts,
  timezone: string,
): Date {
  /*
   * First interpret the wall-clock components as UTC.
   *
   * We then calculate the timezone offset and subtract it
   * to obtain the actual UTC instant.
   */
  const wallClockUtc = wallClockMs(parts);

  let offset = getTimeZoneOffset(
    new Date(wallClockUtc),
    timezone,
  );

  let result = wallClockUtc - offset;

  /*
   * Recalculate once using the resulting instant.
   *
   * This matters around DST transitions where the first
   * approximation may land on the opposite side of the
   * timezone transition.
   */
  const correctedOffset = getTimeZoneOffset(
    new Date(result),
    timezone,
  );

  if (correctedOffset !== offset) {
    offset = correctedOffset;
    result = wallClockUtc - offset;
  }

  return new Date(result);
}

function getTimeZoneOffset(
  date: Date,
  timezone: string,
): number {
  return (
    wallClockMs(getZonedParts(date, timezone)) -
    date.getTime()
  );
}

/**
 * The wall-clock components of an instant in a timezone.
 */
function getZonedParts(
  date: Date,
  timezone: string,
): ZonedParts {
  const formatter =
    getTimeZoneFormatter(timezone);

  const parts: Record<string, string> = {};

  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function getTimeZoneFormatter(
  timezone: string,
): Intl.DateTimeFormat {
  const cached =
    formatterCache.get(timezone);

  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat(
    "en-US-u-ca-gregory-nu-latn",
    {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    },
  );

  formatterCache.set(timezone, formatter);

  return formatter;
}

function formatUtcIcsDate(
  date: Date,
): string {
  const pad = (number: number): string =>
    String(number).padStart(2, "0");

  return (
    `${date.getUTCFullYear()}` +
    `${pad(date.getUTCMonth() + 1)}` +
    `${pad(date.getUTCDate())}` +
    "T" +
    `${pad(date.getUTCHours())}` +
    `${pad(date.getUTCMinutes())}` +
    `${pad(date.getUTCSeconds())}` +
    "Z"
  );
}

function canonicalizeTimeZone(
  timezone: string,
): string {
  if (timezone.toUpperCase() === "UTC") {
    return "UTC";
  }

  /*
   * Intl.DateTimeFormat throws RangeError when the timezone
   * is invalid.
   */
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
  }).resolvedOptions().timeZone;
}

function getSupportedTimeZones(): string[] {
  /*
   * TypeScript's Intl typings can lag behind the runtime,
   * so describe supportedValuesOf explicitly.
   */
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (
      key: "timeZone",
    ) => string[];
  };

  if (intl.supportedValuesOf) {
    return [
      "UTC",
      ...intl.supportedValuesOf("timeZone"),
    ];
  }

  return [
    "UTC",
    "Europe/Brussels",
  ];
}

/**
 * A calendar name and description that describe the filters,
 * e.g. "GO - Ex: Season, Research".
 */
function describeCalendar(
  include: Category[],
  exclude: Category[],
  timezone: string,
): { name: string; description: string } {
  const names = (list: Category[]): string[] =>
    list.map((category) => categories[category].name);

  // "A, B and C", so the list's end is clear mid-sentence.
  const sentenceList = (list: Category[]): string => {
    const all = names(list);
    const last = all.pop();

    return all.length > 0
      ? `${all.join(", ")} and ${last}`
      : last ?? "";
  };

  let selection = "Everything";
  let summary = "All Pokémon GO events";

  if (include.length > 0) {
    selection = `In: ${names(include).join(", ")}`;
    summary = `Only Pokémon GO events of types: ${sentenceList(include)}`;
  }

  if (exclude.length > 0) {
    // " | " rather than a comma, so the two lists stay apart.
    selection =
      include.length > 0
        ? `${selection} | Ex: ${names(exclude).join(", ")}`
        : `Ex: ${names(exclude).join(", ")}`;

    summary =
      include.length > 0
        ? `${summary}, but not ${sentenceList(exclude)}`
        : `All Pokémon GO events except types: ${sentenceList(exclude)}`;
  }

  return {
    name: `GO - ${capitalize(selection)}`,
    description:
      `${summary}, auto-updated and sourced from Leek Duck. ` +
      `Local-time events are set for ${timezone}.`,
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * RFC 5545 TEXT escaping.
 */
function escapeText(text: string): string {
  return text
    .replace(/[\\;,]/g, (character) => `\\${character}`)
    .replace(/\r?\n/g, "\\n");
}

function errorResponse(
  message: string,
): Response {
  return textResponse(message, 400);
}

function textResponse(
  body: string,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type":
        "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}
