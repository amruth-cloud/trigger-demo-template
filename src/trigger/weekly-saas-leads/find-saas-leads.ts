import { schedules } from "@trigger.dev/sdk";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const TAVILY_URL = "https://api.tavily.com/search";
const NOTION_BASE_URL = "https://api.notion.com/v1";
// Any current Claude model ID works here. See https://docs.claude.com for the list.
const MODEL = "claude-opus-5-5";
// EDIT: your own IANA timezone (used for the schedule and the "Found on" date)
const TIME_ZONE = "Europe/Berlin";

const TARGET_LEADS = 10;
// Ask Claude for extra candidates because some get dropped (duplicate, dead website, no website)
const CANDIDATE_BUFFER = 8;
const MAX_SOURCES_PER_ROUND = 100;
const MAX_SNIPPET_CHARS = 700;
// Each website lookup costs 1 Tavily credit, so cap them per run
const MAX_WEBSITE_LOOKUPS = 40;
const NOTION_MAX_TEXT = 1900; // Notion allows 2000 chars per rich_text item

// Pages that are never a lead's own website
const PLATFORM_DOMAINS = new Set([
  "indiehackers.com", "producthunt.com", "reddit.com", "news.ycombinator.com", "ycombinator.com",
  "github.com", "x.com", "twitter.com", "linkedin.com", "medium.com", "substack.com", "youtube.com",
  "facebook.com", "instagram.com", "dev.to", "hashnode.com", "notion.so", "google.com", "wikipedia.org",
]);

type SearchQuery = { query: string; includeDomains?: string[] };
type SearchRound = { timeRange: "month" | "year"; queries: SearchQuery[] };

// EXAMPLE SEARCH QUERIES: edit these to match your own target market.
// Round 1 looks at the last month. Later rounds only run if earlier rounds did not find enough new leads.
const SEARCH_ROUNDS: SearchRound[] = [
  {
    timeRange: "month",
    queries: [
      { query: "launched my SaaS first paying customers MRR building in public", includeDomains: ["indiehackers.com"] },
      { query: "just launched SaaS $0 MRR looking for first users", includeDomains: ["indiehackers.com"] },
      { query: "new SaaS launch solo founder bootstrapped indie maker", includeDomains: ["producthunt.com"] },
      { query: "I built a SaaS and launched it, no customers yet, how do I get users", includeDomains: ["reddit.com"] },
      { query: "bootstrapped SaaS first customers under $500 MRR feedback", includeDomains: ["reddit.com"] },
      { query: "Show HN SaaS I built solo founder launched", includeDomains: ["news.ycombinator.com"] },
      { query: "bootstrapped SaaS founder building in public just launched pre-revenue" },
      { query: "solo founder SaaS launched first 10 users free trial low engagement" },
    ],
  },
  {
    timeRange: "year",
    queries: [
      { query: "SaaS pre-revenue live product first paying customer bootstrapped", includeDomains: ["indiehackers.com"] },
      { query: "struggling to activate trial users SaaS solo founder", includeDomains: ["indiehackers.com"] },
      { query: "indie maker SaaS launch getting first signups", includeDomains: ["producthunt.com"] },
      { query: "my SaaS has users signing up but they don't come back engagement", includeDomains: ["reddit.com"] },
      { query: "microsaas launched $100 MRR bootstrapped no funding", includeDomains: ["reddit.com"] },
      { query: "Show HN I made a SaaS looking for feedback early users", includeDomains: ["news.ycombinator.com"] },
      { query: "bootstrapped micro SaaS founder story first customers no funding" },
      { query: "SaaS founder email onboarding sequence low activation bootstrapped early stage" },
    ],
  },
  {
    // Last resort: different angles (product launches, first-month retrospectives, feedback requests)
    timeRange: "year",
    queries: [
      { query: "how I got my first customers for my SaaS from $0 to first $100 MRR", includeDomains: ["indiehackers.com"] },
      { query: "launched SaaS side project no marketing budget signups not converting", includeDomains: ["indiehackers.com"] },
      { query: "maker launched solo bootstrapped product first launch feedback welcome", includeDomains: ["producthunt.com"] },
      { query: "feedback on my SaaS landing page just launched", includeDomains: ["reddit.com"] },
      { query: "launched my micro SaaS this month first users", includeDomains: ["reddit.com"] },
      { query: "Ask HN feedback on my early stage SaaS", includeDomains: ["news.ycombinator.com"] },
      { query: "indie hacker SaaS launch retrospective first month signups no revenue" },
      { query: "bootstrapped SaaS pre-revenue live product founder launch post website" },
    ],
  },
];

