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

import { handleChatRequest } from "./routes/chat";

interface LucyEnv extends Env {
	OPENAI_API_KEY: string;
}


export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/") {
			return Response.json({
				status: "ok",
				assistant: "Lucy",
				message: "Lucy is alive!",
			});
		}

		if (url.pathname === "/chat") {
			return handleChatRequest(
				request,
				env.OPENAI_API_KEY,
			);
		}

		return Response.json(
			{ error: "Not found" },
			{ status: 404 },
		);
	},
} satisfies ExportedHandler<LucyEnv>;