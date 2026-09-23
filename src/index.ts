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
'Exclude' and 'include' parameters can't be used together (not sure about the logic if both are used).
I added a special category for 'exclude/include' called all_day, which filters all-day events across categories.
 */
 
 const UPSTREAM_URL =
  "https://github.com/othyn/go-calendar/releases/latest/download/gocal.ics";

/*
 * The Leek Duck data go-calendar is generated from. Its `eventID`
 * equals the ICS UID, and its start/end end with `Z` for global
 * (UTC) events, which the ICS itself does not preserve.
 */
const SCRAPEDDUCK_EVENTS_URL =
  "https://raw.githubusercontent.com/bigfoott/ScrapedDuck/data/events.json";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const categories = {
  community_day: "[CD]",
  choose_your_path: "[CYP]",
  elite_raids: "[ER]",
  event: "[E]",
  go_battle_league: "[GBL]",
  go_pass: "[GP]",
  limited_research: "[LR]",
  max_battles: "[MB]",
  max_monday: "[MM]",
  pokemon_go_tour: "[PGT]",
  pokemon_spotlight_hour: "[PSH]",
  raid_battles: "[RB]",
  raid_day: "[RD]",
  raid_hour: "[RH]",
  research_breakthrough: "[RBT]",
  research: "[R]",
  season: "[S]",
  team_go_rocket: "[TGR]",
  timed_research: "[TR]",
  update: "[U]",
  wild_area: "[WA]",
  all_day: "all_day",
} as const;

type Category = keyof typeof categories;

interface EventMetadata {
  category: Category | null;
  allDay: boolean;
}

interface GlobalEventTimes {
  start: Date;
  end: Date;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
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

