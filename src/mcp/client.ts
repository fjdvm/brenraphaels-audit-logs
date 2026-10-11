export type ApiResult = { status: number; body: string };

export type ApiClient = {
  get(path: string, key: string, query?: Record<string, string | number | undefined>): Promise<ApiResult>;
  post(path: string, key: string, body: unknown): Promise<ApiResult>;
};

export const createApiClient = (baseUrl: string, fetchImpl: typeof fetch = fetch): ApiClient => {
  const send = async (url: URL, init: RequestInit): Promise<ApiResult> => {
    const response = await fetchImpl(url, init);
    return { status: response.status, body: await response.text() };
  };
  return {
    get: (path, key, query = {}) => {
      const url = new URL(path, baseUrl);
      for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value));
      return send(url, { headers: { authorization: `Bearer ${key}` } });
    },
    post: (path, key, body) => send(new URL(path, baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  };
};
