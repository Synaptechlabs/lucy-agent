// POST /chat handler: validates the request synchronously (so malformed
// requests get a normal JSON error response), then streams Lucy's reply as
// Server-Sent Events. See README.md for the exact SSE event shapes.
import OpenAI from 'openai';

import { streamLucyReply } from '../services/openai';
import type { LucyStreamEvent } from '../services/openai';
import type { ChatRequestBody } from '../types';
import { jsonResponse, streamResponse } from '../utils/response';
import { verifyTurnstileToken } from '../utils/turnstile';
import { logChatEvent } from '../utils/analytics';
import { makeToolExecutor } from '../services/tools';
import type { ResendConfig } from '../services/tools';

const MAX_MESSAGE_LENGTH = 4_000;
const MAX_RESPONSE_ID_LENGTH = 200;
// Soft cap on conversation length. Enforced only when the client sends
// turnCount (see parseTurnCount below), since Lucy is stateless and has no
// server-side record of a conversation's history to check against otherwise.
const MAX_CONVERSATION_TURNS = 40;

// Injected so tests can substitute a fake stream without hitting the OpenAI API.
type ReplyStreamer = (apiKey: string, message: string, previousResponseId?: string) => AsyncGenerator<LucyStreamEvent>;

// Injected so tests can substitute a fake verifier without hitting Cloudflare's siteverify API.
type TurnstileVerifier = (token: string, secretKey: string, remoteIp?: string) => Promise<boolean>;

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

function formatSseEvent(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

// Turns the reply stream into SSE bytes. Errors here happen after we've
// already committed to a 200 response, so they're reported as an in-stream
// {"type":"error"} event rather than an HTTP status — see streamResponse.
function buildSseStream(
	events: AsyncGenerator<LucyStreamEvent>,
	requestId: string,
	request: Request,
	analytics: AnalyticsEngineDataset | undefined,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const event of events) {
					controller.enqueue(encoder.encode(formatSseEvent({ ...event, requestId })));
				}
				logChatEvent(analytics, request, 'stream_completed', requestId);
			} catch (error) {
				logChatEvent(analytics, request, 'stream_error', requestId);

				if (error instanceof OpenAI.APIError) {
					console.error({
						event: 'openai_error',
						requestId,
						openaiRequestId: error.requestID,
						status: error.status,
						name: error.name,
						message: error.message,
					});

					controller.enqueue(encoder.encode(formatSseEvent({ type: 'error', message: 'Lucy is temporarily unavailable', requestId })));
				} else {
					console.error({
						event: 'unexpected_error',
						requestId,
						error: error instanceof Error ? error.message : 'Unknown error',
					});

					controller.enqueue(encoder.encode(formatSseEvent({ type: 'error', message: 'Lucy could not generate a response', requestId })));
				}
			} finally {
				controller.close();
			}
		},
	});
}

export async function handleChatRequest(
	request: Request,
	apiKey: string,
	turnstileSecretKey: string,
	resendConfig: ResendConfig | undefined = undefined,
	analytics: AnalyticsEngineDataset | undefined = undefined,
	// Defaulted here (rather than inside streamLucyReply) so resendConfig can
	// be closed over — the contact_scott tool needs it, nothing else does.
	streamReply: ReplyStreamer = (streamApiKey, message, previousResponseId) =>
		streamLucyReply(streamApiKey, message, previousResponseId, undefined, makeToolExecutor(resendConfig)),
	verifyToken: TurnstileVerifier = verifyTurnstileToken,
): Promise<Response> {
	const requestId = crypto.randomUUID();

	if (request.method !== 'POST') {
		return jsonResponse({ error: 'Method not allowed', requestId }, request, 405);
	}

	const contentType = request.headers.get('Content-Type');

	if (!contentType?.includes('application/json')) {
		logChatEvent(analytics, request, 'invalid_content_type', requestId);
		return jsonResponse({ error: 'Content-Type must be application/json', requestId }, request, 415);
	}

	let body: ChatRequestBody;

	try {
		body = (await request.json()) as ChatRequestBody;
	} catch {
		logChatEvent(analytics, request, 'invalid_json', requestId);
		return jsonResponse({ error: 'Request body contains invalid JSON', requestId }, request, 400);
	}

	if (typeof body.message !== 'string' || body.message.trim().length === 0) {
		logChatEvent(analytics, request, 'empty_message', requestId);
		return jsonResponse({ error: 'A non-empty message is required', requestId }, request, 400);
	}

	const message = body.message.trim();

	if (message.length > MAX_MESSAGE_LENGTH) {
		logChatEvent(analytics, request, 'message_too_long', requestId);
		return jsonResponse({ error: `Message must not exceed ${MAX_MESSAGE_LENGTH} characters`, requestId }, request, 413);
	}

	if (typeof body.turnstileToken !== 'string' || body.turnstileToken.length === 0) {
		logChatEvent(analytics, request, 'missing_turnstile_token', requestId);
		return jsonResponse({ error: 'turnstileToken is required', requestId }, request, 400);
	}

	const remoteIp = request.headers.get('CF-Connecting-IP') ?? undefined;
	const humanVerified = await verifyToken(body.turnstileToken, turnstileSecretKey, remoteIp);

	if (!humanVerified) {
		console.warn({ event: 'turnstile_verification_failed', requestId });
		logChatEvent(analytics, request, 'turnstile_failed', requestId);

		return jsonResponse({ error: 'Turnstile verification failed', requestId }, request, 403);
	}

	// The client returns the last response ID to continue a conversation.
	// An omitted ID intentionally starts a fresh conversation.
	const previousResponseId = parsePreviousResponseId(body.previousResponseId);

	if (previousResponseId === null) {
		logChatEvent(analytics, request, 'invalid_previous_response_id', requestId);
		return jsonResponse({ error: 'previousResponseId is invalid', requestId }, request, 400);
	}

	const turnCount = parseTurnCount(body.turnCount);

	if (turnCount === null) {
		logChatEvent(analytics, request, 'invalid_turn_count', requestId);
		return jsonResponse({ error: 'turnCount is invalid', requestId }, request, 400);
	}

	if (turnCount !== undefined && turnCount >= MAX_CONVERSATION_TURNS) {
		logChatEvent(analytics, request, 'turn_limit_reached', requestId);
		return jsonResponse({ error: 'This conversation has reached its turn limit. Please start a new one.', requestId }, request, 400);
	}

	console.log({
		event: 'chat_request',
		requestId,
		messageLength: message.length,
		isConversationContinuation: previousResponseId !== undefined,
	});
	logChatEvent(analytics, request, 'stream_started', requestId);

	const events = streamReply(apiKey, message, previousResponseId);

	return streamResponse(buildSseStream(events, requestId, request, analytics), request);
}
