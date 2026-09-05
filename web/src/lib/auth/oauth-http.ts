import { NextResponse } from "next/server";

export const OAUTH_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function oauthJson(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: OAUTH_HEADERS });
}

export function oauthRedirect(url: string | URL) {
  return NextResponse.redirect(url, { status: 303, headers: OAUTH_HEADERS });
}

export async function readOAuthForm(request: Request, allowed: Set<string>) {
  const origin = request.headers.get("origin");
  if (
    origin !== new URL(request.url).origin ||
    request.headers.get("sec-fetch-site") === "cross-site" ||
    request.headers.get("content-type")?.split(";")[0].trim() !==
      "application/x-www-form-urlencoded"
  ) {
    return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16 * 1024) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const form = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    for (const name of form.keys()) {
      if (!allowed.has(name) || form.getAll(name).length !== 1) return null;
    }
    return form;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export function readExpectedGrantId(form: URLSearchParams): string | null | undefined {
  const value = form.get("expected_grant_id");
  if (value === "") return null;
  return value && UUID_PATTERN.test(value) ? value.toLowerCase() : undefined;
}
