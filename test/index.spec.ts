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
 * Fixtures: ScrapedDuck's events and the matching Leek Duck event
 * pages. All outbound fetches are mocked, so the tests never touch
 * the network.
 */

interface FixtureEvent {
	eventID: string;
	name: string;
	eventType: string;
	heading: string;
	start: string | null;
	end: string | null;
}

const EVENTS: FixtureEvent[] = [
	{
		// Global, multi-day: all-day.
		eventID: "gbl-week",
		name: "Great League",
		eventType: "go-battle-league",
		heading: "GO Battle League",
		start: "2026-09-15T20:00:00.000Z",
		end: "2026-09-22T20:00:00.000Z",
	},
	{
		eventID: "patterns-of-the-wild-2026",
		name: "Patterns of the Wild",
		eventType: "event",
		heading: "Event",
		start: "2026-10-02T10:00:00.000",
		end: "2026-10-02T20:00:00.000",
	},
	{
		eventID: "harvest-festival",
		name: "Harvest Festival",
		eventType: "event",
		heading: "Event",
		start: "2026-10-05T10:00:00.000",
		end: "2026-10-05T20:00:00.000",
	},
	{
		// Local, multi-day: all-day.
		eventID: "season-24",
		name: "Twilight Trails",
		eventType: "season",
		heading: "Season",
		start: "2026-09-08T10:00:00.000",
		end: "2026-12-01T10:00:00.000",
	},
	{
		// After the EU clock change on 25 Oct (UTC+1).
		eventID: "research-day-1",
		name: "Research Day",
		eventType: "research-day",
		heading: "Research Day",
		start: "2026-11-03T14:00:00.000",
		end: "2026-11-03T17:00:00.000",
	},
	{
		eventID: "raid-day-1",
		name: "Super Mega Raid Day",
		eventType: "raid-day",
		heading: "Raid Day",
		start: "2026-10-10T14:00:00.000",
		end: "2026-10-10T17:00:00.000",
	},
	{
		eventID: "max-monday-1",
		name: "Dynamax Sobble during Max Monday",
		eventType: "max-mondays",
		heading: "Max Mondays",
		start: "2026-10-05T18:00:00.000",
		end: "2026-10-05T19:00:00.000",
	},
	{
		// Global, timed.
		eventID: "global-hour",
		name: "Global Hour",
		eventType: "event",
		heading: "Event",
		start: "2026-10-07T17:00:00.000Z",
		end: "2026-10-07T18:00:00.000Z",
	},
	{
		// A type we have no category for yet.
		eventID: "mystery-1",
		name: "Mystery, Revealed",
		eventType: "mystery-thing",
		heading: "Mystery Thing",
		start: "2026-10-08T10:00:00.000",
		end: "2026-10-08T12:00:00.000",
	},
	{
		// Over: Leek Duck no longer gives its times.
		eventID: "ended-raid-hour",
		name: "Ended Raid Hour",
		eventType: "raid-hour",
		heading: "Raid Hour",
		start: null,
		end: null,
	},
];

// The events that make it into the calendar.
const SHOWN = EVENTS.filter((event) => event.start).map(
	(event) => event.eventID,
);

const SCRAPEDDUCK_EVENTS = EVENTS.map((event) => ({
	...event,
	link: `https://leekduck.com/events/${event.eventID}/`,
	image: `https://cdn.leekduck.com/${event.eventID}.jpg`,
	extraData: null,
}));

