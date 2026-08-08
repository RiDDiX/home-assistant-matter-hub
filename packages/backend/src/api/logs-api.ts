import os from "node:os";
import express from "express";
import type { LoggerService } from "../core/app/logger.js";

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  context?: Record<string, unknown>;
  category?: string;
  facility?: string;
}

type LogListener = (entry: LogEntry) => void;

interface LogBuffer {
  entries: LogEntry[];
  maxSize: number;
  listeners: Set<LogListener>;
}

// Use a smaller log buffer on systems with limited memory to reduce overhead.
const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
const defaultMaxSize = totalMemMB < 2048 ? 200 : 1000;

export const logBuffer: LogBuffer = {
  entries: [],
  maxSize: defaultMaxSize,
  listeners: new Set(),
};

export function addLogEntry(entry: LogEntry) {
  logBuffer.entries.push(entry);
  if (logBuffer.entries.length > logBuffer.maxSize) {
    logBuffer.entries.shift();
  }
  for (const listener of logBuffer.listeners) {
    try {
      listener(entry);
    } catch {
      // Listener errors should not break log ingestion
    }
  }
}

export function logsApi(_logger: LoggerService): express.Router {
  const router = express.Router();

  router.get("/", (req, res) => {
    const {
      level,
      search,
      category,
      facility,
      limit = "100",
      offset = "0",
    } = req.query;
    const limitNum = Math.min(
      500,
      Math.max(1, parseInt(limit as string, 10) || 100),
    );
    const offsetNum = Math.max(0, parseInt(offset as string, 10) || 0);

    let entries = [...logBuffer.entries];

    if (level && typeof level === "string") {
      const levels = level.split(",").map((l) => l.toLowerCase().trim());
      entries = entries.filter((e) => levels.includes(e.level.toLowerCase()));
    }

    if (category && typeof category === "string") {
      const cats = category.split(",").map((c) => c.toLowerCase().trim());
      entries = entries.filter(
        (e) => e.category != null && cats.includes(e.category.toLowerCase()),
      );
    }

    if (facility && typeof facility === "string") {
      const facLower = facility.toLowerCase();
      entries = entries.filter((e) =>
        e.facility?.toLowerCase().includes(facLower),
      );
    }

    if (search && typeof search === "string") {
      const searchLower = search.toLowerCase();
      entries = entries.filter((e) =>
        e.message.toLowerCase().includes(searchLower),
      );
    }

    entries.reverse();

    const total = entries.length;
    entries = entries.slice(offsetNum, offsetNum + limitNum);

    res.json({
      total,
      limit: limitNum,
      offset: offsetNum,
      entries,
    });
  });

  router.get("/levels", (_, res) => {
    const levelCounts: Record<string, number> = {};
    for (const entry of logBuffer.entries) {
      const level = entry.level.toLowerCase();
      levelCounts[level] = (levelCounts[level] || 0) + 1;
    }
    res.json({ levels: levelCounts });
  });

  router.delete("/", (_, res) => {
    logBuffer.entries = [];
    res.json({ success: true, message: "Logs cleared" });
  });

  router.get("/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const sendLog = (entry: LogEntry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };

    const recentLogs = logBuffer.entries.slice(-10);
    for (const log of recentLogs) {
      sendLog(log);
    }

    logBuffer.listeners.add(sendLog);

    const intervalId = setInterval(() => {
      res.write(": keepalive\n\n");
    }, 30000);

    req.on("close", () => {
      logBuffer.listeners.delete(sendLog);
      clearInterval(intervalId);
    });
  });

  return router;
}
