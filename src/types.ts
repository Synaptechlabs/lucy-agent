// Raw shape of the POST /chat JSON body, before validation.
// Fields are typed `unknown` because they come straight from an untrusted client.
export interface ChatRequestBody {
	message?: unknown;
	previousResponseId?: unknown;
	// Optional, client-tracked turn number for the current conversation chain.
	// See MAX_CONVERSATION_TURNS in routes/chat.ts.
	turnCount?: unknown;
	// Cloudflare Turnstile token proving a real browser sent this request.
	turnstileToken?: unknown;
}

// Normalized result returned by the reply generator once OpenAI has responded.
export interface LucyReply {
	text: string;
	// Echoed back to the client as previousResponseId to continue the conversation.
	responseId: string;
}
