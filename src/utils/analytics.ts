// Structured event logging to Cloudflare Workers Analytics Engine. Unlike
// console.log (only visible via a live `wrangler tail` session), these
// events are retained for 3 months and queryable after the fact via the
// Analytics Engine SQL API — see README.md for the query pattern. This is
// specifically for debugging "what happened to this request", not traffic
// analytics — there's no visitor/session tracking here.
export type ChatOutcome =
	| 'rate_limited'
	| 'origin_rejected'
	| 'invalid_content_type'
	| 'invalid_json'
	| 'empty_message'
	| 'message_too_long'
	| 'missing_turnstile_token'
	| 'turnstile_failed'
	| 'invalid_previous_response_id'
	| 'invalid_turn_count'
	| 'turn_limit_reached'
	| 'stream_started'
	| 'stream_completed'
	| 'stream_error';

// Never throws and never blocks the response — a broken analytics write
// should never be the reason a chat request fails.
export function logChatEvent(
	analytics: AnalyticsEngineDataset | undefined,
	request: Request,
	outcome: ChatOutcome,
	requestId: string,
): void {
	if (!analytics) {
		return;
	}

	try {
		const cf = request.cf as { country?: string; colo?: string } | undefined;

		analytics.writeDataPoint({
			indexes: [outcome],
			blobs: [outcome, requestId, cf?.country ?? 'unknown', cf?.colo ?? 'unknown'],
		});
	} catch (error) {
		console.error({
			event: 'analytics_write_error',
			error: error instanceof Error ? error.message : 'Unknown error',
		});
	}
}
