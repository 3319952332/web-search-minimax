import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { WebError } from "@deepseek-ai/dsh-web";
/**
 * MiniMax coding-plan search provider for the `ctx.web` seam.
 *
 * Calls the DIRECT search API (`POST {baseURL}/v1/coding_plan/search`, the same
 * endpoint the official `minimax-coding-plan-mcp` server's `web_search` tool
 * uses) instead of routing the query through a model-mediated Messages request.
 * The caller decides the query; the API deterministically returns organic
 * results. No model turn, no "will it feel like searching" compliance problem,
 * ~1s latency.
 *
 * @module dsh-web-search-minimax
 */
/** Stable id this provider registers under (the `web` row's searchProvider). */
const PROVIDER_ID = "minimax-coding-plan";
/** Default API host. */
const DEFAULT_BASE_URL = "https://api.minimaxi.com";
/** Default credential holding the MiniMax coding-plan key (`sk-cp-...`). */
const DEFAULT_API_KEY_ENV = "MINIMAX_CN_API_KEY";
/** Environment variable overriding the endpoint. */
const SEARCH_BASE_URL_ENV = "MINIMAX_SEARCH_BASE_URL";
/** Attribution header sent on every request. */
const USER_AGENT = "dsh-web-search-minimax/1.0.0";
/**
 * Map a coding-plan search response to the seam's normalized result.
 * @param payload - the parsed response body.
 * @returns the normalized result with deduped sources.
 * @throws {WebError} `WEB_PROVIDER_ERROR` when the API reports a non-zero status.
 */
