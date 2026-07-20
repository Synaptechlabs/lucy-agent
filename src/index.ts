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

import OpenAI from "openai";

interface LucyEnv extends Env {
	OPENAI_API_KEY: string;
}

interface ChatRequestBody {
	message?: unknown;
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
			if (request.method !== "POST") {
				return Response.json(
					{ error: "POST required" },
					{ status: 405 },
				);
			}

			try {
				const body = (await request.json()) as ChatRequestBody;

				if (
					typeof body.message !== "string" ||
					body.message.trim().length === 0
				) {
					return Response.json(
						{ error: "A non-empty message is required" },
						{ status: 400 },
					);
				}

				const openai = new OpenAI({
					apiKey: env.OPENAI_API_KEY,
				});

				const response = await openai.responses.create({
					model: "gpt-5.6-luna",
					reasoning: {
						effort: "low",
					},
					instructions:
						"You are Lucy, a friendly and professional AI assistant. Keep your answers clear and concise.",
					input: body.message.trim(),
				});

				return Response.json({
					reply: response.output_text,
				});
			} catch (error) {
				console.error("Lucy chat error:", error);

				return Response.json(
					{ error: "Lucy could not generate a response" },
					{ status: 500 },
				);
			}
		}

		return Response.json(
			{ error: "Not found" },
			{ status: 404 },
		);
	},
} satisfies ExportedHandler<LucyEnv>;