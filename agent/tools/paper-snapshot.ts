import { defineTool } from "eve/tools";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

export default defineTool({
  description: "Read the designated local paper database without changing state, risk, orders or configuration. Returns bounded paper records, never credentials.",
  inputSchema: z.object({}),
  async execute() {
    const path = resolve(process.env.TRADING_LAB_DB_PATH || "data/trading-lab.sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db.prepare("SELECT payload FROM state WHERE id=1").get() as { payload: string } | undefined;
      if (!row) return { available: false, reason: "No local paper experiment has been saved." };
      const state = JSON.parse(row.payload);
      const bounded = {
        mode: state.mode, source: state.dataSource, status: state.status,
        runId: state.runId, cursor: state.cursor, metrics: state.metrics,
        positions: state.positions, decisions: state.decisions.slice(-12),
        trades: state.trades.slice(-20), configVersion: state.settings.version,
        limitation: "Paper simulation. Captured evidence is not a live news feed. No profitability or broker execution is verified.",
      };
      let encoded = JSON.stringify(bounded);
      for (const secret of [process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY].filter((value): value is string => Boolean(value))) encoded = encoded.replaceAll(secret, "[redacted]");
      return JSON.parse(encoded);
    } finally { db.close(); }
  },
});
