use anyhow::Result;
use chrono::Utc;
use rusqlite::{Connection, params};

use super::config::Config;
use crate::data::models::*;

pub struct Cache {
    conn: Connection,
}

impl Cache {
    pub fn open() -> Result<Self> {
        let dir = Config::data_dir();
        std::fs::create_dir_all(&dir)?;
        let db_path = dir.join("cpos.db");
        let conn = Connection::open(db_path)?;
        // The capture server thread reads this DB while syncs write it; wait
        // briefly on locks instead of surfacing "database is locked".
        conn.busy_timeout(std::time::Duration::from_millis(1500))?;
        let cache = Cache { conn };
        cache.init_tables()?;
        Ok(cache)
    }

    fn init_tables(&self) -> Result<()> {
        self.conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS problems (
                platform TEXT NOT NULL,
                id TEXT NOT NULL,
                name TEXT NOT NULL,
                url TEXT NOT NULL,
                rating INTEGER,
                tags TEXT NOT NULL DEFAULT '[]',
                category TEXT,
                solved_count INTEGER,
                status TEXT NOT NULL DEFAULT 'Unsolved',
                PRIMARY KEY (platform, id)
            );

            CREATE TABLE IF NOT EXISTS submissions (
                platform TEXT NOT NULL,
                id TEXT NOT NULL,
                problem_id TEXT NOT NULL,
                problem_name TEXT NOT NULL,
                verdict TEXT NOT NULL,
                language TEXT NOT NULL,
                time_ms INTEGER,
                memory_kb INTEGER,
                submitted_at TEXT NOT NULL,
                tags TEXT NOT NULL DEFAULT '[]',
                rating INTEGER,
                PRIMARY KEY (platform, id)
            );

            CREATE TABLE IF NOT EXISTS rating_history (
                platform TEXT NOT NULL,
                contest_name TEXT NOT NULL,
                old_rating INTEGER NOT NULL,
                new_rating INTEGER NOT NULL,
                timestamp TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sync_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS contests (
                platform TEXT NOT NULL,
                id TEXT NOT NULL,
                name TEXT NOT NULL,
                url TEXT NOT NULL,
                start_time TEXT NOT NULL,
                duration_seconds INTEGER NOT NULL,
                phase TEXT NOT NULL,
                PRIMARY KEY (platform, id)
            );
            ",
        )?;
        Ok(())
    }

