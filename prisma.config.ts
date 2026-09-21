// Prisma 7 no longer loads .env on its own, so load it here for CLI commands.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Read directly instead of env(): env() throws when unset, which would break
    // `prisma generate` (run on postinstall) on a fresh clone that has no .env yet.
    // Migration commands still fail clearly if DATABASE_URL is missing.
    url: process.env.DATABASE_URL,
  },
});
