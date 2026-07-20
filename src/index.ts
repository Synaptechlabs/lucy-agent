import { handleChatRequest } from "./routes/chat";
import {
	jsonResponse,
	optionsResponse,
} from "./utils/response";

interface LucyEnv extends Env {
	OPENAI_API_KEY: string;
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return optionsResponse(request);
		}

		if (url.pathname === "/") {
			if (request.method !== "GET") {
				return jsonResponse(
					request,
					{ error: "Method not allowed" },
					405,
				);
			}

			return jsonResponse(request, {
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

		return jsonResponse(
			request,
			{ error: "Not found" },
			404,
		);
	},
} satisfies ExportedHandler<LucyEnv>;