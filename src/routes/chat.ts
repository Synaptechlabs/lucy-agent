import OpenAI from "openai";

import { generateLucyReply } from "../services/openai";
import type { ChatRequestBody } from "../types";
import { jsonResponse } from "../utils/response";

const MAX_MESSAGE_LENGTH = 4_000;

type ReplyGenerator = (
	apiKey: string,
	message: string,
) => Promise<string>;

export async function handleChatRequest(
	request: Request,
	apiKey: string,
	generateReply: ReplyGenerator = generateLucyReply,
): Promise<Response> {
	const requestId = crypto.randomUUID();

	if (request.method !== "POST") {
		return jsonResponse(
			{
				error: "Method not allowed",
				requestId,
			},
			request,
			405,
		);
	}

	const contentType = request.headers.get("Content-Type");

	if (!contentType?.includes("application/json")) {
		return jsonResponse(
			{
				error: "Content-Type must be application/json",
				requestId,
			},
			request,
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
				{
					error: "A non-empty message is required",
					requestId,
				},
				request,
				400,
			);
		}

		const message = body.message.trim();

		if (message.length > MAX_MESSAGE_LENGTH) {
			return jsonResponse(
				{
					error: `Message must not exceed ${MAX_MESSAGE_LENGTH} characters`,
					requestId,
				},
				request,
				413,
			);
		}

		console.log({
			event: "chat_request",
			requestId,
			messageLength: message.length,
		});

		const reply = await generateReply(apiKey, message);

		console.log({
			event: "chat_response",
			requestId,
			replyLength: reply.length,
		});

		return jsonResponse(
			{
				reply,
				requestId,
			},
			request,
		);
	} catch (error) {
		if (error instanceof SyntaxError) {
			return jsonResponse(
				{
					error: "Request body contains invalid JSON",
					requestId,
				},
				request,
				400,
			);
		}

		if (error instanceof OpenAI.APIError) {
			console.error({
				event: "openai_error",
				requestId,
				openaiRequestId: error.requestID,
				status: error.status,
				name: error.name,
				message: error.message,
			});

			return jsonResponse(
				{
					error: "Lucy is temporarily unavailable",
					requestId,
				},
				request,
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
			{
				error: "Lucy could not generate a response",
				requestId,
			},
			request,
			500,
		);
	}
}