    if (include.length > 0 && exclude.length > 0) {
      return errorResponse(
        "`include` and `exclude` cannot be used together.",
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

    // Fetched in parallel; resolves to an empty map on failure.
    const globalTimesPromise = fetchGlobalEventTimes();

    let upstream: Response;

    try {
      upstream = await fetch(UPSTREAM_URL, {
        headers: {
          Accept: "text/calendar",
          "User-Agent": "GO-Calendar-Cloudflare-Proxy",
        },
        redirect: "follow",

        cf: {
          cacheEverything: true,
          cacheTtl: 900,
        },
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      return textResponse(
        `Failed to fetch GO Calendar: ${message}`,
        502,
      );
    }

    if (!upstream.ok) {
      return textResponse(
        `GO Calendar returned HTTP ${upstream.status}.`,
        502,
      );
    }

    let calendar = await upstream.text();

    // Work internally with LF.
    calendar = calendar.replace(/\r\n/g, "\n");

    if (
      includedCategories.length > 0 ||
      excludedCategories.length > 0
    ) {
      calendar = filterEvents(
        calendar,
        includedCategories,
        excludedCategories,
      );
    }

    /*
     * go-calendar turns multi-day global events into all-day
     * events and only keeps their UTC times in the description,
     * e.g. "Starts at 20:00, ends at 20:00.". Rewrite those
     * times into the requested timezone.
     */
    calendar = localizeGlobalEventDescriptions(
      calendar,
      timezone,
      await globalTimesPromise,
    );

    /*
     * Convert floating local DATE-TIME values into UTC.
     *
     * Example for Europe/Brussels:
     *
     * DTSTART:20260912T140000
     *
     * becomes:
     *
     * DTSTART:20260912T120000Z
     *
     * Google Calendar can then interpret the event as an absolute
     * instant without having to understand floating date-times.
     */
    calendar = convertFloatingTimesToUtc(
      calendar,
      timezone,
    );

    calendar = setCalendarTimezone(
      calendar,
      timezone,
    );

    // RFC 5545 uses CRLF line endings.
    calendar = calendar.replace(/\n/g, "\r\n");

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

function filterEvents(
  calendar: string,
  include: Category[],
  exclude: Category[],
): string {
  return calendar.replace(
    /BEGIN:VEVENT\n[\s\S]*?\nEND:VEVENT/g,
    (event) => {
      const metadata = getEventMetadata(event);

      if (include.length > 0) {
        return matchesAnyFilter(metadata, include)
          ? event
          : "";
      }

      if (exclude.length > 0) {
        return matchesAnyFilter(metadata, exclude)
          ? ""
          : event;
      }

      return event;
    },
  );
}

function getEventMetadata(
  event: string,
): EventMetadata {
  /*
   * Unfold iCalendar continuation lines for inspection only.
   * The original event string itself remains unchanged.
   */
  const unfolded = event.replace(/\n[ \t]/g, "");

  const summaryMatch = unfolded.match(
    /^SUMMARY(?:;[^:]*)?:(.*)$/m,
  );

  const summary = summaryMatch?.[1] ?? "";

  let category: Category | null = null;

  for (const [name, prefix] of Object.entries(
    categories,
  ) as Array<[Category, string]>) {
    if (name === "all_day") {
      continue;
    }

    if (summary.startsWith(prefix)) {
      category = name;
      break;
    }
  }

  /*
   * An all-day DTSTART contains only YYYYMMDD,
   * possibly together with VALUE=DATE.
   */
  const allDay =
    /^DTSTART(?:;[^:]*)?:\d{8}$/m.test(
      unfolded,
    );

  return {
    category,
    allDay,
  };
}

function matchesAnyFilter(
  metadata: EventMetadata,
  filters: Category[],
): boolean {
  return filters.some((filter) => {
    if (filter === "all_day") {
      return metadata.allDay;
    }

    return metadata.category === filter;
  });
}

/**
 * Maps ScrapedDuck eventID -> UTC start/end, for global events only.
 *
 * Never throws: if ScrapedDuck is unavailable the calendar is
 * served with its original descriptions.
 */
async function fetchGlobalEventTimes(): Promise<
  Map<string, GlobalEventTimes>
> {
  const times = new Map<string, GlobalEventTimes>();

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
      return times;
    }

    const events: unknown = await response.json();

    if (!Array.isArray(events)) {
      return times;
    }

    for (const event of events) {
      const { eventID, start, end } = event ?? {};

      if (
        typeof eventID !== "string" ||
        !isUtcTimestamp(start) ||
        !isUtcTimestamp(end)
      ) {
        continue;
      }

      times.set(eventID, {
        start: new Date(start),
        end: new Date(end),
      });
    }
  } catch {
    // Fall through with whatever was collected.
  }

  return times;
}

function isUtcTimestamp(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value.endsWith("Z") &&
    !Number.isNaN(Date.parse(value))
  );
}

function localizeGlobalEventDescriptions(
  calendar: string,
  timezone: string,
  globalTimes: Map<string, GlobalEventTimes>,
): string {
  if (globalTimes.size === 0) {
    return calendar;
  }

  return calendar.replace(
    /BEGIN:VEVENT\n[\s\S]*?\nEND:VEVENT/g,
    (event) =>
      localizeEventDescription(
        event,
        timezone,
        globalTimes,
      ),
  );
}

function localizeEventDescription(
  event: string,
  timezone: string,
  globalTimes: Map<string, GlobalEventTimes>,
): string {
  const unfolded = event.replace(/\n[ \t]/g, "");

  const uid = unfolded.match(/^UID:(.*)$/m)?.[1];
  const times = uid ? globalTimes.get(uid) : undefined;

  if (!times) {
    return event;
  }

  // Timed events already carry exact times; only all-day ones lose them.
  const startDate = unfolded.match(
    /^DTSTART;VALUE=DATE:(\d{8})$/m,
  )?.[1];

  const endDate = unfolded.match(
    /^DTEND;VALUE=DATE:(\d{8})$/m,
  )?.[1];

  if (!startDate || !endDate) {
    return event;
  }

  /*
   * Only look before the VALARM, whose DESCRIPTION is the summary.
   * The property may be folded over several lines.
   */
  const alarmPosition = event.indexOf("\nBEGIN:VALARM");

  const eventProperties =
    alarmPosition === -1
      ? event
      : event.slice(0, alarmPosition);

  const descriptionLine = eventProperties.match(
    /^DESCRIPTION(?:;[^:]*)?:.*(?:\n[ \t].*)*/m,
  )?.[0];

  if (!descriptionLine) {
    return event;
  }

  const description = descriptionLine
    .replace(/\n[ \t]/g, "")
    .match(
      /^(DESCRIPTION(?:;[^:]*)?:)Starts at (\d{2}:\d{2})\\, ends at (\d{2}:\d{2})\.(.*)$/,
    );

  if (!description) {
    return event;
  }

  const [, property, describedStart, describedEnd, rest] =
    description;

  /*
   * Only rewrite when the text really holds the UTC times, so
   * this becomes a no-op if go-calendar ever fixes it upstream.
   */
  if (
    describedStart !== formatUtcTime(times.start) ||
    describedEnd !== formatUtcTime(times.end)
  ) {
    return event;
  }

  const start = getZonedParts(times.start, timezone);
  const end = getZonedParts(times.end, timezone);

  /*
   * The all-day range is exclusive, so the last day shown is
   * the day before DTEND. When the local times fall on other
   * days than the ones shown, spell out the dates too.
   */
  const datesMatch =
    formatIcsDate(start) === startDate &&
    formatIcsDate(end) === previousIcsDate(endDate);

  const text = datesMatch
    ? `Starts at ${formatTime(start)}\\, ends at ${formatTime(end)} (${timezone}).`
    : `Starts ${formatDayMonth(start)} at ${formatTime(start)}\\, ends ${formatDayMonth(end)} at ${formatTime(end)} (${timezone}).`;

  return event.replace(
    descriptionLine,
    foldLine(`${property}${text}${rest}`),
  );
}

function formatUtcTime(date: Date): string {
  const pad = (number: number): string =>
    String(number).padStart(2, "0");

  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function formatTime(parts: ZonedParts): string {
  const pad = (number: number): string =>
    String(number).padStart(2, "0");

  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

function formatDayMonth(parts: ZonedParts): string {
  return `${parts.day} ${MONTH_NAMES[parts.month - 1]}`;
}

function formatIcsDate(parts: ZonedParts): string {
  const pad = (number: number): string =>
    String(number).padStart(2, "0");

  return `${parts.year}${pad(parts.month)}${pad(parts.day)}`;
}

function previousIcsDate(value: string): string {
  const date = new Date(
    Date.UTC(
      Number(value.slice(0, 4)),
      Number(value.slice(4, 6)) - 1,
      Number(value.slice(6, 8)) - 1,
    ),
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

  return lines.join("\n ");
}

function convertFloatingTimesToUtc(
  calendar: string,
  timezone: string,
): string {
  /*
   * Only properties that can contain event/recurrence
   * date-times are transformed.
   *
   * DTSTAMP, CREATED and LAST-MODIFIED are intentionally
   * untouched because they normally already represent
   * absolute UTC instants.
   */
  const properties =
    /^(DTSTART|DTEND|RECURRENCE-ID|EXDATE|RDATE)(;[^:]*)?:(.+)$/gm;

  return calendar.replace(
    properties,
    (
      line: string,
      property: string,
      parameters: string = "",
      rawValue: string,
    ): string => {
      // Already has an explicit timezone.
      if (/;TZID=/i.test(parameters)) {
        return line;
      }

      // All-day DATE value.
      if (/;VALUE=DATE(?:;|$)/i.test(parameters)) {
        return line;
      }

      const values = rawValue.split(",");

      let changed = false;

      const converted = values.map((value) => {
        // Already UTC.
        if (/^\d{8}T\d{6}Z$/.test(value)) {
          return value;
        }

        // Floating DATE-TIME.
        if (/^\d{8}T\d{6}$/.test(value)) {
          changed = true;

          return floatingTimeToUtc(
            value,
            timezone,
          );
        }

        return value;
      });

      if (!changed) {
        return line;
      }

      return `${property}${parameters}:${converted.join(
        ",",
      )}`;
    },
  );
}

function floatingTimeToUtc(
  value: string,
  timezone: string,
): string {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));

  const hour = Number(value.slice(9, 11));
  const minute = Number(value.slice(11, 13));
  const second = Number(value.slice(13, 15));

  /*
   * First interpret the wall-clock components as UTC.
   *
   * We then calculate the timezone offset and subtract it
   * to obtain the actual UTC instant.
   */
  const wallClockUtc = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
  );

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

  return formatUtcIcsDate(
    new Date(result),
  );
}

function getTimeZoneOffset(
  date: Date,
  timezone: string,
): number {
  const parts = getZonedParts(date, timezone);

  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return representedAsUtc - date.getTime();
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

function setCalendarTimezone(
  calendar: string,
  timezone: string,
): string {
  if (/^X-WR-TIMEZONE:/m.test(calendar)) {
    return calendar.replace(
      /^X-WR-TIMEZONE:.*$/m,
      `X-WR-TIMEZONE:${timezone}`,
    );
  }

  const eventPosition =
    calendar.indexOf("BEGIN:VEVENT");

  if (eventPosition === -1) {
    return calendar;
  }

  return (
    calendar.slice(0, eventPosition) +
    `X-WR-TIMEZONE:${timezone}\n` +
    calendar.slice(eventPosition)
  );
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