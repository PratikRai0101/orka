import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HandoffError } from "./core.js";

export const DEFAULT_API = "https://api.tryorka.ai";

const local = (url) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

export function apiOrigin(value = DEFAULT_API) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !local(url))
    throw new HandoffError("The Orka service address must use HTTPS.");
  return url.origin;
}

function credentialPath(env = process.env) {
  return join(
    env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "orka-handoff",
    "credentials.json",
  );
}

function credentials() {
  try {
    return JSON.parse(readFileSync(credentialPath(), "utf8"));
  } catch {
    return {};
  }
}

export function saveToken(origin, credential) {
  const path = credentialPath();
  const all = credentials();
  if (credential) all[origin] = credential;
  else delete all[origin];
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const draft = `${path}.${process.pid}`;
  writeFileSync(draft, JSON.stringify(all), { mode: 0o600 });
  chmodSync(draft, 0o600);
  renameSync(draft, path);
}

export function savedToken(origin) {
  const saved = credentials()[origin];
  return saved?.token && Date.parse(saved.expiresAt) > Date.now()
    ? saved.token
    : undefined;
}

export async function call(
  origin,
  path,
  { body, token, fetch: send = fetch } = {},
) {
  let response;
  try {
    response = await send(origin + path, {
      method: body ? "POST" : "GET",
      redirect: "error",
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw Object.assign(
      new HandoffError(
        "Couldn’t reach Orka. Check your connection and try again.",
      ),
      { retry: true },
    );
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(
      new HandoffError(
        String(result.error ?? `Orka returned ${response.status}.`),
      ),
      {
        status: response.status,
        retry: response.status >= 500,
      },
    );
  return result;
}

export async function requireHandoffs(origin, options) {
  const instance = await call(origin, "/v2/instance", options);
  if (instance.handoffs !== 1)
    throw new HandoffError("This Orka service doesn’t support handoffs yet.");
}

/** Shows a short code to approve in any browser, so it works over SSH too. */
export async function signIn(origin, show, options = {}) {
  const request = await call(origin, "/v2/handoffs/device", {
    ...options,
    body: {},
  });
  const url = new URL(request.verifyUrl);
  if (url.protocol !== "https:" && !local(url))
    throw new HandoffError("Orka returned an invalid sign-in address.");
  show({ code: request.userCode, url: url.href });
  const deadline = Date.now() + request.expiresIn * 1000;
  while (Date.now() < deadline) {
    await (options.delay ?? delay)(request.interval * 1000);
    let result;
    try {
      result = await call(origin, "/v2/handoffs/device/token", {
        ...options,
        body: { deviceCode: request.deviceCode },
      });
    } catch (error) {
      if (error.retry) continue;
      throw error;
    }
    if (result.status !== "approved") continue;
    saveToken(origin, { token: result.token, expiresAt: result.expiresAt });
    return result.token;
  }
  throw new HandoffError("The sign-in code expired. Run the command again.");
}

/** Repeating one request ID never creates a second handoff. */
export async function upload(origin, bundle, token, options = {}) {
  for (let tries = 0; ; tries++) {
    try {
      return await call(origin, "/v2/handoffs", {
        ...options,
        body: bundle,
        token,
      });
    } catch (error) {
      if (!error.retry || tries >= 2) throw error;
      await (options.delay ?? delay)(1000 * (tries + 1));
    }
  }
}
