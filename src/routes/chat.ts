import { generateLucyReply } from "../services/openai";
import type { ChatRequestBody } from "../types";

export async function handleChatRequest(
	request: Request,
	apiKey: string,
): Promise<Response> {
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
				{ error: "A non-empty message is required" 
},
				{ status: 400 },
			);
		}

		const reply = await generateLucyReply(
			apiKey,
			body.message.trim(),
		);

		return Response.json({ reply });
	} catch (error) {
		console.error("Lucy chat error:", error);

		return Response.json(
			{ error: "Lucy could not generate a response" },
			{ status: 500 },
		);
	}
}
