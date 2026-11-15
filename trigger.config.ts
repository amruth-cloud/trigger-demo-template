import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  // REPLACE with your own project ref from cloud.trigger.dev (Project > Settings). It starts with "proj_".
  project: "proj_REPLACE_ME",
  dirs: ["./src/trigger"],
  // Web search + Claude analysis + Notion writes should finish well within this
  maxDuration: 900,
});
