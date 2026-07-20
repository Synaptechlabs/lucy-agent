const ALLOWED_ORIGINS = new Set([
	"http://localhost:3000",
	"http://localhost:5173",
	"https://synaptechlabs.ai",
	"https://www.synaptechlabs.ai",
]);

function getCorsHeaders(request: Request): HeadersInit {
	const origin = request.headers.get("Origin");

	const headers: Record<string, string> = {
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
		"Access-Control-Max-Age": "86400",
		"Vary": "Origin",
	};

	if (origin && ALLOWED_ORIGINS.has(origin)) {
		headers["Access-Control-Allow-Origin"] = origin;
	}

	return headers;
}

export function jsonResponse(
	request: Request,
	body: unknown,
	status = 200,
): Response {
	return Response.json(body, {
		status,
		headers: {
			...getCorsHeaders(request),
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

export function optionsResponse(request: Request): Response {
	const origin = request.headers.get("Origin");

	if (!origin || !ALLOWED_ORIGINS.has(origin)) {
		return jsonResponse(
			request,
			{ error: "Origin not allowed" },
			403,
		);
	}

	return new Response(null, {
		status: 204,
		headers: getCorsHeaders(request),
	});
}
