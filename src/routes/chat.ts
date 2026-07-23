// POST /chat handler: validates the request, calls the OpenAI-backed reply
// generator, and maps both expected and unexpected failures to safe HTTP responses.
import OpenAI from 'openai';

import { generateLucyReply } from '../services/openai';
import type { ChatRequestBody, LucyReply } from '../types';
import { jsonResponse } from '../utils/response';

const MAX_MESSAGE_LENGTH = 4_000;
const MAX_RESPONSE_ID_LENGTH = 200;
// Soft cap on conversation length. Enforced only when the client sends
// turnCount (see parseTurnCount below), since Lucy is stateless and has no
// server-side record of a conversation's history to check against otherwise.
const MAX_CONVERSATION_TURNS = 40;

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

// Same undefined/null/value contract as parsePreviousResponseId. A client
// that never sends turnCount gets no cap enforced — this only protects
// conversations from frontends that opt in by counting and sending it.
function parseTurnCount(value: unknown): number | undefined | null {
	if (value === undefined) {
		return undefined;
	}

	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
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

		const turnCount = parseTurnCount(body.turnCount);

		if (turnCount === null) {
			return jsonResponse(
				{
					error: 'turnCount is invalid',
					requestId,
				},
				request,
				400,
			);
		}

		if (turnCount !== undefined && turnCount >= MAX_CONVERSATION_TURNS) {
			return jsonResponse(
				{
					error: 'This conversation has reached its turn limit. Please start a new one.',
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
