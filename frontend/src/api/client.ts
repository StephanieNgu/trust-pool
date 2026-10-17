export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ApiRequestOptions extends RequestInit {
  timeoutMs?: number;
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { timeoutMs = 10_000, headers, ...requestOptions } = options;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(path, {
      ...requestOptions,
      headers: {
        Accept: "application/json",
        ...headers,
      },
      signal: options.signal ?? controller.signal,
    });

    const body = (await response.json().catch(() => null)) as { error?: string } | T | null;
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body && body.error
        ? body.error
        : `Request failed with status ${response.status}.`;
      throw new ApiError(message, response.status);
    }
    if (body === null) throw new ApiError("The backend returned an empty response.", response.status);
    return body as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError("The backend request timed out.", 0);
    }
    throw new ApiError("Could not reach the TrustPool backend. Start it with npm run dev:backend.", 0);
  } finally {
    window.clearTimeout(timer);
  }
}
