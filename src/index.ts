import { DurableObject } from "cloudflare:workers";
import { runPipeline, revoiceAll, type BuiltSegment } from "./pipeline";

export class Station extends DurableObject {
  sql: any;

  constructor(ctx: any, env: any) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        headline TEXT NOT NULL,
        script TEXT NOT NULL,
        audio_key TEXT NOT NULL,
        voice TEXT,
        tweets TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    `);
  }

  getMeta(k: string): string | null {
    const rows = this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray();
    return rows.length ? (rows[0].v as string) : null;
  }

  setMeta(k: string, v: string) {
    this.sql.exec(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      k,
      v
    );
  }

  // Cheap guard so the public generate endpoint can't burn money in a loop.
  tryStartRun(minIntervalMs: number): boolean {
    const last = this.getMeta("last_run");
    if (last && Date.now() - Date.parse(last) < minIntervalMs) return false;
    this.setMeta("last_run", new Date().toISOString());
    return true;
  }

  addSegment(seg: BuiltSegment) {
    this.sql.exec(
      "INSERT INTO segments (created_at, headline, script, audio_key, voice, tweets) VALUES (?, ?, ?, ?, ?, ?)",
      seg.created_at,
      seg.headline,
      seg.script,
      seg.audio_key,
      seg.voice,
      JSON.stringify(seg.tweets)
    );
  }

  deleteSegment(id: number): string | null {
    const rows = this.sql.exec("SELECT audio_key FROM segments WHERE id = ?", id).toArray();
    if (!rows.length) return null;
    this.sql.exec("DELETE FROM segments WHERE id = ?", id);
    return rows[0].audio_key as string;
  }

  getScripts() {
    return this.sql.exec("SELECT id, script FROM segments").toArray();
  }

  updateSegmentAudio(id: number, audio_key: string, voice: string) {
    this.sql.exec(
      "UPDATE segments SET audio_key = ?, voice = ? WHERE id = ?",
      audio_key,
      voice,
      id
    );
  }

  getPlaylist(limit = 200) {
    return this.sql
      .exec(
        "SELECT id, created_at, headline, script, audio_key, voice, tweets FROM segments ORDER BY created_at DESC, id DESC LIMIT ?",
        limit
      )
      .toArray()
      .map((row: any) => ({
        id: row.id,
        created_at: row.created_at,
        headline: row.headline,
        script: row.script,
        voice: row.voice,
        audio_url: `/api/audio/${row.audio_key}`,
        tweets: JSON.parse(row.tweets),
      }));
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/playlist") {
      const station = env.STATION.get(env.STATION.idFromName("global"));
      return json({ segments: await station.getPlaylist() });
    }

    if (url.pathname.startsWith("/api/audio/")) {
      const key = url.pathname.slice("/api/audio/".length);
      const obj = await env.AUDIO.get(key);
      if (!obj) return new Response("not found", { status: 404 });
      return new Response(obj.body, {
        headers: {
          "content-type": "audio/mpeg",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }

    if (url.pathname === "/api/generate" && request.method === "POST") {
      let body: any = {};
      try { body = await request.json(); } catch {}
      const windowed = Boolean(body.from || body.to);
      const isAdmin = request.headers.get("x-admin-key") === env.ADMIN_KEY;
      // Windowed/backfill runs bypass the rate guard, so they're admin-only.
      if (windowed && !isAdmin) return json({ error: "unauthorized" }, 401);
      try {
        const result = await runPipeline(env, {
          from: body.from,
          to: body.to,
          maxSegments: body.max_segments,
          skipGuard: windowed && isAdmin,
        });
        return json(result);
      } catch (err: any) {
        console.error("generate failed:", err);
        return json({ error: String(err?.message ?? err) }, 500);
      }
    }

    const deleteMatch = url.pathname.match(/^\/api\/segments\/(\d+)$/);
    if (deleteMatch && request.method === "DELETE") {
      if (request.headers.get("x-admin-key") !== env.ADMIN_KEY) {
        return json({ error: "unauthorized" }, 401);
      }
      const station = env.STATION.get(env.STATION.idFromName("global"));
      const audioKey = await station.deleteSegment(parseInt(deleteMatch[1], 10));
      if (audioKey === null) return json({ error: "not found" }, 404);
      await env.AUDIO.delete(audioKey);
      return json({ deleted: parseInt(deleteMatch[1], 10) });
    }

    if (url.pathname === "/api/revoice" && request.method === "POST") {
      if (request.headers.get("x-admin-key") !== env.ADMIN_KEY) {
        return json({ error: "unauthorized" }, 401);
      }
      try {
        const count = await revoiceAll(env);
        return json({ revoiced: count });
      } catch (err: any) {
        console.error("revoice failed:", err);
        return json({ error: String(err?.message ?? err) }, 500);
      }
    }

    // Everything else falls through to static assets (public/).
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event: unknown, env: Env, ctx: any) {
    ctx.waitUntil(
      runPipeline(env).catch((err) => console.error("scheduled run failed:", err))
    );
  },
};
