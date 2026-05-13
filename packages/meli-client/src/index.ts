export class RetryableError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = "RetryableError";
  }
}

export class MeliApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly responseBody: string,
    public readonly path: string
  ) {
    super(`Mercado Libre API ${statusCode} for ${path}: ${responseBody}`);
    this.name = "MeliApiError";
  }
}

export interface TokenProvider {
  getValidAccessToken(shopId: string): Promise<string>;
  refreshTokenWithLock(shopId: string): Promise<string>;
  logApiCall?(input: {
    shopId: string;
    method: string;
    path: string;
    statusCode?: number;
    latencyMs: number;
    error?: string;
  }): Promise<void>;
}

export interface MeliClientOptions {
  shopId: string;
  tokenProvider: TokenProvider;
  baseUrl?: string;
}

export class MeliClient {
  private readonly baseUrl: string;

  constructor(private readonly options: MeliClientOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.mercadolibre.com";
  }

  async get<T>(path: string, options?: { query?: Record<string, string | number | boolean | undefined> }): Promise<T> {
    return this.request<T>("GET", path, undefined, options?.query);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
    didRefresh = false
  ): Promise<T> {
    const token = await this.options.tokenProvider.getValidAccessToken(this.options.shopId);
    const url = new URL(`${this.baseUrl}${path}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const startedAt = Date.now();
    let statusCode: number | undefined;
    let errorText = "";

    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      statusCode = response.status;

      if (response.status === 401 && !didRefresh) {
        await this.options.tokenProvider.refreshTokenWithLock(this.options.shopId);
        return this.request<T>(method, path, body, query, true);
      }

      if (response.status === 429) {
        throw new RetryableError("MELI_RATE_LIMIT", response.status);
      }

      if (response.status >= 500) {
        throw new RetryableError(`MELI_SERVER_ERROR_${response.status}`, response.status);
      }

      if (!response.ok) {
        const text = await response.text();
        throw new MeliApiError(response.status, text, path);
      }

      return response.json() as Promise<T>;
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await this.options.tokenProvider.logApiCall?.({
        shopId: this.options.shopId,
        method,
        path,
        statusCode,
        latencyMs: Date.now() - startedAt,
        error: errorText || undefined
      });
    }
  }
}
