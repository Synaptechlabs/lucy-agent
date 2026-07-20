import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Lucy Worker", () => {
	it("returns Lucy's health status", async () => {
		const response = await SELF.fetch("https://example.com/");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "ok",
			assistant: "Lucy",
			message: "Lucy is alive!",
		});
	});

	it("returns 404 for an unknown route", async () => {
		const response = await SELF.fetch(
			"https://example.com/unknown",
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: "Not found",
		});
	});

	it("rejects unsupported methods on the root route", async () => {
		const response = await SELF.fetch(
			"https://example.com/",
			{
				method: "POST",
			},
		);

		expect(response.status).toBe(405);
		expect(await response.json()).toEqual({
			error: "Method not allowed",
		});
	});

	it("accepts a preflight request from an allowed origin", async () => {
		const response = await SELF.fetch(
			"https://example.com/chat",
			{
				method: "OPTIONS",
				headers: {
					Origin: "http://localhost:5173",
					"Access-Control-Request-Method": "POST",
				},
			},
		);

		expect(response.status).toBe(204);
		expect(
			response.headers.get(
				"Access-Control-Allow-Origin",
			),
		).toBe("http://localhost:5173");
	});

	it("rejects a preflight request from an unknown origin", async () => {
		const response = await SELF.fetch(
			"https://example.com/chat",
			{
				method: "OPTIONS",
				headers: {
					Origin: "https://malicious.example",
					"Access-Control-Request-Method": "POST",
				},
			},
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Origin not allowed",
		});
	});

	it("rejects GET requests to the chat route", async () => {
		const response = await SELF.fetch(
			"https://example.com/chat",
		);

		expect(response.status).toBe(405);

		const body = (await response.json()) as {
			error: string;
			requestId: string;
		};

		expect(body.error).toBe("Method not allowed");
		expect(body.requestId).toBeTypeOf("string");
	});

	it("requires an application/json content type", async () => {
		const response = await SELF.fetch(
			"https://example.com/chat",
			{
				method: "POST",
				body: "hello",
			},
		);

		expect(response.status).toBe(415);

		const body = (await response.json()) as {
			error: string;
		};

		expect(body.error).toBe(
			"Content-Type must be application/json",
		);
	});

	it("rejects malformed JSON", async () => {
		const response = await SELF.fetch(
			"https://example.com/chat",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: '{"message":',
			},
		);

		expect(response.status).toBe(400);

		const body = (await response.json()) as {
			error: string;
		};

		expect(body.error).toBe(
			"Request body contains invalid JSON",
		);
	});

	it("rejects an empty message", async () => {
		const response = await SELF.fetch(
			"https://example.com/chat",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					message: "   ",
				}),
			},
		);

		expect(response.status).toBe(400);

		const body = (await response.json()) as {
			error: string;
		};

		expect(body.error).toBe(
			"A non-empty message is required",
		);
	});

	it("rejects messages longer than 4,000 characters", async () => {
		const response = await SELF.fetch(
			"https://example.com/chat",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					message: "a".repeat(4_001),
				}),
			},
		);

		expect(response.status).toBe(413);

		const body = (await response.json()) as {
			error: string;
		};

		expect(body.error).toBe(
			"Message must not exceed 4000 characters",
		);
	});
});