    pub fn upsert_problems(&self, problems: &[Problem]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for p in problems {
            let tags_json = serde_json::to_string(&p.tags)?;
            let status_str = format!("{:?}", p.status);
            let platform_str = format!("{:?}", p.platform);
            tx.execute(
                "INSERT OR REPLACE INTO problems (platform, id, name, url, rating, tags, category, solved_count, status)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    platform_str,
                    p.id,
                    p.name,
                    p.url,
                    p.rating,
                    tags_json,
                    p.category,
                    p.solved_count,
                    status_str,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_problems(&self, platform: Platform) -> Result<Vec<Problem>> {
        let platform_str = format!("{:?}", platform);
        let mut stmt = self.conn.prepare(
            "SELECT platform, id, name, url, rating, tags, category, solved_count, status
             FROM problems WHERE platform = ?1 ORDER BY id",
        )?;
        let rows = stmt.query_map(params![platform_str], |row| {
            let tags_str: String = row.get(5)?;
            let status_str: String = row.get(8)?;
            let platform_str_row: String = row.get(0)?;
            Ok((
                platform_str_row,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<u32>>(4)?,
                tags_str,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<u64>>(7)?,
                status_str,
            ))
        })?;

        let mut problems = Vec::new();
        for row in rows {
            let (platform_str_row, id, name, url, rating, tags_str, category, solved_count, status_str) =
                row?;
            let tags: Vec<String> = serde_json::from_str(&tags_str).unwrap_or_default();
            let status = match status_str.as_str() {
                "Solved" => SolveStatus::Solved,
                "Attempted" => SolveStatus::Attempted,
                _ => SolveStatus::Unsolved,
            };
            let platform = match platform_str_row.as_str() {
                "Cses" => Platform::Cses,
                "AtCoder" => Platform::AtCoder,
                _ => Platform::Codeforces,
            };
            problems.push(Problem {
                platform,
                id,
                name,
                url,
                rating,
                tags,
                category,
                solved_count,
                status,
            });
        }
        Ok(problems)
    }

    pub fn upsert_submissions(&self, submissions: &[Submission]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for s in submissions {
            let tags_json = serde_json::to_string(&s.tags)?;
            let verdict_str = format!("{:?}", s.verdict);
            let platform_str = format!("{:?}", s.platform);
            tx.execute(
                "INSERT OR REPLACE INTO submissions (platform, id, problem_id, problem_name, verdict, language, time_ms, memory_kb, submitted_at, tags, rating)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    platform_str,
                    s.id,
                    s.problem_id,
                    s.problem_name,
                    verdict_str,
                    s.language,
                    s.time_ms,
                    s.memory_kb,
                    s.submitted_at.to_rfc3339(),
                    tags_json,
                    s.rating,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_submissions(&self, platform: Platform) -> Result<Vec<Submission>> {
        let platform_str = format!("{:?}", platform);
        let mut stmt = self.conn.prepare(
            "SELECT platform, id, problem_id, problem_name, verdict, language, time_ms, memory_kb, submitted_at, tags, rating
             FROM submissions WHERE platform = ?1 ORDER BY submitted_at DESC",
        )?;
        let rows = stmt.query_map(params![platform_str], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<u64>>(6)?,
                row.get::<_, Option<u64>>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, Option<u32>>(10)?,
            ))
        })?;

        let mut subs = Vec::new();
        for row in rows {
            let (plat_str, id, pid, pname, verdict_str, lang, time_ms, mem_kb, at_str, tags_str, rating) = row?;
            let platform = match plat_str.as_str() {
                "Cses" => Platform::Cses,
                "AtCoder" => Platform::AtCoder,
                _ => Platform::Codeforces,
            };
            let verdict = match verdict_str.as_str() {
                "Accepted" => Verdict::Accepted,
                "WrongAnswer" => Verdict::WrongAnswer,
                "TimeLimitExceeded" => Verdict::TimeLimitExceeded,
                "MemoryLimitExceeded" => Verdict::MemoryLimitExceeded,
                "RuntimeError" => Verdict::RuntimeError,
                "CompilationError" => Verdict::CompilationError,
                _ => Verdict::Other,
            };
            let tags: Vec<String> = serde_json::from_str(&tags_str).unwrap_or_default();
            let submitted_at = chrono::DateTime::parse_from_rfc3339(&at_str)
                .map(|d| d.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now());
            subs.push(Submission {
                platform,
                id,
                problem_id: pid,
                problem_name: pname,
                verdict,
                language: lang,
                time_ms,
                memory_kb: mem_kb,
                submitted_at,
                tags,
                rating,
            });
        }
        Ok(subs)
    }

    pub fn get_all_submissions(&self) -> Result<Vec<Submission>> {
        let mut all = Vec::new();
        for plat in &[Platform::Codeforces, Platform::Cses, Platform::AtCoder] {
            all.extend(self.get_submissions(*plat)?);
        }
        all.sort_by(|a, b| b.submitted_at.cmp(&a.submitted_at));
        Ok(all)
    }

    pub fn upsert_rating_history(&self, platform: Platform, changes: &[RatingChange]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        let platform_str = format!("{:?}", platform);
        tx.execute(
            "DELETE FROM rating_history WHERE platform = ?1",
            params![platform_str],
        )?;
        for c in changes {
            tx.execute(
                "INSERT INTO rating_history (platform, contest_name, old_rating, new_rating, timestamp)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    platform_str,
                    c.contest_name,
                    c.old_rating,
                    c.new_rating,
                    c.timestamp.to_rfc3339(),
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_rating_history(&self, platform: Platform) -> Result<Vec<RatingChange>> {
        let platform_str = format!("{:?}", platform);
        let mut stmt = self.conn.prepare(
            "SELECT contest_name, old_rating, new_rating, timestamp
             FROM rating_history WHERE platform = ?1 ORDER BY timestamp",
        )?;
        let rows = stmt.query_map(params![platform_str], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u32>(1)?,
                row.get::<_, u32>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        let mut changes = Vec::new();
        for row in rows {
            let (name, old, new, ts_str) = row?;
            let timestamp = chrono::DateTime::parse_from_rfc3339(&ts_str)
                .map(|d| d.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now());
            changes.push(RatingChange {
                contest_name: name,
                old_rating: old,
                new_rating: new,
                timestamp,
            });
        }
        Ok(changes)
    }

    pub fn set_sync_meta(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_sync_meta(&self, key: &str) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT value FROM sync_meta WHERE key = ?1")?;
        let mut rows = stmt.query_map(params![key], |row| row.get::<_, String>(0))?;
        match rows.next() {
            Some(Ok(val)) => Ok(Some(val)),
            _ => Ok(None),
        }
    }

    pub fn upsert_contests(&self, contests: &[Contest]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM contests", [])?;
        for c in contests {
            let platform_str = format!("{:?}", c.platform);
            let phase_str = format!("{:?}", c.phase);
            tx.execute(
                "INSERT INTO contests (platform, id, name, url, start_time, duration_seconds, phase)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    platform_str,
                    c.id,
                    c.name,
                    c.url,
                    c.start_time.to_rfc3339(),
                    c.duration_seconds,
                    phase_str,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_contests(&self, platform: Platform) -> Result<Vec<Contest>> {
        let platform_str = format!("{:?}", platform);
        let mut stmt = self.conn.prepare(
            "SELECT platform, id, name, url, start_time, duration_seconds, phase
             FROM contests WHERE platform = ?1",
        )?;
        let rows = stmt.query_map(params![platform_str], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, u64>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?;

        let mut contests = Vec::new();
        for row in rows {
            let (plat_str, id, name, url, start_str, duration_seconds, phase_str) = row?;
            let platform = match plat_str.as_str() {
                "Cses" => Platform::Cses,
                "AtCoder" => Platform::AtCoder,
                _ => Platform::Codeforces,
            };
            let phase = match phase_str.as_str() {
                "Before" => ContestPhase::Before,
                "Running" => ContestPhase::Running,
                _ => ContestPhase::Finished,
            };
            let start_time = chrono::DateTime::parse_from_rfc3339(&start_str)
                .map(|d| d.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now());
            contests.push(Contest {
                platform,
                id,
                name,
                url,
                start_time,
                duration_seconds,
                phase,
            });
        }
        Ok(contests)
    }
}
