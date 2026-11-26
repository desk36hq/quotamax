import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const advisorSettings = defineSettings({
  id: "advisor",
  scope: "host",
  version: 1,
  schema: z.object({
    aaApiKey: z.string().default(""),
    recalibrateOnSync: z.boolean().default(true),
  }),
});