const PAGE_TAGS: Record<string, string[]> = {
	"gbl-week": ["go-battle-league"],
	"patterns-of-the-wild-2026": ["event", "location-specific"],
	"harvest-festival": ["event", "team-go-rocket"],
	"season-24": ["season"],
	"research-day-1": ["research-day"],
	"raid-day-1": ["raid-day"],
	"max-monday-1": ["max-mondays"],
	"global-hour": ["event"],
	"mystery-1": ["mystery-thing"],
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
let scrapedDuckStatus: number;
let leekDuckRequests: string[];

beforeEach(async () => {
	scrapedDuckStatus = 200;
	leekDuckRequests = [];

	// KV storage is shared between tests in one file.
	await env.EVENT_TAGS.delete("event-tags");

	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url =
			input instanceof Request ? input.url : String(input);

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
		expect(ics).toMatch(/^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\n/);
		expect(ics).toMatch(/\r\nEND:VCALENDAR\r\n$/);
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

	it("returns 502 when ScrapedDuck is unavailable", async () => {
		scrapedDuckStatus = 500;
		expect((await get()).status).toBe(502);
	});
});

describe("events", () => {
	it("lists ScrapedDuck's events, skipping those without times", async () => {
		expect(uids(await calendar())).toEqual(SHOWN);
	});

	it("carries the title, link, image and a reminder", async () => {
		const block = eventBlock(await calendar(), "max-monday-1");

		expect(block).toContain("SUMMARY:[MM] Dynamax Sobble during Max Monday\r\n");
		expect(block).toContain(
			"DESCRIPTION:Starts at 18:00\\, ends at 19:00.\\n\\nhttps://leekduck.com/events/max-monday-1/\r\n",
		);
		expect(block).toContain("URL:https://leekduck.com/events/max-monday-1/\r\n");
		expect(block).toContain("IMAGE;VALUE=URI:https://cdn.leekduck.com/max-monday-1.jpg\r\n");
		expect(block).toMatch(
			/BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:\[MM\] Dynamax Sobble during Max Monday\r\nTRIGGER:-PT15M\r\nEND:VALARM/,
		);
	});

	it("prefixes unknown types with their heading's acronym and escapes text", async () => {
		expect(eventBlock(await calendar(), "mystery-1")).toContain(
			"SUMMARY:[MT] Mystery\\, Revealed\r\n",
		);
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
	it("sets local times in the timezone, across the clock change", async () => {
		const ics = await calendar("?timezone=Europe/Brussels");

		// 2 Oct: UTC+2.
		expect(eventBlock(ics, "patterns-of-the-wild-2026")).toContain(
			"DTSTART:20261002T080000Z",
		);
		// 3 Nov: UTC+1.
		expect(eventBlock(ics, "research-day-1")).toContain(
			"DTSTART:20261103T130000Z",
		);
		expect(eventBlock(ics, "research-day-1")).toContain(
			"DESCRIPTION:Starts at 14:00\\, ends at 17:00.\\n",
		);
		expect(header(ics, "X-WR-TIMEZONE")).toBe("Europe/Brussels");
	});

	it("treats local times as UTC by default", async () => {
		const ics = await calendar();

		expect(eventBlock(ics, "patterns-of-the-wild-2026")).toContain(
			"DTSTART:20261002T100000Z",
		);
		expect(header(ics, "X-WR-TIMEZONE")).toBe("UTC");
	});

	it("keeps global times and describes them in the timezone", async () => {
		const block = eventBlock(
			await calendar("?timezone=Europe/Brussels"),
			"global-hour",
		);

		expect(block).toContain("DTSTART:20261007T170000Z");
		expect(block).toContain("DTEND:20261007T180000Z");
		expect(block).toContain(
			"DESCRIPTION:Starts at 19:00\\, ends at 20:00 (Europe/Brussels).\\n",
		);
	});

	it("dates global all-day events by their local days", async () => {
		const block = eventBlock(
			await calendar("?timezone=Asia/Tokyo"),
			"gbl-week",
		);

		// 15 Sep 20:00 UTC to 22 Sep 20:00 UTC is 16 to 23 Sep in Tokyo.
		expect(block).toContain("DTSTART;VALUE=DATE:20260916\r\n");
		expect(block).toContain("DTEND;VALUE=DATE:20260924\r\n");
		expect(block).toContain(
			"DESCRIPTION:Starts at 05:00\\, ends at 05:00 (Asia/Tokyo).\\n",
		);
	});

	it("dates local all-day events as written", async () => {
		const block = eventBlock(
			await calendar("?timezone=Asia/Tokyo"),
			"season-24",
		);

		expect(block).toContain("DTSTART;VALUE=DATE:20260908\r\n");
		expect(block).toContain("DTEND;VALUE=DATE:20261202\r\n");
		expect(block).toContain("DESCRIPTION:Starts at 10:00\\, ends at 10:00.\\n");
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

	it("filters all-day events", async () => {
		expect(uids(await calendar("?include=all_day"))).toEqual([
			"gbl-week",
			"season-24",
		]);
		expect(uids(await calendar("?exclude=all_day"))).toHaveLength(
			SHOWN.length - 2,
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
		).toEqual(["harvest-festival", "global-hour"]);
	});
});

describe("Leek Duck page tags", () => {
	it("stores page tags from the scheduled job", async () => {
		await runScheduled();

		// Every listed event once; not the one without times.
		expect(leekDuckRequests.sort()).toEqual([...SHOWN].sort());

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
		expect(Object.keys(stored ?? {})).toHaveLength(SHOWN.length);
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
			"global-hour",
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
});
