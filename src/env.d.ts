// Loose ambient types — wrangler's esbuild strips types, so these are for editor sanity only.
declare interface Env {
  AI: { run(model: string, inputs: unknown): Promise<unknown> };
  AUDIO: any; // R2 bucket
  STATION: any; // Durable Object namespace (Station)
  ASSETS: any;
  ANTHROPIC_API_KEY: string;
  ADMIN_KEY: string;
}
