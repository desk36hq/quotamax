// `orca plugin check .` renders the panel once per scenario, with the real worker on a fresh
// host (it reads this computer's Orca rate limits and session logs).
import { defineCheck } from "orca/testing";

export default defineCheck({
  fresh: {},
  "with-aa-key": { secrets: { aaApiKey: "check-key" } },
  "pools-tab": { persisted: { plugin: { tab: "pools" } } },
});