function mapSearchResponse(payload) {
	const status = payload?.base_resp?.status_code;
	if (status !== 0) throw new WebError(`MiniMax search failed: ${payload?.base_resp?.status_msg ?? "unknown error"}`, "WEB_PROVIDER_ERROR");
	const organic = Array.isArray(payload?.organic) ? payload.organic : [];
	const seen = /* @__PURE__ */ new Set();
	const sources = [];
	for (const item of organic) {
		const url = typeof item?.link === "string" ? item.link : "";
		if (url.length === 0 || seen.has(url)) continue;
		seen.add(url);
		sources.push({
			url,
			...item.title != null && item.title.length > 0 ? { title: item.title } : {},
			...item.snippet != null && item.snippet.length > 0 ? { snippet: item.snippet } : {},
			...item.date != null && item.date.length > 0 ? { publishedAt: item.date } : {}
		});
	}
	return {
		sources,
		truncated: false
	};
}
/** The MiniMax-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
var MiniMaxSearchProvider = class {
	resolveOptions;
	id = PROVIDER_ID;
	/**
	* @param resolveOptions - the options for the NEXT operation, snapshotted
	* once at each operation's entry so one search never mixes two sections.
	*/
	constructor(resolveOptions) {
		this.resolveOptions = resolveOptions;
	}
	available() {
		const options = this.resolveOptions();
		return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== void 0) && URL.canParse(options.baseURL);
	}
	async search(request, signal) {
		const options = this.resolveOptions();
		const apiKey = await this.apiKey(options, signal);
		throwIfSearchAborted(signal);
		const base = options.baseURL.replace(/\/+$/u, "");
		const endpoint = `${base}/v1/coding_plan/search`;
		const body = { q: request.query };
		options.recordRequest?.({ endpoint, body });
		throwIfSearchAborted(signal);
		let response;
		try {
			response = await fetch(endpoint, {
				method: "POST",
				redirect: "error",
				headers: {
					"authorization": `Bearer ${apiKey}`,
					"content-type": "application/json",
					"accept": "application/json",
					"user-agent": USER_AGENT
				},
				body: JSON.stringify(body),
				...signal !== void 0 ? { signal } : {}
			});
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError(`MiniMax search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (!response.ok) {
			let message = `MiniMax API error (HTTP ${response.status})`;
			try {
				const parsed = await response.json();
				const detail = typeof parsed?.base_resp?.status_msg === "string" && parsed.base_resp.status_msg.length > 0 ? parsed.base_resp.status_msg : typeof parsed?.message === "string" ? parsed.message : void 0;
				if (detail !== void 0) message = detail;
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			}
			throw new WebError(message, "WEB_PROVIDER_ERROR");
		}
		try {
			return mapSearchResponse(await response.json());
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			if (error instanceof WebError) throw error;
			throw new WebError(`MiniMax returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
	}
	/**
	* Resolve one operation's credential without retaining it on the provider.
	* @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one section.
	* @param signal - abort signal for the surrounding search.
	* @returns the resolved key.
	*/
	async apiKey(options, signal) {
		throwIfSearchAborted(signal);
		if (options.apiKey !== void 0 && options.apiKey.length > 0) return options.apiKey;
		let resolved;
		try {
			resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(void 0), signal);
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError(`MiniMax search credential resolution failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (resolved !== void 0 && resolved.length > 0) return resolved;
		throw new WebError(`MiniMax search has no API key for "${options.apiKeyEnv ?? DEFAULT_API_KEY_ENV}"; store it through the credentials service, export it in the launching environment, or set a literal "apiKey" in the web-search-minimax config`, "WEB_PROVIDER_CREDENTIAL_MISSING");
	}
};
/**
 * Race a same-process asynchronous preflight against caller cancellation. The
 * attached settlement handlers keep observing an uncooperative operation after
 * abort so a later rejection cannot become unhandled.
 */
function abortable(operation, signal) {
	if (signal === void 0) return operation;
	if (signal.aborted) return Promise.reject(searchAborted(signal));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(searchAborted(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", onAbort);
			reject(new Error(String(error).replace(/^Error: /u, ""), { cause: error }));
		});
	});
}
/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal) {
	if (signal?.aborted === true) throw searchAborted(signal);
}
/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal, fallback) {
	return new WebError("MiniMax search aborted", "WEB_ABORTED", { cause: signal?.aborted === true ? signal.reason : fallback });
}
/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}
/** Cordis plugin name used by loader diagnostics. */
const name = "web-search-minimax";
/** Services required by this plugin. */
const inject = ["web"];
const Config = z.object({
	apiKey: z.string().role("secret"),
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
	baseURL: z.string()
});
/** Settings namespace carrying this provider's endpoint and key reference. */
const SETTINGS_NAMESPACE = settingsNamespace("web-search-minimax");
/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 */
function resolveOptions(ctx, config) {
	const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV);
	const literalApiKey = config.apiKey !== void 0 && config.apiKey.length > 0 ? config.apiKey : void 0;
	return {
		...literalApiKey === void 0 ? {} : { apiKey: literalApiKey },
		resolveApiKey: async () => {
			const credentials = ctx.get("credentials");
			if (credentials !== void 0) return (await credentials.resolve(apiKeyEnv))?.value;
			const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv);
			return ambient !== void 0 && ambient.value.length > 0 ? ambient.value : void 0;
		},
		apiKeyEnv,
		baseURL: config.baseURL ?? launchEnvironmentOf(ctx).get(SEARCH_BASE_URL_ENV)?.value ?? DEFAULT_BASE_URL,
		recordRequest: () => {
			// Intentionally does not append a session event: `web/minimax-search-request`
			// is not in the runtime's known session-event catalog, and an unknown
			// non-ignorable event makes the whole session log refuse to reload.
			// The search is already fully recorded by the standard tool/call and
			// tool/result events.
		}
	};
}
/** Register the MiniMax search provider with `ctx.web`. */
function apply(ctx, config) {
	let current = () => config;
	installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: () => {}
	});
	ctx.web.registerSearchProvider(new MiniMaxSearchProvider(() => resolveOptions(ctx, current())));
}
export { Config, DEFAULT_API_KEY_ENV, DEFAULT_BASE_URL, MiniMaxSearchProvider, PROVIDER_ID, SEARCH_BASE_URL_ENV, SETTINGS_NAMESPACE, apply, inject, name };
