// Shared response helpers: CORS enforcement and consistent JSON envelopes for every route.

// Origins allowed to call the API cross-origin. Anything else gets no
// Access-Control-Allow-Origin header, so the browser blocks the response.
const ALLOWED_ORIGINS = new Set([
	'http://localhost:3000',
	'http://localhost:5173',
	'https://synaptechlabs.ai',
	'https://www.synaptechlabs.ai',
]);

// Exported so index.ts can reject a POST /chat outright on a disallowed
// Origin, not just omit the CORS header that only a browser would honor.
export function isAllowedOrigin(origin: string | null): boolean {
	return origin !== null && ALLOWED_ORIGINS.has(origin);
}

function getCorsHeaders(request: Request): HeadersInit {
	const origin = request.headers.get('Origin');

	const headers: Record<string, string> = {
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Max-Age': '86400',
		Vary: 'Origin',
	};

	if (origin && ALLOWED_ORIGINS.has(origin)) {
		headers['Access-Control-Allow-Origin'] = origin;
	}

	return headers;
}

// Standard JSON response wrapper used by every route: attaches CORS headers
// and disables caching/content sniffing so error and chat payloads are never cached or reinterpreted.
export function jsonResponse(body: unknown, request: Request, status = 200, additionalHeaders: HeadersInit = {}): Response {
	return Response.json(body, {
		status,
		headers: {
			...getCorsHeaders(request),
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
			...additionalHeaders,
		},
	});
}

// Handles CORS preflight (OPTIONS) requests: rejects unknown origins outright,
// otherwise replies with an empty 204 carrying the allow headers.
export function optionsResponse(request: Request): Response {
	const origin = request.headers.get('Origin');

	if (!isAllowedOrigin(origin)) {
		return jsonResponse({ error: 'Origin not allowed' }, request, 403);
	}

	return new Response(null, {
		status: 204,
		headers: getCorsHeaders(request),
	});
}
