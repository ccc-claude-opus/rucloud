-- markpedia 的資料庫結構。本機開發執行：
--   npm run db
-- 部署到線上時執行：
--   npm run db-remote
-- 範例條目放在 public/seed/，Worker 在資料表是空的時候會自動灌入（見 src/worker.js 的 ensureSeed）。

CREATE TABLE IF NOT EXISTS entries (
  slug TEXT NOT NULL,                    -- 條目代稱，同一篇條目的兩種語言共用
  lang TEXT NOT NULL CHECK (lang IN ('zh','en')),  -- zh 繁中版、en 英文版
  title TEXT NOT NULL,
  body TEXT NOT NULL,                    -- GitHub Flavored Markdown 原稿
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (slug, lang)
);
CREATE INDEX IF NOT EXISTS idx_entries_title ON entries(title);
