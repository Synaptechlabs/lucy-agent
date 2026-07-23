// POST /chat handler: validates the request, calls the OpenAI-backed reply
// generator, and maps both expected and unexpected failures to safe HTTP responses.
import OpenAI from 'openai';

import { generateLucyReply } from '../services/openai';
import type { ChatRequestBody, LucyReply } from '../types';
import { jsonResponse } from '../utils/response';

const MAX_MESSAGE_LENGTH = 4_000;
const MAX_RESPONSE_ID_LENGTH = 200;

// Injected so tests can substitute a fake generator without hitting the OpenAI API.
type ReplyGenerator = (apiKey: string, message: string, previousResponseId?: string) => Promise<LucyReply>;

// Returns undefined when the client omitted the field (fresh conversation),
// null when the value is present but malformed (caller should reject the request),
// or the validated ID otherwise. OpenAI response IDs are always prefixed "resp_".
function parsePreviousResponseId(value: unknown): string | undefined | null {
	if (value === undefined) {
		return undefined;
	}

	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RESPONSE_ID_LENGTH || !value.startsWith('resp_')) {
		return null;
	}

	return value;
}

export async function handleChatRequest(
	request: Request,
	apiKey: string,
	generateReply: ReplyGenerator = generateLucyReply,
): Promise<Response> {
	const requestId = crypto.randomUUID();

	if (request.method !== 'POST') {
		return jsonResponse(
			{
				error: 'Method not allowed',
				requestId,
			},
			request,
			405,
		);
	}

	const contentType = request.headers.get('Content-Type');

	if (!contentType?.includes('application/json')) {
		return jsonResponse(
			{
				error: 'Content-Type must be application/json',
				requestId,
			},
			request,
			415,
		);
	}

	try {
		const body = (await request.json()) as ChatRequestBody;

		if (typeof body.message !== 'string' || body.message.trim().length === 0) {
			return jsonResponse(
				{
					error: 'A non-empty message is required',
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

		// The client returns the last response ID to continue a conversation.
		// An omitted ID intentionally starts a fresh conversation.
		const previousResponseId = parsePreviousResponseId(body.previousResponseId);

		if (previousResponseId === null) {
			return jsonResponse(
				{
					error: 'previousResponseId is invalid',
					requestId,
				},
				request,
				400,
			);
		}

		console.log({
			event: 'chat_request',
			requestId,
			messageLength: message.length,
			isConversationContinuation: previousResponseId !== undefined,
		});

		const reply = await generateReply(apiKey, message, previousResponseId);

		console.log({
			event: 'chat_response',
			requestId,
			replyLength: reply.text.length,
		});

		return jsonResponse(
			{
				reply: reply.text,
				// Send this value back as previousResponseId on the next turn.
				responseId: reply.responseId,
				requestId,
			},
			request,
		);
	} catch (error) {
		if (error instanceof SyntaxError) {
			return jsonResponse(
				{
					error: 'Request body contains invalid JSON',
					requestId,
				},
				request,
				400,
			);
		}

		if (error instanceof OpenAI.APIError) {
			console.error({
				event: 'openai_error',
				requestId,
				openaiRequestId: error.requestID,
				status: error.status,
				name: error.name,
				message: error.message,
			});

			return jsonResponse(
				{
					error: 'Lucy is temporarily unavailable',
					requestId,
				},
				request,
				502,
			);
		}

		console.error({
			event: 'unexpected_error',
			requestId,
			error: error instanceof Error ? error.message : 'Unknown error',
		});

		return jsonResponse(
			{
				error: 'Lucy could not generate a response',
				requestId,
			},
			request,
			500,
		);
	}
}
