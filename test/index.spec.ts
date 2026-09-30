import {
	createExecutionContext,
	createScheduledController,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

/*
 * Fixtures: a small go-calendar feed, the matching ScrapedDuck data
 * and Leek Duck event pages. All outbound fetches are mocked, so the
 * tests never touch the network.
 */

// Naive RFC 5545 folding; fixtures are ASCII only.
function fold(line: string): string {
	const parts = [line.slice(0, 75)];

	for (let i = 75; i < line.length; i += 74) {
		parts.push(` ${line.slice(i, i + 74)}`);
	}

	return parts.join("\r\n");
}

interface FixtureEvent {
	uid: string;
	summary: string;
	description: string;
	start: string;
	end: string;
}

function vevent(event: FixtureEvent): string {
	const date = (property: string, value: string): string =>
		/^\d{8}$/.test(value)
			? `${property};VALUE=DATE:${value}`
			: `${property}:${value}`;

	return [
		"BEGIN:VEVENT",
		`UID:${event.uid}`,
		"DTSTAMP:20260930T040000Z",
		fold(`SUMMARY:${event.summary}`),
		fold(`DESCRIPTION:${event.description}`),
		date("DTSTART", event.start),
		date("DTEND", event.end),
		"BEGIN:VALARM",
		"ACTION:DISPLAY",
		fold(`DESCRIPTION:${event.summary}`),
		"TRIGGER:-PT15M",
		"END:VALARM",
		"END:VEVENT",
	].join("\r\n");
}

const EVENTS: FixtureEvent[] = [
	{
		// Global, multi-day: all-day, with UTC times in the text.
		uid: "gbl-week",
		summary: "[GBL] Great League",
		description: "Starts at 20:00\\, ends at 20:00.\\n\\nhttps://leekduck.com/events/gbl-week/",
		start: "20260915",
		end: "20260923",
	},
	{
		uid: "patterns-of-the-wild-2026",
		summary: "[E] Patterns of the Wild",
		description: "Starts at 10:00\\, ends at 20:00.",
		start: "20261002T100000",
		end: "20261002T200000",
	},
	{
		uid: "harvest-festival",
		summary: "[E] Harvest Festival",
		description: "Starts at 10:00\\, ends at 20:00.",
		start: "20261005T100000",
		end: "20261005T200000",
	},
	{
		// Local, multi-day: all-day, with local times in the text.
		uid: "season-24",
		summary: "[S] Twilight Trails",
		description: "Starts at 10:00\\, ends at 10:00.",
		start: "20260908",
		end: "20261202",
	},
	{
		// After the EU clock change on 25 Oct (UTC+1).
		uid: "research-day-1",
		summary: "[RD] Research Day",
		description: "Starts at 14:00\\, ends at 17:00.",
		start: "20261103T140000",
		end: "20261103T170000",
	},
	{
		uid: "raid-day-1",
		summary: "[RD] Super Mega Raid Day",
		description: "Starts at 14:00\\, ends at 17:00.",
		start: "20261010T140000",
		end: "20261010T170000",
	},
	{
		uid: "max-monday-1",
		summary: "[MM] Dynamax Sobble during Max Monday",
		description: "Starts at 18:00\\, ends at 19:00.",
		start: "20261005T180000",
		end: "20261005T190000",
	},
	{
		// Not in ScrapedDuck: only the prefix can categorize it.
		uid: "old-community-day",
		summary: "[CD] Old Community Day",
		description: "Starts at 14:00\\, ends at 17:00.",
		start: "20260801T140000",
		end: "20260801T170000",
	},
];

const UPSTREAM_ICS = [
	"BEGIN:VCALENDAR",
	"VERSION:2.0",
	"PRODID:spatie/icalendar-generator",
	"NAME:GO Calendar - Everything",
	"X-WR-CALNAME:GO Calendar - Everything",
	fold("DESCRIPTION:All Pokémon GO events\\, in your local time\\, auto-updated and sourced from Leek Duck."),
	fold("X-WR-CALDESC:All Pokémon GO events\\, in your local time\\, auto-updated and sourced from Leek Duck."),
	"REFRESH-INTERVAL;VALUE=DURATION:PT1440M",
	...EVENTS.map(vevent),
	"END:VCALENDAR",
	"",
].join("\r\n");

const SCRAPEDDUCK_EVENTS = [
	["gbl-week", "go-battle-league", "2026-09-15T20:00:00.000Z", "2026-09-22T20:00:00.000Z"],
	["patterns-of-the-wild-2026", "event", "2026-10-02T10:00:00.000", "2026-10-02T20:00:00.000"],
	["harvest-festival", "event", "2026-10-05T10:00:00.000", "2026-10-05T20:00:00.000"],
	["season-24", "season", "2026-09-08T10:00:00.000", "2026-12-01T10:00:00.000"],
	["research-day-1", "research-day", "2026-11-03T14:00:00.000", "2026-11-03T17:00:00.000"],
	["raid-day-1", "raid-day", "2026-10-10T14:00:00.000", "2026-10-10T17:00:00.000"],
	["max-monday-1", "max-mondays", "2026-10-05T18:00:00.000", "2026-10-05T19:00:00.000"],
].map(([eventID, eventType, start, end]) => ({
	eventID,
	name: eventID,
	eventType,
	heading: eventType,
	link: `https://leekduck.com/events/${eventID}/`,
	start,
	end,
}));

const PAGE_TAGS: Record<string, string[]> = {
	"gbl-week": ["go-battle-league"],
	"patterns-of-the-wild-2026": ["event", "location-specific"],
	"harvest-festival": ["event", "team-go-rocket"],
	"season-24": ["season"],
	"research-day-1": ["research-day"],
	"raid-day-1": ["raid-day"],
	"max-monday-1": ["max-mondays"],
};

function leekDuckPage(tags: string[]): string {
	return [
		"<html><body><h1>Event</h1>",
		'<div class="page-tags">',
		...tags.map((tag) => `<div class="tag ${tag}">${tag}</div>`),
		"</div>",
		'<section class="event-schedule"></section>',
		// Outside the tags block, so it must be ignored.
		'<div class="tag raid-hour">Unrelated</div>',
		"</body></html>",
	].join("");
}

// Per-test knobs for the mocked outside world.
let upstreamStatus: number;
let scrapedDuckStatus: number;
let leekDuckRequests: string[];

beforeEach(async () => {
	upstreamStatus = 200;
	scrapedDuckStatus = 200;
	leekDuckRequests = [];

	// KV storage is shared between tests in one file.
	await env.EVENT_TAGS.delete("event-tags");

	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url =
			input instanceof Request ? input.url : String(input);

		if (url.includes("go-calendar/releases")) {
			return new Response(UPSTREAM_ICS, { status: upstreamStatus });
		}

		if (url.includes("ScrapedDuck")) {
			return new Response(JSON.stringify(SCRAPEDDUCK_EVENTS), {
				status: scrapedDuckStatus,
			});
		}

		const page = url.match(/^https:\/\/leekduck\.com\/events\/([^/]+)\/$/);

		if (page) {
			leekDuckRequests.push(page[1]);
			const tags = PAGE_TAGS[page[1]];

			return tags
				? new Response(leekDuckPage(tags))
				: new Response("Not found", { status: 404 });
		}

		throw new Error(`Unexpected fetch: ${url}`);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function get(
	query = "",
	options: { path?: string; method?: string } = {},
): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		new IncomingRequest(
			`https://gocal.test${options.path ?? "/gocal.ics"}${query}`,
			{ method: options.method ?? "GET" },
		),
		env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return response;
}

async function calendar(query = ""): Promise<string> {
	const response = await get(query);
	expect(response.status).toBe(200);
	return response.text();
}

async function runScheduled(): Promise<void> {
	const ctx = createExecutionContext();
	await worker.scheduled(
		createScheduledController({ cron: "*/30 * * * *" }),
		env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
}

const unfold = (ics: string): string => ics.replace(/\r\n[ \t]/g, "");

const uids = (ics: string): string[] =>
	[...unfold(ics).matchAll(/^UID:(.*)$/gm)].map((match) =>
		match[1].trim(),
	);

function eventBlock(ics: string, uid: string): string {
	const block = unfold(ics)
		.split("BEGIN:VEVENT")
		.find((part) => part.includes(`UID:${uid}\r\n`));

	if (!block) {
		throw new Error(`No event ${uid}`);
	}

	return block;
}

function header(ics: string, property: string): string | undefined {
	const head = unfold(ics).split("BEGIN:VEVENT")[0];
	return head.match(new RegExp(`^${property}:(.*)$`, "m"))?.[1].trim();
}

describe("responses", () => {
	it("serves the calendar as RFC 5545 text", async () => {
		const response = await get();
		const ics = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe(
			"text/calendar; charset=utf-8",
		);
		expect(uids(ics)).toHaveLength(EVENTS.length);
		// CRLF only, lines of at most 75 octets.
		expect(ics.replace(/\r\n/g, "")).not.toMatch(/\n/);

		for (const line of ics.split("\r\n")) {
			expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
		}
	});

	it("serves / too, HEAD without a body, 404 and 405 otherwise", async () => {
		expect((await get("", { path: "/" })).status).toBe(200);

		const head = await get("", { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");

		expect((await get("", { path: "/nope" })).status).toBe(404);
		expect((await get("", { method: "POST" })).status).toBe(405);
	});

	it("returns 502 when go-calendar is unavailable", async () => {
		upstreamStatus = 500;
		expect((await get()).status).toBe(502);
	});
});

describe("validation", () => {
	it("rejects unknown categories and lists the valid ones", async () => {
		const response = await get("?exclude=foo");
		const body = await response.text();

		expect(response.status).toBe(400);
		expect(body).toContain("Invalid category: foo");
		expect(body).toContain("- max_mondays");
	});

	it("rejects the old max_monday key", async () => {
		expect((await get("?include=max_monday")).status).toBe(400);
	});

	it("rejects unknown timezones", async () => {
		const response = await get("?timezone=Mars/Base");

		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Invalid timezone: Mars/Base");
	});

	it("rejects a category that is both included and excluded", async () => {
		const response = await get("?include=all_day&exclude=all_day");

		expect(response.status).toBe(400);
		expect(await response.text()).toBe(
			"Categories cannot be both included and excluded: all_day",
		);
	});
});

describe("timezones", () => {
	it("converts floating times to UTC, across the clock change", async () => {
		const ics = await calendar("?timezone=Europe/Brussels");

		// 2 Oct: UTC+2.
		expect(eventBlock(ics, "patterns-of-the-wild-2026")).toContain(
			"DTSTART:20261002T080000Z",
		);
		// 3 Nov: UTC+1.
		expect(eventBlock(ics, "research-day-1")).toContain(
			"DTSTART:20261103T130000Z",
		);
		expect(header(ics, "X-WR-TIMEZONE")).toBe("Europe/Brussels");
	});

	it("treats floating times as UTC by default", async () => {
		const ics = await calendar();

		expect(eventBlock(ics, "patterns-of-the-wild-2026")).toContain(
			"DTSTART:20261002T100000Z",
		);
		expect(header(ics, "X-WR-TIMEZONE")).toBe("UTC");
	});

	it("rewrites UTC times in global all-day descriptions", async () => {
		const ics = await calendar("?timezone=Europe/Brussels");

		expect(eventBlock(ics, "gbl-week")).toContain(
			"DESCRIPTION:Starts at 22:00\\, ends at 22:00 (Europe/Brussels).\\n\\nhttps://leekduck.com/events/gbl-week/",
		);
		// Local times are already right.
		expect(eventBlock(ics, "season-24")).toContain(
			"DESCRIPTION:Starts at 10:00\\, ends at 10:00.",
		);
	});

	it("spells out dates when the local days differ from the all-day range", async () => {
		const ics = await calendar("?timezone=Asia/Tokyo");

		expect(eventBlock(ics, "gbl-week")).toContain(
			"DESCRIPTION:Starts 16 Sep at 05:00\\, ends 23 Sep at 05:00 (Asia/Tokyo).",
		);
	});

	it("keeps descriptions unchanged when ScrapedDuck is unavailable", async () => {
		scrapedDuckStatus = 500;
		const ics = await calendar("?timezone=Europe/Brussels");

		expect(eventBlock(ics, "gbl-week")).toContain(
			"DESCRIPTION:Starts at 20:00\\, ends at 20:00.",
		);
	});
});

describe("categories", () => {
	it("uses ScrapedDuck's eventType, so [RD] is told apart", async () => {
		expect(uids(await calendar("?include=research_day"))).toEqual([
			"research-day-1",
		]);
		expect(uids(await calendar("?include=raid_day"))).toEqual([
			"raid-day-1",
		]);
		expect(uids(await calendar("?include=max_mondays"))).toEqual([
			"max-monday-1",
		]);
	});

	it("falls back to the prefix for events ScrapedDuck doesn't list", async () => {
		expect(uids(await calendar("?include=community_day"))).toEqual([
			"old-community-day",
		]);
	});

	it("falls back to prefixes when ScrapedDuck is unavailable", async () => {
		scrapedDuckStatus = 500;

		// [RD] can only mean raid_day then.
		expect(uids(await calendar("?include=raid_day"))).toEqual([
			"research-day-1",
			"raid-day-1",
		]);
	});

	it("filters all-day events", async () => {
		expect(uids(await calendar("?include=all_day"))).toEqual([
			"gbl-week",
			"season-24",
		]);
		expect(uids(await calendar("?exclude=all_day"))).toHaveLength(
			EVENTS.length - 2,
		);
	});

	it("accepts repeated and comma-separated values alike", async () => {
		expect(uids(await calendar("?exclude=season,event"))).toEqual(
			uids(await calendar("?exclude=season&exclude=event")),
		);
	});

	it("combines include and exclude", async () => {
		await runScheduled();

		expect(
			uids(await calendar("?include=event&exclude=location_specific")),
		).toEqual(["harvest-festival"]);
	});
});

describe("Leek Duck page tags", () => {
	it("stores page tags from the scheduled job", async () => {
		await runScheduled();

		// Every ScrapedDuck event once; not the one it doesn't list.
		expect(leekDuckRequests.sort()).toEqual(Object.keys(PAGE_TAGS).sort());

		const stored = await env.EVENT_TAGS.get<
			Record<string, { tags: string[] }>
		>("event-tags", "json");

		// Only the page-tags block, not the unrelated tag below it.
		expect(stored?.["patterns-of-the-wild-2026"].tags).toEqual([
			"event",
			"location-specific",
		]);
	});

	it("doesn't recheck pages within a day", async () => {
		await runScheduled();
		leekDuckRequests = [];
		await runScheduled();

		expect(leekDuckRequests).toEqual([]);
	});

	it("keeps the stored tags when ScrapedDuck is unavailable", async () => {
		await runScheduled();
		scrapedDuckStatus = 500;
		await runScheduled();

		const stored = await env.EVENT_TAGS.get<Record<string, unknown>>(
			"event-tags",
			"json",
		);
		expect(Object.keys(stored ?? {})).toHaveLength(
			Object.keys(PAGE_TAGS).length,
		);
	});

	it("matches filters on page tags", async () => {
		expect(uids(await calendar("?include=location_specific"))).toEqual([]);

		await runScheduled();

		expect(uids(await calendar("?include=location_specific"))).toEqual([
			"patterns-of-the-wild-2026",
		]);
		expect(uids(await calendar("?include=team_go_rocket"))).toEqual([
			"harvest-festival",
		]);
		// Still in its own category too.
		expect(uids(await calendar("?include=event"))).toEqual([
			"patterns-of-the-wild-2026",
			"harvest-festival",
		]);
	});

	it("adds tag prefixes to the title and the alarm", async () => {
		await runScheduled();
		const block = eventBlock(await calendar(), "patterns-of-the-wild-2026");

		expect(block).toContain("SUMMARY:[E][LS] Patterns of the Wild");
		expect(block).toMatch(
			/BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:\[E\]\[LS\] Patterns of the Wild\r\n/,
		);
		// Tags matching the event's own category add nothing.
		expect(eventBlock(await calendar(), "gbl-week")).toContain(
			"SUMMARY:[GBL] Great League",
		);
	});
});

describe("calendar name and description", () => {
	it("says Everything without filters", async () => {
		const ics = await calendar("?timezone=Europe/Brussels");

		expect(header(ics, "NAME")).toBe("GO - Everything");
		expect(header(ics, "X-WR-CALNAME")).toBe("GO - Everything");
		expect(header(ics, "X-WR-CALDESC")).toBe(
			"All Pokémon GO events\\, auto-updated and sourced from Leek Duck. Local-time events are set for Europe/Brussels.",
		);
	});

	it("describes exclude filters", async () => {
		const ics = await calendar(
			"?timezone=Europe/Brussels&exclude=all_day&exclude=location_specific",
		);

		expect(header(ics, "X-WR-CALNAME")).toBe(
			"GO - Ex: All-day\\, Location-specific",
		);
		expect(header(ics, "X-WR-CALDESC")).toBe(
			"All Pokémon GO events except types: All-day and Location-specific\\, auto-updated and sourced from Leek Duck. Local-time events are set for Europe/Brussels.",
		);
	});

	it("describes include filters", async () => {
		const ics = await calendar(
			"?include=raid_hour&include=raid_day&include=max_mondays",
		);

		expect(header(ics, "X-WR-CALNAME")).toBe(
			"GO - In: Raid Hour\\, Raid Day\\, Max Mondays",
		);
		expect(header(ics, "X-WR-CALDESC")).toBe(
			"Only Pokémon GO events of types: Raid Hour\\, Raid Day and Max Mondays\\, auto-updated and sourced from Leek Duck. Local-time events are set for UTC.",
		);
	});

	it("describes combined filters", async () => {
		const ics = await calendar(
			"?timezone=Europe/Brussels&include=all_day&exclude=location_specific",
		);

		expect(header(ics, "X-WR-CALNAME")).toBe(
			"GO - In: All-day | Ex: Location-specific",
		);
		expect(header(ics, "X-WR-CALDESC")).toBe(
			"Only Pokémon GO events of types: All-day\\, but not Location-specific\\, auto-updated and sourced from Leek Duck. Local-time events are set for Europe/Brussels.",
		);
	});

	it("leaves event descriptions alone", async () => {
		const ics = await calendar("?exclude=all_day");

		expect(eventBlock(ics, "harvest-festival")).toContain(
			"DESCRIPTION:Starts at 10:00\\, ends at 20:00.",
		);
	});
});