const LeadSchema = z.object({
  company_name: z.string(),
  website: z.string().nullable(),
  founder_name: z.string().nullable(),
  source_url: z.string(),
  stage: z.enum(["Pre-revenue", "Early revenue"]),
  confidence: z.enum(["High", "Medium", "Low"]),
  stage_evidence: z.string(),
  why_they_fit: z.string(),
  pain_point: z.string(),
  pitch_angle: z.string(),
});
const LeadsSchema = z.object({ leads: z.array(LeadSchema) });

type Lead = z.infer<typeof LeadSchema>;
type SearchResult = { title: string; url: string; content: string };

// ============================================================================
// EXAMPLE OFFER + LEAD CRITERIA: EDIT THIS BLOCK FOR YOUR OWN BUSINESS.
// The text below is a made-up example (a freelancer selling a 5-email course).
// Replace the offer and the "good lead" rules with what you actually sell.
// ============================================================================
const SYSTEM_PROMPT = `You are a lead researcher for a freelancer who sells a done-for-you educational email course to bootstrapped SaaS companies.

WHAT THE SELLER OFFERS: A 5-email educational sequence. A visitor opts in with their email address and then receives five emails that teach them something useful about the company's product area. The goal is to raise engagement: turning anonymous visitors into subscribers who learn, trust the product and come back.

WHAT MAKES A GOOD LEAD (all must be true):
- A SaaS or software product that is LIVE (people can use or sign up for it now). An idea, waitlist-only page or "coming soon" does not count.
- Bootstrapped: no venture or institutional funding mentioned, founder-led, small team (1 to 5 people).
- Stage is either Pre-revenue (live product, no revenue yet) or Early revenue (under about $10k MRR). Exclude anyone at or above about $10k MRR, anyone who has raised funding, agencies, big companies, and products with a large team.
- Some signal that engagement, activation, audience building or getting users is a challenge, or that an email course would fit the product's audience.

STRICT RULES:
- Use ONLY facts found in the numbered sources. Never invent revenue, funding, team size, founder names or websites.
- "website" must be the company's own product website and must appear in the source text or be clearly stated there. If you cannot find it in the sources, set it to null.
- "source_url" must be the URL of the source you used, copied exactly.
- "stage_evidence" must quote or closely paraphrase the actual evidence for the stage (for example "founder says $0 MRR, launched 3 weeks ago") and say what it is based on.
- "confidence": High = direct statements about stage and bootstrapping; Medium = strong hints; Low = mostly inferred.
- "why_they_fit", "pain_point" and "pitch_angle": one or two concrete sentences each, specific to this company. The pitch angle should say what the offer could do for their audience and how it would help them.
- Skip anything that fails the criteria. Returning fewer leads is better than returning weak ones. Never return the same company twice.`;

// ---------- Small helpers ----------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function getDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const withProtocol = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    return new URL(withProtocol).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function isPlatformDomain(domain: string): boolean {
  return [...PLATFORM_DOMAINS].some((platform) => domain === platform || domain.endsWith(`.${platform}`));
}

function todayInBerlin(): string {
  // sv-SE formats dates as YYYY-MM-DD
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TIME_ZONE }).format(new Date());
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Cuts by whole characters. A plain .slice() can split an emoji in half, which produces invalid JSON
// and makes the Claude and Notion APIs reject the request.
function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

// ---------- Tavily (web search) ----------

async function tavilySearch(apiKey: string, search: SearchQuery, timeRange?: "month" | "year"): Promise<SearchResult[]> {
  const res = await fetch(TAVILY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: search.query,
      search_depth: "basic",
      max_results: 10,
      ...(timeRange ? { time_range: timeRange } : {}),
      ...(search.includeDomains ? { include_domains: search.includeDomains } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`Tavily API ${res.status} for query "${search.query}": ${await res.text()}`);
  }
  const data = (await res.json()) as { results?: SearchResult[] };
  return data.results ?? [];
}

