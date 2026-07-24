// Cloudflare Worker entry point: routes requests to Lucy's health check and chat endpoints.
import { handleChatRequest } from './routes/chat';
import { jsonResponse, optionsResponse, isAllowedOrigin } from './utils/response';
import { checkChatRateLimit } from './utils/rate-limit';
import { logChatEvent } from './utils/analytics';
import type { ResendConfig } from './services/tools';

interface LucyEnv extends Env {
	OPENAI_API_KEY: string;
	TURNSTILE_SECRET_KEY: string;
	LUCY_ANALYTICS: AnalyticsEngineDataset;
	RESEND_API_KEY: string;
	RESEND_TO_EMAIL: string;
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		// CORS preflight is handled once here, ahead of route matching.
		if (request.method === 'OPTIONS') {
			return optionsResponse(request);
		}

		// Health check / liveness probe.
		if (url.pathname === '/') {
			if (request.method !== 'GET') {
				return jsonResponse({ error: 'Method not allowed' }, request, 405);
			}

			return jsonResponse(
				{
					status: 'ok',
					assistant: 'Lucy',
					message: 'Lucy is alive!',
				},
				request,
			);
		}

		if (url.pathname === '/chat') {
			if (request.method === 'POST') {
				// Rate limit before touching the OpenAI API to avoid burning quota on abuse.
				const allowed = await checkChatRateLimit(request, env.CHAT_RATE_LIMITER);

				if (!allowed) {
					const requestId = crypto.randomUUID();

					console.warn('Chat request rate limited', {
						requestId,
						path: url.pathname,
					});
					logChatEvent(env.LUCY_ANALYTICS, request, 'rate_limited', requestId);

					return jsonResponse(
						{
							error: 'Too many requests. Please wait a moment and try again.',
							requestId,
						},
						request,
						429,
						{
							'Retry-After': '60',
						},
					);
				}

				// Rejects the request outright on a disallowed Origin, rather than
				// just omitting the CORS header. This only stops naive non-browser
				// callers (Origin is trivially spoofable) — cheap defense in depth
				// on top of the real check, Turnstile verification in handleChatRequest.
				if (!isAllowedOrigin(request.headers.get('Origin'))) {
					const requestId = crypto.randomUUID();

					console.warn('Chat request rejected: disallowed origin', {
						requestId,
						path: url.pathname,
					});
					logChatEvent(env.LUCY_ANALYTICS, request, 'origin_rejected', requestId);

					return jsonResponse({ error: 'Origin not allowed', requestId }, request, 403);
				}
			}

			// Both must actually be set at runtime — a Cloudflare secret that was
			// never `wrangler secret put` is `undefined` despite the string type.
			// Falls back to log-only lead capture if either is missing.
			const resendConfig: ResendConfig | undefined =
				env.RESEND_API_KEY && env.RESEND_TO_EMAIL ? { apiKey: env.RESEND_API_KEY, toEmail: env.RESEND_TO_EMAIL } : undefined;

			// Non-POST methods fall through to handleChatRequest, which returns 405.
			return handleChatRequest(request, env.OPENAI_API_KEY, env.TURNSTILE_SECRET_KEY, resendConfig, env.LUCY_ANALYTICS);
		}

		return jsonResponse({ error: 'Not found' }, request, 404);
	},
} satisfies ExportedHandler<LucyEnv>;
