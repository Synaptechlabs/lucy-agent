import OpenAI from "openai";

import { generateLucyReply } from "../services/openai";
import type { ChatRequestBody } from "../types";
import { jsonResponse } from "../utils/response";

const MAX_MESSAGE_LENGTH = 4_000;

export async function handleChatRequest(
	request: Request,
	apiKey: string,
): Promise<Response> {
	const requestId = crypto.randomUUID();

	if (request.method !== "POST") {
		return jsonResponse(
			request,
			{
				error: "Method not allowed",
				requestId,
			},
			405,
		);
	}

	const contentType = request.headers.get("Content-Type");

	if (!contentType?.includes("application/json")) {
		return jsonResponse(
			request,
			{
				error: "Content-Type must be application/json",
				requestId,
			},
			415,
		);
	}

	try {
		const body = (await request.json()) as ChatRequestBody;

		if (
			typeof body.message !== "string" ||
			body.message.trim().length === 0
		) {
			return jsonResponse(
				request,
				{
					error: "A non-empty message is required",
					requestId,
				},
				400,
			);
		}

		const message = body.message.trim();

		if (message.length > MAX_MESSAGE_LENGTH) {
			return jsonResponse(
				request,
				{
					error: `Message must not exceed ${MAX_MESSAGE_LENGTH} characters`,
					requestId,
				},
				413,
			);
		}

		console.log({
			event: "chat_request",
			requestId,
			messageLength: message.length,
		});

		const reply = await generateLucyReply(apiKey, message);

		console.log({
			event: "chat_response",
			requestId,
			replyLength: reply.length,
		});

		return jsonResponse(request, {
			reply,
			requestId,
		});
	} catch (error) {
		if (error instanceof SyntaxError) {
			return jsonResponse(
				request,
				{
					error: "Request body contains invalid JSON",
					requestId,
				},
				400,
			);
		}

		if (error instanceof OpenAI.APIError) {
			console.error({
				event: "openai_error",
				requestId,
				openaiRequestId: error.request_id,
				status: error.status,
				name: error.name,
				message: error.message,
			});

			return jsonResponse(
				request,
				{
					error: "Lucy is temporarily unavailable",
					requestId,
				},
				502,
			);
		}

		console.error({
			event: "unexpected_error",
			requestId,
			error:
				error instanceof Error
					? error.message
					: "Unknown error",
		});

		return jsonResponse(
			request,
			{
				error: "Lucy could not generate a response",
				requestId,
			},
			500,
		);
	}
}