async function searchRound(apiKey: string, round: SearchRound): Promise<SearchResult[]> {
  // Plain fetch calls, so Promise.all is fine here (the Promise.all ban only applies to Trigger.dev wait/triggerAndWait calls)
  const settled = await Promise.all(round.queries.map((q) => tavilySearch(apiKey, q, round.timeRange)));
  const byUrl = new Map<string, SearchResult>();
  for (const results of settled) {
    for (const result of results) {
      if (!byUrl.has(result.url)) byUrl.set(result.url, result);
    }
  }
  return [...byUrl.values()].slice(0, MAX_SOURCES_PER_ROUND);
}

// ---------- Claude (pick and qualify leads) ----------

async function pickLeadsWithClaude(
  anthropic: Anthropic,
  sources: SearchResult[],
  wanted: number,
  excludeDomains: string[]
): Promise<Lead[]> {
  const sourceText = sources
    .map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\n${truncate(s.content, MAX_SNIPPET_CHARS)}`)
    .join("\n\n");

  const userPrompt = `Find up to ${wanted} qualifying leads in the sources below.

Do NOT return any company whose website domain is in this list (already in the seller's pipeline):
${excludeDomains.length ? excludeDomains.join(", ") : "(none yet)"}

SOURCES:
${sourceText}`;

  const response = await anthropic.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    output_config: { format: zodOutputFormat(LeadsSchema) },
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined the request (${response.stop_details?.category ?? "no category"})`);
  }
  if (!response.parsed_output) {
    throw new Error(`Claude returned no valid lead list (stop_reason: ${response.stop_reason})`);
  }
  return response.parsed_output.leads;
}

// ---------- Website check ----------

// A lead only counts if its website actually loads. 401/403/429 mean the site is up but blocks bots.
async function isWebsiteLive(url: string): Promise<boolean> {
  try {
    const res = await fetch(/^https?:\/\//i.test(url) ? url : `https://${url}`, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; LeadCheck/1.0)" },
    });
    return res.status < 400 || [401, 403, 429].includes(res.status);
  } catch {
    return false;
  }
}

// Search snippets often describe a product without linking to it. For those leads, search for the company's own
// website and only accept a result whose domain clearly matches the company name (e.g. "Promotee" -> promotee.io).
const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

function domainMatchesName(domain: string, companyName: string): boolean {
  const parts = domain.split(".");
  const label = normalize(parts.length >= 2 ? parts[parts.length - 2] : parts[0]);
  const name = normalize(companyName);
  return name.length >= 4 && label.length >= 4 && (label.includes(name) || name.includes(label));
}

async function findWebsite(apiKey: string, companyName: string): Promise<string | null> {
  const results = await tavilySearch(apiKey, { query: `${companyName} SaaS official website` });
  for (const result of results) {
    const domain = getDomain(result.url);
    if (!domain || isPlatformDomain(domain)) continue;
    if (domainMatchesName(domain, companyName)) return new URL(result.url).origin;
  }
  return null;
}

// ---------- Notion ----------

function richText(text: string) {
  return [{ type: "text", text: { content: truncate(text, NOTION_MAX_TEXT) } }];
}

async function notionRequest<T>(notionKey: string, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${NOTION_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${notionKey}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw new Error(`Notion API ${res.status} for ${method} ${path}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

type NotionQueryPage = {
  results: Array<{
    properties: {
      Website?: { url: string | null };
      "Found on"?: { date: { start: string } | null };
    };
  }>;
  has_more: boolean;
  next_cursor: string | null;
};

// Reads every existing lead so we never add the same company twice, and counts how many were added today
// (so a retried run does not add a second batch of 10)
async function loadExistingLeads(notionKey: string, databaseId: string, today: string) {
  const domains = new Set<string>();
  let addedToday = 0;
  let cursor: string | null = null;
  do {
    const page: NotionQueryPage = await notionRequest(notionKey, "POST", `/databases/${databaseId}/query`, {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const row of page.results) {
      const domain = getDomain(row.properties.Website?.url);
      if (domain) domains.add(domain);
      if (row.properties["Found on"]?.date?.start?.slice(0, 10) === today) addedToday++;
    }
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return { domains, addedToday };
}

async function addLeadToNotion(notionKey: string, databaseId: string, lead: Lead, today: string): Promise<string> {
  const page = await notionRequest<{ url: string }>(notionKey, "POST", "/pages", {
    parent: { database_id: databaseId },
    properties: {
      Company: { title: richText(lead.company_name) },
      // Notion needs a full URL for the link to be clickable
      Website: { url: lead.website && !/^https?:\/\//i.test(lead.website) ? `https://${lead.website}` : lead.website },
      Founder: { rich_text: richText(lead.founder_name ?? "Unknown") },
      Source: { url: lead.source_url },
      Stage: { select: { name: lead.stage } },
      Confidence: { select: { name: lead.confidence } },
      "Stage evidence": { rich_text: richText(lead.stage_evidence) },
      "Why they fit": { rich_text: richText(lead.why_they_fit) },
      "Pain point": { rich_text: richText(lead.pain_point) },
      "Pitch angle": { rich_text: richText(lead.pitch_angle) },
      Status: { select: { name: "New" } },
      "Found on": { date: { start: today } },
    },
  });
  return page.url;
}

