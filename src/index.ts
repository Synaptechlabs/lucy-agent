/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/") {
			return Response.json({
				status: "ok",
				assistant: "Lucy",
				message: "Lucy is alive!",
			});
		}

		if (url.pathname === "/chat") {

	if (request.method !== "POST") {
		return Response.json(
			{
				error: "POST required",
			},
			{
				status: 405,
			},
		);
	}

	const body = await request.json();

	return Response.json({
		reply: `You said: ${body.message}`,
	});
}

		return Response.json(
			{
				error: "Not found",
			},
			{
				status: 404,
			},
		);
	},
} satisfies ExportedHandler<Env>;
