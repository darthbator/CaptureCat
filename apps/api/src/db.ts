import { createDb } from "@capturecat/db";
import { config } from "./config.js";

export const { db, sql } = createDb(config.databaseUrl);