// ---------- The task ----------

const CONFIDENCE_ORDER: Record<Lead["confidence"], number> = { High: 0, Medium: 1, Low: 2 };

export const findSaasLeads = schedules.task({
  id: "find-saas-leads",
  // 8am in TIME_ZONE every Monday. The timezone option handles summer/winter time automatically.
  cron: { pattern: "0 8 * * 1", timezone: TIME_ZONE },
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 60_000,
  },

  run: async () => {
    const tavilyKey = requireEnv("TAVILY_API_KEY");
    const anthropicKey = requireEnv("ANTHROPIC_API_KEY");
    const notionKey = requireEnv("NOTION_API_KEY");
    const databaseId = requireEnv("NOTION_LEADS_DATABASE_ID");

    const today = todayInBerlin();
    const anthropic = new Anthropic({ apiKey: anthropicKey });

    // 1. What is already in the pipeline?
    const existing = await loadExistingLeads(notionKey, databaseId, today);
    const needed = TARGET_LEADS - existing.addedToday;
    console.log(`Pipeline has ${existing.domains.size} lead(s); ${existing.addedToday} already added today`);
    if (needed <= 0) return { added: 0, note: "Already added today's leads" };

    // 2. Search, let Claude pick, and verify. Repeat with a wider search if we are short.
    const picked = new Map<string, Lead>();
    let websiteLookups = 0;
    for (const round of SEARCH_ROUNDS) {
      if (picked.size >= needed) break;

      const sources = await searchRound(tavilyKey, round);
      console.log(`Round (${round.timeRange}): ${sources.length} unique search results`);
      if (sources.length === 0) continue;

      const exclude = [...existing.domains, ...picked.keys()];
      const candidates = await pickLeadsWithClaude(anthropic, sources, needed - picked.size + CANDIDATE_BUFFER, exclude);
      console.log(`Claude proposed ${candidates.length} candidate(s)`);

      for (const candidate of candidates) {
        if (!getDomain(candidate.website) && websiteLookups < MAX_WEBSITE_LOOKUPS) {
          websiteLookups++;
          candidate.website = await findWebsite(tavilyKey, candidate.company_name);
          if (candidate.website) console.log(`Found website for ${candidate.company_name}: ${candidate.website}`);
        }
        const domain = getDomain(candidate.website);
        if (!domain) {
          console.log(`Skipping ${candidate.company_name}: could not find its website`);
          continue;
        }
        if (isPlatformDomain(domain)) {
          console.log(`Skipping ${candidate.company_name}: website is a platform page (${domain})`);
          continue;
        }
        if (existing.domains.has(domain) || picked.has(domain)) {
          console.log(`Skipping ${candidate.company_name}: already in the pipeline`);
          continue;
        }
        if (!(await isWebsiteLive(candidate.website!))) {
          console.log(`Skipping ${candidate.company_name}: website did not load`);
          continue;
        }
        picked.set(domain, candidate);
      }
    }

    // 3. Keep the strongest matches and write them to Notion
    const finalLeads = [...picked.values()]
      .sort((a, b) => CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence])
      .slice(0, needed);

    const notionUrls: string[] = [];
    for (const lead of finalLeads) {
      notionUrls.push(await addLeadToNotion(notionKey, databaseId, lead, today));
      await sleep(350); // stay under Notion's ~3 requests/second limit
    }

    if (finalLeads.length < needed) {
      console.warn(`Only found ${finalLeads.length} of ${needed} leads this week`);
    }
    console.log(`Added ${finalLeads.length} lead(s) to Notion`);

    return {
      added: finalLeads.length,
      shortfall: Math.max(0, needed - finalLeads.length),
      companies: finalLeads.map((l) => `${l.company_name} (${l.confidence})`),
      notionUrls,
    };
  },
});
