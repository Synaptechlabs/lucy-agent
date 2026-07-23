// Cloudflare Worker entry point: routes requests to Lucy's health check and chat endpoints.
import { handleChatRequest } from './routes/chat';
import { jsonResponse, optionsResponse } from './utils/response';
import { checkChatRateLimit } from './utils/rate-limit';

interface LucyEnv extends Env {
	OPENAI_API_KEY: string;
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
			}

			// Non-POST methods fall through to handleChatRequest, which returns 405.
			return handleChatRequest(request, env.OPENAI_API_KEY);
		}

		return jsonResponse({ error: 'Not found' }, request, 404);
	},
} satisfies ExportedHandler<LucyEnv>;
