export const DEFAULT_ANIME_GIF_API_BASE_URL = "https://nekos.best/api/v2";

export const SUPPORTED_ANIME_GIF_ACTIONS = Object.freeze([
  "hug", "kiss", "pat", "cuddle", "punch", "slap", "poke",
  "wave", "highfive", "bite", "dance",
]);

function configuredBaseUrl() {
  const configured = process.env.ANIME_GIF_API_BASE_URL;
  if (!configured) return DEFAULT_ANIME_GIF_API_BASE_URL;
  try {
    if (new URL(configured).hostname.endsWith("gifukai.com")) {
      return DEFAULT_ANIME_GIF_API_BASE_URL;
    }
  } catch {
    return DEFAULT_ANIME_GIF_API_BASE_URL;
  }
  return configured;
}

function normalizeBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("The anime GIF source URL is invalid.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("The anime GIF source must be a clean HTTPS base URL.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed;
}

export function buildAnimeGifApiUrl(action, baseUrl = configuredBaseUrl()) {
  if (!SUPPORTED_ANIME_GIF_ACTIONS.includes(action)) {
    throw new Error("Unsupported anime GIF action.");
  }
  const base = normalizeBaseUrl(baseUrl);
  return new URL(base.pathname + "/" + action, base.origin).toString();
}

function getAllowedMediaHosts(apiHost, override) {
  if (override) {
    const hosts = override
      .split(",")
      .map((host) => host.trim().toLowerCase().replace(/^\.+|\.+$/g, ""))
      .filter(Boolean);
    if (!hosts.length || hosts.some((host) => !/^[a-z0-9.-]+$/.test(host))) {
      throw new Error("ANIME_GIF_MEDIA_HOSTS must be a comma-separated list of hostnames.");
    }
    return hosts;
  }
  const hosts = [apiHost];
  if (apiHost.startsWith("api.")) hosts.push(apiHost.slice(4));
  return hosts;
}

function isAllowedMediaHost(hostname, allowedHosts) {
  const normalizedHost = hostname.toLowerCase();
  return allowedHosts.some(
    (host) => normalizedHost === host || normalizedHost.endsWith("." + host),
  );
}

export async function fetchAnimeGif(
  action,
  {
    baseUrl = configuredBaseUrl(),
    allowedMediaHosts = process.env.ANIME_GIF_MEDIA_HOSTS,
    fetchImpl = fetch,
  } = {},
) {
  const apiBase = normalizeBaseUrl(baseUrl);
  const endpoint = buildAnimeGifApiUrl(action, apiBase.toString());
  const mediaHosts = getAllowedMediaHosts(
    apiBase.hostname,
    apiBase.hostname === "nekos.best" ? undefined : allowedMediaHosts,
  );

  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: {
        Accept: "application/json",
        "User-Agent": "SukunaDiscordBot (https://github.com/ruhxsh/Sukuna-Discord-Bot)",
      },
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    const failure = new Error(
      error?.name === "TimeoutError"
        ? "The anime GIF source timed out."
        : "The anime GIF source could not be reached.",
    );
    failure.code = error?.name === "TimeoutError" ? "GIF_SOURCE_TIMEOUT" : "GIF_SOURCE_NETWORK";
    throw failure;
  }

  if (!response.ok) {
    const failure = new Error("The anime GIF source returned HTTP " + response.status + ".");
    failure.code = "GIF_SOURCE_HTTP";
    throw failure;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    const failure = new Error("The anime GIF source returned invalid JSON.");
    failure.code = "GIF_SOURCE_INVALID_JSON";
    throw failure;
  }

  const isNekosResponse = Array.isArray(payload?.results);
  const result = isNekosResponse ? payload.results[0] : payload;
  if (
    !result ||
    typeof result.url !== "string" ||
    (!isNekosResponse &&
      (result.action !== action || typeof result.content_type !== "string"))
  ) {
    const failure = new Error("The anime GIF source returned incomplete image data.");
    failure.code = "GIF_SOURCE_INVALID_RESULT";
    throw failure;
  }

  let imageUrl;
  try {
    imageUrl = new URL(result.url);
  } catch {
    const failure = new Error("The anime GIF source returned an invalid image URL.");
    failure.code = "GIF_SOURCE_INVALID_URL";
    throw failure;
  }

  const contentType = isNekosResponse ? "image/gif" : result.content_type;
  if (
    imageUrl.protocol !== "https:" ||
    !isAllowedMediaHost(imageUrl.hostname, mediaHosts) ||
    !/^image\/(gif|png|jpe?g|webp)$/i.test(contentType) ||
    (isNekosResponse && !imageUrl.pathname.toLowerCase().endsWith(".gif"))
  ) {
    const failure = new Error("The anime GIF source returned an unsupported image.");
    failure.code = "GIF_SOURCE_UNSUPPORTED_IMAGE";
    throw failure;
  }

  // Nekos.best returns a direct GIF URL. Skip a second request to reduce latency.
  if (!isNekosResponse) {
    let imageResponse;
    try {
      imageResponse = await fetchImpl(imageUrl.toString(), {
        method: "HEAD",
        headers: {
          "User-Agent": "SukunaDiscordBot (https://github.com/ruhxsh/Sukuna-Discord-Bot)",
        },
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      const failure = new Error(
        error?.name === "TimeoutError"
          ? "The anime GIF image timed out."
          : "The anime GIF image could not be reached.",
      );
      failure.code = error?.name === "TimeoutError" ? "GIF_IMAGE_TIMEOUT" : "GIF_IMAGE_NETWORK";
      throw failure;
    }
    const imageContentType =
      imageResponse.headers.get("content-type") || result.content_type;
    if (
      !imageResponse.ok ||
      !/^image\/(gif|png|jpe?g|webp)$/i.test(imageContentType)
    ) {
      const failure = new Error("The anime GIF image is not currently available.");
      failure.code = "GIF_IMAGE_UNAVAILABLE";
      throw failure;
    }
  }

  const animeName = result.anime_name ?? result.anime;
  return {
    action,
    url: imageUrl.toString(),
    anime: typeof animeName === "string" ? animeName.slice(0, 120) : "",
  };
}
