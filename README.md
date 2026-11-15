# Weekly SaaS Lead Finder (Trigger.dev template)

A TypeScript template for a scheduled lead-research automation. Every week it searches the web for early-stage, bootstrapped SaaS products, has Claude qualify them against criteria you define, checks that each company's website loads, skips companies already in your pipeline, and saves the rest to a Notion database with the evidence.

The search queries and the "ideal lead" prompt are **made-up examples**. Edit them for your own offer and market (see [Customise](#customise)).

## How it works

```
 Schedule (Monday 8am, your timezone)
        |
        v
 Read existing leads from Notion  --> skip known websites, count today's adds
        |
        v
 Tavily web search (up to 3 rounds, wider each round if leads are short)
        |
        v
 Claude qualifies candidates (structured output, only facts from the sources)
        |
        v
 Find / verify website  --> must load, must not be a platform page, must be new
        |
        v
 Write up to 10 leads to Notion (company, website, stage, evidence, pain point, pitch angle)
```

## Tools used

- [Trigger.dev](https://trigger.dev) v4 (`schedules.task`) for scheduling, retries and hosting
- [Tavily](https://tavily.com) search API
- Anthropic Claude API (`@anthropic-ai/sdk`, structured output with Zod)
- Notion API
- TypeScript, native `fetch`

## Setup

1. Install Node.js 20+ and run `npm install`.
2. Create a free Trigger.dev account and a project. Put its ref (starts with `proj_`) in [trigger.config.ts](trigger.config.ts).
3. Copy `.env.example` to `.env` and fill in the four values: `TAVILY_API_KEY`, `ANTHROPIC_API_KEY`, `NOTION_API_KEY`, `NOTION_LEADS_DATABASE_ID`.
4. Create a Notion database with these properties, then share it with your Notion integration (database "..." menu, Connections):

   | Property | Type |
   |---|---|
   | Company | Title |
   | Website | URL |
   | Founder | Text |
   | Source | URL |
   | Stage | Select (`Pre-revenue`, `Early revenue`) |
   | Confidence | Select (`High`, `Medium`, `Low`) |
   | Stage evidence | Text |
   | Why they fit | Text |
   | Pain point | Text |
   | Pitch angle | Text |
   | Status | Select (`New`) |
   | Found on | Date |

5. Add the same four environment variables in the Trigger.dev dashboard (Project, Environment Variables) for each environment you deploy to.
6. Run locally with `npx trigger.dev@latest dev`, then trigger the `find-saas-leads` task from the dashboard. Deploy with `npx trigger.dev@latest deploy` when ready.

Optional offline check (no API calls): `npx tsc --noEmit`

## Customise

All in [src/trigger/weekly-saas-leads/find-saas-leads.ts](src/trigger/weekly-saas-leads/find-saas-leads.ts):

- `SYSTEM_PROMPT`: the example offer and lead criteria. Replace with your own.
- `SEARCH_ROUNDS`: the example search queries and source sites.
- `TARGET_LEADS`, `TIME_ZONE`, and the cron pattern in the task definition.
- `MODEL`: set to `claude-opus-5-5`; change to any current Claude model ID.

## Limits

- Configured for Tavily, the Anthropic API and Notion. This repo does not include evidence of production runs, and none are claimed.
- It does not send emails. There are no email sends, dry-run or otherwise.
- No measured time saved. No client, revenue or results claims.
- No sample outputs or recorded runs are included.
- The model ID and Notion property names were not checked against live services while preparing this template; verify them on your first local run.
- Lead quality depends on search snippets, so qualifications can be wrong. Review leads before outreach.
- Each run spends Tavily credits and Anthropic tokens; check your own plan and limits.

## License

MIT, see [LICENSE](LICENSE).
