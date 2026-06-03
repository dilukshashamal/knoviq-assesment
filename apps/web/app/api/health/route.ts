import { backendUrls } from "../_lib/backend";

const services = [
  { key: "auth", label: "Auth", url: `${backendUrls.auth}/health` },
  { key: "ai", label: "AI Gateway", url: `${backendUrls.aiGateway}/health` },
  { key: "knowledge", label: "Knowledge", url: `${backendUrls.knowledge}/health` },
  { key: "tools", label: "Tools", url: `${backendUrls.tools}/health` },
] as const;

export async function GET(): Promise<Response> {
  const checks = await Promise.all(
    services.map(async (service) => {
      const startedAt = Date.now();

      try {
        const response = await fetch(service.url, {
          cache: "no-store",
          signal: AbortSignal.timeout(2500),
        });

        return {
          key: service.key,
          label: service.label,
          latencyMs: Date.now() - startedAt,
          ok: response.ok,
          status: response.status,
        };
      } catch {
        return {
          key: service.key,
          label: service.label,
          latencyMs: Date.now() - startedAt,
          ok: false,
          status: 0,
        };
      }
    }),
  );

  return Response.json({
    checks,
    ok: checks.every((check) => check.ok),
  });
}
